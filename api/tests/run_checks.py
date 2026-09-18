"""PS1 checks: sample regression + solver smoke + mutation tests.

Run:  python3 -m api.tests.run_checks  (from ps1-app/)
"""
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))) + "/..")

from api import exporter as E
from api import replanner as R
from api import solver as S
from api import validator as V
from api.model import load_instance

DATA = "/tmp/PS1-latest/01_data"
SAMPLE = "/tmp/PS1-latest/03_submission_sample"


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def load_sample():
    accesses, groups = {}, {}
    for r in read_csv(f"{SAMPLE}/SCHEDULE_ACCESS.csv"):
        accesses.setdefault(r["activity_id"], []).append(
            (int(r["week"]), int(r["access_night"]), int(r["eclo"])))
    for r in read_csv(f"{SAMPLE}/SCHEDULE_OCCUPANCY.csv"):
        groups[(r["activity_id"], int(r["week"]), r["location_id"])] = \
            r["co_share_group"]
    return accesses, groups


def main():
    fails = []

    def check(name, cond, extra=""):
        print(("PASS " if cond else "FAIL ") + name, extra)
        if not cond:
            fails.append(name)

    inst = load_instance(DATA)
    check("load-8-csvs", len(inst.activities) == 54 and
          len(inst.contracts) == 14)

    # --- sample regression -------------------------------------------
    s_acc, s_grp = load_sample()
    n_acc = sum(len(v) for v in s_acc.values())
    n_occ = len(read_csv(f"{SAMPLE}/SCHEDULE_OCCUPANCY.csv"))
    n_res = len(read_csv(f"{SAMPLE}/RESULTS.csv"))
    check("sample-counts-192-928-14",
          n_acc == 192 and n_occ == 928 and n_res == 14,
          f"({n_acc}/{n_occ}/{n_res})")
    viol = V.validate(inst, s_acc, s_grp, "A")
    check("sample-zero-violations", not viol,
          str([v["detail"] for v in viol][:3]))
    expect_over = {"C006": 14, "C010": 7, "C014": 7}
    ok = True
    for cnum, want in expect_over.items():
        _comp, over = E.contract_completion(inst, s_acc, cnum)
        ok &= (over == want)
    check("sample-overruns-14-7-7", ok)

    # --- solver smoke (Scenario A) ------------------------------------
    acc, grp = S.solve(inst, "A", time_budget=10.0)
    viol = V.validate(inst, acc, grp, "A")
    hard = [v for v in viol]
    rep = E.build_report(inst, acc, grp, "A", viol)
    wl = [v for v in hard if v["rule"] == "workload"]
    check("solverA-workload-complete", not wl,
          str([v["detail"] for v in wl][:2]))
    print("solverA violations:", len(hard),
          "| score:", rep["soft_scores"]["objective_score"],
          "| overrun:", rep["soft_scores"]["overrun_days_total"])
    for v in hard[:5]:
        print("   -", v["rule"], v["detail"][:110])

    # --- mutation tests (each must be caught) --------------------------
    mut = {k: [tuple(x) for x in v] for k, v in s_acc.items()}
    dropped = mut["A001"].pop(0)
    v = V.validate(inst, mut, s_grp, "A")
    check("mut-drop-access-caught",
          any(x["rule"] == "workload" for x in v))
    mut["A001"].append(dropped)

    mut2 = {k: [tuple(x) for x in v] for k, v in s_acc.items()}
    # A013 depends on A012: force A013 into A012's first week
    w12 = min(w for w, _, _ in mut2["A012"])
    mut2["A013"] = [(w12, n, e) for (w, n, e) in mut2["A013"]][:1] + \
        mut2["A013"][1:]
    v = V.validate(inst, mut2, s_grp, "A")
    check("mut-precedence-caught",
          any(x["rule"] == "precedence" for x in v))

    mut3 = {k: [tuple(x) for x in v] for k, v in s_acc.items()}
    mut3["A001"] = [(w, n, 1) for (w, n, _e) in mut3["A001"]]
    v = V.validate(inst, mut3, s_grp, "A")
    check("mut-eclo-in-A-caught", any(x["rule"] == "eclo" for x in v))

    # --- P6 deterministic disruption replan ---------------------------
    p = R.parse_disruption("block A001 in week 12")
    check("replan-parse-block", p.kind == "block_week" and
          p.activity_id == "A001" and p.week == 12)
    p = R.parse_disruption("delay A001 by 2 weeks")
    check("replan-parse-delay", p.kind == "delay" and p.delay_weeks == 2)
    try:
        R.parse_disruption("please optimise everything")
        rejected = False
    except ValueError:
        rejected = True
    check("replan-rejects-broad-nl", rejected)

    predecessors = {a.predecessor for a in inst.activities.values()
                    if a.predecessor}
    replan_result = None
    replan_acc = None
    for aid in sorted(inst.activities):
        if aid in predecessors or not acc.get(aid):
            continue
        if max(w for w, _n, _e in acc[aid]) >= inst.horizon_weeks:
            continue
        result, candidate, _candidate_groups = R.replan(
            inst, "A", acc, grp, f"delay {aid} by 1 week")
        if result["validator_gate"]["passed"] and result["changes"]:
            replan_result, replan_acc = result, candidate
            break
    check("replan-found-feasible-leaf", replan_result is not None)
    if replan_result is not None:
        target = replan_result["disruption"]["activity_id"]
        unchanged = all(
            replan_acc[aid] == acc[aid]
            for aid in inst.activities if aid != target)
        check("replan-locks-unaffected", unchanged)
        check("replan-validator-gated",
              replan_result["status"] == "feasible" and
              not replan_result["validator_gate"]["hard_violations"])
        check("replan-explains-validator-authority",
              "validator" in replan_result["explanation"].lower())
    blocked_result, _blocked_acc, _blocked_groups = R.replan(
        inst, "A", acc, grp, "delay A001 by 30 weeks")
    check("replan-impossible-stays-gated",
          blocked_result["status"] == "infeasible_under_locks" and
          not blocked_result["validator_gate"]["passed"] and
          bool(blocked_result["validator_gate"]["hard_violations"]))

    # === pipeline.validate_csv_bundle TDD (RED) ===========================
    # api.pipeline does not exist yet — import must raise ModuleNotFoundError.
    try:
        from api.pipeline import validate_csv_bundle
        pipeline_imported = True
    except (ImportError, ModuleNotFoundError):
        pipeline_imported = False

    if pipeline_imported:
        CANONICAL_FILES = [
            "01_LINES.csv", "02_STATIONS.csv", "03_SECTORS.csv",
            "04_LOCATION_SUPPLY.csv", "05_BUFFER_LOCATION.csv",
            "06_PARAMETERS.csv", "07_PROJECT_DETAILS.csv",
            "08_ACTIVITY_DETAILS.csv",
        ]
        BUNDLE_DIR = DATA

        def _build_bundle():
            bundle = {}
            for fname in CANONICAL_FILES:
                path = os.path.join(BUNDLE_DIR, fname)
                with open(path, encoding="utf-8-sig") as f:
                    bundle[fname] = f.read()
            return bundle

        def _mutated_csv(bundle, fname, mutate_fn):
            """Return a new bundle with one CSV content mutated."""
            b = dict(bundle)
            b[fname] = mutate_fn(b[fname])
            return b

        def _error_codes(result):
            return [e["code"] for e in result["errors"]]

        bundle = _build_bundle()

        # --- valid bundle passes ------------------------------------------
        r = validate_csv_bundle(bundle)
        check("pipe-valid-bundle-passes", r["passed"],
              str(r["errors"][:3]))

        # --- evidence_id stable for identical input ----------------------
        r2 = validate_csv_bundle(bundle)
        check("pipe-evidence-id-stable",
              r["evidence_id"] == r2["evidence_id"],
              f"{r['evidence_id']} != {r2['evidence_id']}")

        # --- evidence_id changes for mutated input -----------------------
        mut_del_file = dict(bundle)
        del mut_del_file["05_BUFFER_LOCATION.csv"]
        r3 = validate_csv_bundle(mut_del_file)
        check("pipe-evidence-id-mutated",
              r["evidence_id"] != r3["evidence_id"],
              "same evidence after file deletion")

        # --- each mutation is independent --------------------------------
        # Missing required file
        for fname in CANONICAL_FILES:
            b = dict(bundle)
            del b[fname]
            res = validate_csv_bundle(b)
            check(f"pipe-missing-file-{fname}",
                  not res["passed"] and "missing_required_file" in _error_codes(res),
                  str(_error_codes(res)))

        # Missing required column (08_ACTIVITY_DETAILS missing activity_id)
        def _drop_col_08(csv_text):
            lines = csv_text.strip().splitlines()
            header = lines[0].split(",")
            header.remove("activity_id")
            return ",".join(header) + "\n" + "\n".join(lines[1:])
        b = _mutated_csv(bundle, "08_ACTIVITY_DETAILS.csv", _drop_col_08)
        res = validate_csv_bundle(b)
        check("pipe-missing-column-activity_id",
              not res["passed"] and "missing_required_column" in _error_codes(res),
              str(_error_codes(res)))

        # Invalid activity_type (08 row 1: change "Renewal" to "Bogus")
        def _bad_activity_type(csv_text):
            return csv_text.replace(",Renewal,", ",Bogus,", 1)
        b = _mutated_csv(bundle, "08_ACTIVITY_DETAILS.csv", _bad_activity_type)
        res = validate_csv_bundle(b)
        check("pipe-invalid-activity_type",
              not res["passed"] and "invalid_activity_type" in _error_codes(res),
              str(_error_codes(res)))

        # Invalid integer (08 total_accesses = "abc")
        def _bad_int_08(csv_text):
            lines = csv_text.strip().splitlines()
            header = lines[0].split(",")
            idx = header.index("total_accesses")
            row = lines[1].split(",")
            row[idx] = "abc"
            return ",".join(header) + "\n" + ",".join(row) + "\n" + \
                "\n".join(lines[2:])
        b = _mutated_csv(bundle, "08_ACTIVITY_DETAILS.csv", _bad_int_08)
        res = validate_csv_bundle(b)
        check("pipe-invalid-integer",
              not res["passed"] and "invalid_integer" in _error_codes(res),
              str(_error_codes(res)))

        # Malformed date (08 planned_start_date = "not-a-date")
        def _bad_date_08(csv_text):
            lines = csv_text.strip().splitlines()
            header = lines[0].split(",")
            idx = header.index("planned_start_date")
            row = lines[1].split(",")
            row[idx] = "not-a-date"
            return ",".join(header) + "\n" + ",".join(row) + "\n" + \
                "\n".join(lines[2:])
        b = _mutated_csv(bundle, "08_ACTIVITY_DETAILS.csv", _bad_date_08)
        res = validate_csv_bundle(b)
        check("pipe-malformed-date",
              not res["passed"] and "malformed_date" in _error_codes(res),
              str(_error_codes(res)))

        # Unknown contract foreign key (08 contract_number = "C999")
        def _bad_fk_08(csv_text):
            return csv_text.replace(",C001,", ",C999,", 1)
        b = _mutated_csv(bundle, "08_ACTIVITY_DETAILS.csv", _bad_fk_08)
        res = validate_csv_bundle(b)
        check("pipe-unknown-contract_fk",
              not res["passed"] and "unknown_contract_fk" in _error_codes(res),
              str(_error_codes(res)))

        # Predecessor cycle (A003 -> A004 -> A003)
        def _pred_cycle(csv_text):
            lines = csv_text.strip().splitlines()
            header = lines[0].split(",")
            pred_idx = header.index("predecessor_activity_id")
            aid_idx = header.index("activity_id")
            out = [lines[0]]
            for line in lines[1:]:
                row = line.split(",")
                if row[aid_idx] == "A003":
                    row[pred_idx] = "A004"
                out.append(",".join(row))
            return "\n".join(out) + "\n"
        b = _mutated_csv(bundle, "08_ACTIVITY_DETAILS.csv", _pred_cycle)
        res = validate_csv_bundle(b)
        check("pipe-predecessor-cycle",
              not res["passed"] and "predecessor_cycle" in _error_codes(res),
              str(_error_codes(res)))

        # Duplicate activity_id
        def _dup_aid(csv_text):
            lines = csv_text.strip().splitlines()
            return lines[0] + "\n" + lines[1] + "\n" + lines[1] + "\n" + \
                "\n".join(lines[2:])
        b = _mutated_csv(bundle, "08_ACTIVITY_DETAILS.csv", _dup_aid)
        res = validate_csv_bundle(b)
        check("pipe-duplicate-activity_id",
              not res["passed"] and "duplicate_activity_id" in _error_codes(res),
              str(_error_codes(res)))
    else:
        check("pipe-import-fails-as-expected", False,
              "(api.pipeline not yet implemented — RED phase)")

    from api.tests.pipeline_checks import run as run_pipeline_checks
    run_pipeline_checks(check)

    from api.tests.boundary_checks import run as run_boundary_checks
    run_boundary_checks(check)

    print("FAILURES:", fails if fails else "none")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
