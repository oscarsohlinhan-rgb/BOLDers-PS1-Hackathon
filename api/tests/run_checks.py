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

    print("FAILURES:", fails if fails else "none")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
