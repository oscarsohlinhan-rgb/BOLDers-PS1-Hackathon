"""Boundary mutations for the deterministic scheduling rules."""
from __future__ import annotations

import copy
import csv
import io
import os
from datetime import date

from api import solver as S
from api import validator as V
from api.model import Activity, load_instance
from api.pipeline import run_solve_pipeline, validate_csv_bundle


DATA = "/tmp/PS1-latest/01_data"
FILES = [
    "01_LINES.csv", "02_STATIONS.csv", "03_SECTORS.csv",
    "04_LOCATION_SUPPLY.csv", "05_BUFFER_LOCATION.csv",
    "06_PARAMETERS.csv", "07_PROJECT_DETAILS.csv",
    "08_ACTIVITY_DETAILS.csv",
]


def _bundle():
    with_contents = {}
    for name in FILES:
        with open(os.path.join(DATA, name), encoding="utf-8-sig") as handle:
            with_contents[name] = handle.read()
    return with_contents


def _set_total(bundle, aid, total):
    rows = list(csv.DictReader(io.StringIO(bundle["08_ACTIVITY_DETAILS.csv"])))
    for row in rows:
        if row["activity_id"] == aid:
            row["total_accesses"] = str(total)
            break
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    changed = dict(bundle)
    changed["08_ACTIVITY_DETAILS.csv"] = output.getvalue()
    return changed


def _only_activity(bundle, aid, total):
    rows = list(csv.DictReader(io.StringIO(bundle["08_ACTIVITY_DETAILS.csv"])))
    rows = [row for row in rows if row["activity_id"] == aid]
    rows[0]["total_accesses"] = str(total)
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    changed = dict(bundle)
    changed["08_ACTIVITY_DETAILS.csv"] = output.getvalue()
    return changed


def _set_first_value(bundle, filename, field, value):
    rows = list(csv.DictReader(io.StringIO(bundle[filename])))
    rows[0][field] = str(value)
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    changed = dict(bundle)
    changed[filename] = output.getvalue()
    return changed


def _csv_access_count(result, aid):
    rows = csv.DictReader(io.StringIO(result["files"]["SCHEDULE_ACCESS.csv"]))
    return sum(row["activity_id"] == aid for row in rows)


def _instance_with(base, activities):
    inst = copy.deepcopy(base)
    inst.activities = {activity.aid: activity for activity in activities}
    return inst


def _activity(aid, contract="C001", location="SEC:ALP:S01_S02:EB"):
    return Activity(
        aid=aid,
        contract=contract,
        atype="Construction" if contract in {"C003", "C006"} else "Renewal",
        start_loc=location,
        end_loc=location,
        total=1,
        planned_start=date(2027, 1, 4),
        predecessor=None,
        priority=1,
    )


def _groups(inst, accesses, label_for=None):
    groups = {}
    for aid, slots in accesses.items():
        for week, _night, _eclo in slots:
            label = label_for(aid, week) if label_for else "g-%s" % aid
            for location in inst.expand(inst.activities[aid]):
                groups[(aid, week, location)] = label
    return groups


def _rules(violations):
    return [violation["rule"] for violation in violations]


def run(check):
    base_bundle = _bundle()
    base = load_instance(DATA)

    # A stated job duration is the complete occupation time. Exact equality is
    # feasible; neither solver nor independent validator may add generic setup,
    # paperwork, safety or planning padding, or shrink the stated slot.
    check("boundary-duration-solver-120-equals-120",
          S.duration_fits_slot(120, 120),
          "solver rejected an exact 120-minute allocation")
    check("boundary-duration-solver-four-hours-equals-four-hours",
          S.duration_fits_slot(240, 240),
          "solver rejected an exact four-hour allocation")
    check("boundary-duration-solver-one-minute-over-rejected",
          not S.duration_fits_slot(121, 120),
          "solver accepted a duration longer than its slot")
    check("boundary-duration-validator-120-equals-120",
          not V.validate_duration_allocation(120, 120),
          "validator rejected an exact 120-minute allocation")
    check("boundary-duration-validator-four-hours-equals-four-hours",
          not V.validate_duration_allocation(240, 240),
          "validator rejected an exact four-hour allocation")
    duration_over = V.validate_duration_allocation(121, 120)
    check("boundary-duration-validator-one-minute-over-rejected",
          "duration" in _rules(duration_over),
          "validator accepted a duration longer than its slot")

    numeric_boundaries = [
        ("08_ACTIVITY_DETAILS.csv", "total_accesses", 0),
        ("08_ACTIVITY_DETAILS.csv", "activity_priority", 4),
        ("07_PROJECT_DETAILS.csv", "number_of_workfronts", 0),
        ("07_PROJECT_DETAILS.csv", "number_of_maximum_access_per_week", 0),
        ("07_PROJECT_DETAILS.csv", "contract_priority", 0),
        ("04_LOCATION_SUPPLY.csv", "supply_capacity", -1),
        ("05_BUFFER_LOCATION.csv", "up_to_buffer_sectors", -1),
        ("05_BUFFER_LOCATION.csv", "opposite_bound_required", 2),
        ("02_STATIONS.csv", "seq", 0),
        ("03_SECTORS.csv", "seq", 0),
    ]
    for filename, field, value in numeric_boundaries:
        result = validate_csv_bundle(
            _set_first_value(base_bundle, filename, field, value))
        check("boundary-input-range-%s-%s" % (filename[:2], field),
              not result["passed"] and
              "invalid_range" in [
                  error["code"] for error in result["errors"]
              ], str(result["errors"][:2]))

    type_mismatch = validate_csv_bundle(_set_first_value(
        base_bundle, "08_ACTIVITY_DETAILS.csv", "activity_type",
        "Construction"))
    check("boundary-activity-contract-type-mismatch",
          not type_mismatch["passed"] and
          "activity_type_mismatch" in [
              error["code"] for error in type_mismatch["errors"]
          ], str(type_mismatch["errors"][:2]))

    # More maintenance work that still fits must remain feasible and complete.
    increased = run_solve_pipeline(_set_total(base_bundle, "A001", 3),
                                   "A", time_budget=2.0)
    check("boundary-increased-workload-feasible",
          increased["status"] == "feasible" and
          increased["validator_gate"]["passed"] and
          _csv_access_count(increased, "A001") == 3,
          increased["status"])

    # A001 starts in week 21: in isolation exactly ten accesses fit to week 30.
    exact = run_solve_pipeline(_only_activity(base_bundle, "A001", 10),
                               "A", time_budget=3.0)
    check("boundary-exact-horizon-workload-feasible",
          exact["status"] == "feasible" and
          _csv_access_count(exact, "A001") == 10,
          exact["status"])

    over = run_solve_pipeline(_only_activity(base_bundle, "A001", 11),
                              "A", time_budget=2.0)
    check("boundary-one-over-horizon-blocked",
          over["status"] == "infeasible" and
          not over["validator_gate"]["passed"] and
          not over["files"] and
          "workload" in _rules(over["validator_gate"]["hard_violations"]),
          over["status"])

    # In the complete network, nine fit; a tenth blocks mandatory Live A075.
    competing_fit = run_solve_pipeline(_set_total(base_bundle, "A001", 9),
                                       "A", time_budget=3.0)
    check("boundary-competing-workload-at-limit",
          competing_fit["status"] == "feasible" and
          _csv_access_count(competing_fit, "A001") == 9,
          competing_fit["status"])
    competing_over = run_solve_pipeline(_set_total(base_bundle, "A001", 10),
                                        "A", time_budget=3.0)
    check("boundary-competing-workload-one-over",
          competing_over["status"] == "infeasible" and
          not competing_over["files"] and
          "workload" in _rules(
              competing_over["validator_gate"]["hard_violations"]),
          competing_over["status"])

    state = S.State(base, "A")
    check("boundary-last-horizon-week-accepted",
          state.test("A002", 30, 1, "g-last"), "week 30 rejected")
    check("boundary-after-horizon-rejected",
          not state.test("A002", 31, 1, "g-over"), "week 31 accepted")

    independent_inst = _instance_with(base, [base.activities["A002"]])
    week_over = {"A002": [(independent_inst.horizon_weeks + 1, 1, 0)]}
    check("boundary-validator-after-horizon-blocked",
          "horizon" in _rules(V.validate(
              independent_inst, week_over,
              _groups(independent_inst, week_over), "A")),
          "independent validator accepted an after-horizon week")
    max_night = independent_inst.contracts[
        independent_inst.activities["A002"].contract
    ].max_access_per_week
    night_over = {"A002": [(1, max_night + 1, 0)]}
    check("boundary-validator-access-night-over-limit-blocked",
          "access_night" in _rules(V.validate(
              independent_inst, night_over,
              _groups(independent_inst, night_over), "A")),
          "independent validator accepted an access night above the limit")
    bad_eclo = {"A002": [(1, 1, 2)]}
    check("boundary-validator-invalid-eclo-flag-blocked",
          "eclo_flag" in _rules(V.validate(
              independent_inst, bad_eclo,
              _groups(independent_inst, bad_eclo), "C")),
          "independent validator accepted ECLO flag 2")
    valid_slot = {"A002": [(1, 1, 0)]}
    check("boundary-validator-missing-occupancy-group-blocked",
          "occupancy_group" in _rules(V.validate(
              independent_inst, valid_slot, {}, "A")),
          "independent validator accepted missing occupancy groups")

    # Workfront boundary: C001 permits two activities per night.
    work_acts = [_activity("W1"), _activity("W2"), _activity("W3")]
    work_inst = _instance_with(base, work_acts)
    at_limit = {"W1": [(1, 1, 0)], "W2": [(1, 1, 0)]}
    above_limit = dict(at_limit, W3=[(1, 1, 0)])
    check("boundary-workfront-at-limit",
          "workfront" not in _rules(V.validate(
              work_inst, at_limit, _groups(work_inst, at_limit), "A")),
          "workfront rejected at exact limit")
    check("boundary-workfront-one-over",
          "workfront" in _rules(V.validate(
              work_inst, above_limit,
              _groups(work_inst, above_limit), "A")),
          "workfront overflow not detected")

    # Weekly allocation boundary: C001 permits three distinct access nights.
    alloc_acts = [_activity("N%d" % index) for index in range(1, 5)]
    alloc_inst = _instance_with(base, alloc_acts)
    three_nights = {"N1": [(1, 1, 0)], "N2": [(1, 2, 0)],
                    "N3": [(1, 3, 0)]}
    four_nights = dict(three_nights, N4=[(1, 4, 0)])
    check("boundary-weekly-allocation-at-limit",
          "alloc" not in _rules(V.validate(
              alloc_inst, three_nights,
              _groups(alloc_inst, three_nights), "A")),
          "three legal access nights rejected")
    check("boundary-weekly-allocation-one-over",
          "alloc" in _rules(V.validate(
              alloc_inst, four_nights,
              _groups(alloc_inst, four_nights), "A")),
          "fourth access night not detected")

    # Capacity is possession count, not activity count.
    hot_location = "SEC:ALP:H01_H02:EB"  # supplied capacity is one
    capacity_acts = [_activity("CAP1", "C003", hot_location),
                     _activity("CAP2", "C006", hot_location)]
    capacity_inst = _instance_with(base, capacity_acts)
    one_possession = {"CAP1": [(1, 1, 0)]}
    two_possessions = dict(one_possession, CAP2=[(1, 1, 0)])
    check("boundary-location-capacity-at-limit",
          "capacity" not in _rules(V.validate(
              capacity_inst, one_possession,
              _groups(capacity_inst, one_possession), "A")),
          "one possession rejected at capacity one")
    check("boundary-location-capacity-one-over",
          "capacity" in _rules(V.validate(
              capacity_inst, two_possessions,
              _groups(capacity_inst, two_possessions), "A")),
          "second possession not detected")

    # Mix boundary is per co-share possession: one PC plus three C is legal.
    mix_acts = [_activity("PC", "C004")] + [
        _activity("C%d" % index, contract)
        for index, contract in enumerate(("C001", "C002", "C003", "C006"), 1)
    ]
    mix_inst = _instance_with(base, mix_acts)
    legal_mix = {aid: [(1, 1, 0)] for aid in ("PC", "C1", "C2", "C3")}
    illegal_mix = dict(legal_mix, C4=[(1, 1, 0)])
    same_group = lambda _aid, _week: "g-shared"
    check("boundary-possession-mix-at-limit",
          "mix" not in _rules(V.validate(
              mix_inst, legal_mix,
              _groups(mix_inst, legal_mix, same_group), "B")),
          "PC plus three C rejected")
    check("boundary-possession-mix-one-over",
          "mix" in _rules(V.validate(
              mix_inst, illegal_mix,
              _groups(mix_inst, illegal_mix, same_group), "B")),
          "PC plus four C not detected")
    split_group = lambda aid, _week: "g-second" if aid == "C4" else "g-shared"
    check("boundary-mix-separated-possession-legal",
          "mix" not in _rules(V.validate(
              mix_inst, illegal_mix,
              _groups(mix_inst, illegal_mix, split_group), "B")),
          "separate possession was aggregated into mix")

    # A successor may start exactly one week after its predecessor finishes.
    pred_inst = _instance_with(base, [base.activities["A003"],
                                      base.activities["A004"]])
    predecessor = [(12, 1, 0), (13, 1, 0), (14, 1, 0),
                   (15, 1, 0), (16, 1, 0)]
    legal_pred = {"A003": predecessor,
                  "A004": [(17, 1, 0), (18, 1, 0), (19, 1, 0)]}
    illegal_pred = dict(legal_pred,
                        A004=[(16, 1, 0), (18, 1, 0), (19, 1, 0)])
    check("boundary-predecessor-next-week-legal",
          "precedence" not in _rules(V.validate(
              pred_inst, legal_pred, _groups(pred_inst, legal_pred), "A")),
          "successor rejected one week after predecessor")
    check("boundary-predecessor-same-week-blocked",
          "precedence" in _rules(V.validate(
              pred_inst, illegal_pred, _groups(pred_inst, illegal_pred), "A")),
          "same-week successor not detected")

    # Scenario B permits completion on the planned date, never one week later.
    b_inst = _instance_with(base, [base.activities["A002"]])
    b_on_time = {"A002": [(23, 1, 0)]}
    b_late = {"A002": [(24, 1, 0)]}
    check("boundary-scenario-b-planned-date-legal",
          "planned_date" not in _rules(V.validate(
              b_inst, b_on_time, _groups(b_inst, b_on_time), "B")),
          "planned-date completion rejected")
    check("boundary-scenario-b-one-week-late-blocked",
          "planned_date" in _rules(V.validate(
              b_inst, b_late, _groups(b_inst, b_late), "B")),
          "late Scenario B completion not detected")

    # Scenario C ECLO may occupy a two-week window, not a three-week span.
    c_inst = _instance_with(base, [base.activities["A003"]])
    c_two_weeks = {"A003": [(11, 1, 1), (12, 1, 1), (13, 1, 0),
                             (14, 1, 0), (16, 1, 0)]}
    c_three_weeks = {"A003": [(11, 1, 1), (12, 1, 0), (13, 1, 1),
                               (14, 1, 0), (16, 1, 0)]}
    check("boundary-scenario-c-two-week-eclo-legal",
          "eclo_window" not in _rules(V.validate(
              c_inst, c_two_weeks,
              _groups(c_inst, c_two_weeks), "C")),
          "two-week ECLO window rejected")
    check("boundary-scenario-c-three-week-eclo-blocked",
          "eclo_window" in _rules(V.validate(
              c_inst, c_three_weeks,
              _groups(c_inst, c_three_weeks), "C")),
          "three-week ECLO span not detected")

    # Live mirror conflicts are hard failures.
    mirror_inst = _instance_with(base, [base.activities["A003"],
                                        base.activities["A074"]])
    mirror_accesses = {
        "A003": [(11, 1, 0), (12, 1, 0), (13, 1, 0),
                 (14, 1, 0), (21, 1, 0)],
        "A074": [(21, 1, 0)],
    }
    check("boundary-live-mirror-collision-blocked",
          "mirror" in _rules(V.validate(
              mirror_inst, mirror_accesses,
              _groups(mirror_inst, mirror_accesses), "A")),
          "Live mirror collision not detected")

    # Current evidence rule: non-Live buffer overlaps are visible warnings.
    buffer_inst = _instance_with(base, [base.activities["A001"],
                                        base.activities["A007"]])
    buffer_accesses = {
        "A001": [(21, 1, 0), (22, 1, 0)],
        "A007": [(15, 1, 0), (16, 1, 0), (17, 1, 0), (18, 1, 0),
                 (19, 1, 0), (20, 1, 0), (22, 1, 0)],
    }
    buffer_groups = _groups(buffer_inst, buffer_accesses)
    buffer_hard = V.validate(
        buffer_inst, buffer_accesses, buffer_groups, "A")
    check("boundary-buffer-overlap-not-hard",
          not buffer_hard, str(buffer_hard))
    check("boundary-buffer-overlap-warning-visible",
          "buffer_note" in _rules(V.warnings(
              buffer_inst, buffer_accesses, buffer_groups, "A")),
          "buffer overlap warning missing")

    # Local-key concurrency: deterministic simultaneity for non-Live work
    # exists only for the official local key
    # (contract_number, activity_type, week, access_night).
    loc_a = "SEC:ALP:S01_S02:EB"
    loc_b = "SEC:ALP:S02_S03:EB"
    loc_c = "SEC:ALP:S03_S04:EB"

    def _sample_hard():
        import csv as _csv
        sample = "/tmp/PS1-latest/03_submission_sample"
        acc = {}
        grp = {}
        with open(sample + "/SCHEDULE_ACCESS.csv",
                  encoding="utf-8-sig") as handle:
            for row in _csv.DictReader(handle):
                acc.setdefault(row["activity_id"], []).append(
                    (int(row["week"]), int(row["access_night"]),
                     int(row["eclo"])))
        with open(sample + "/SCHEDULE_OCCUPANCY.csv",
                  encoding="utf-8-sig") as handle:
            for row in _csv.DictReader(handle):
                grp[(row["activity_id"], int(row["week"]),
                     row["location_id"])] = row["co_share_group"]
        return V.validate(base, acc, grp, "A")

    sample_hard = _sample_hard()
    check("boundary-official-sample-cross-contract-closures-caught",
          "closure" in _rules(sample_hard),
          str(sample_hard[:2]))

    # Concurrent actual footprint overlap between distinct possessions
    # is hard closure.
    closure_inst = _instance_with(
        base, [_activity("K1", "C001", loc_a),
               _activity("K2", "C001", loc_b)])
    closure_acc = {"K1": [(1, 1, 0)], "K2": [(1, 1, 0)]}
    closure_grp = _groups(
        closure_inst, closure_acc,
        lambda aid, _week: "g-k1" if aid == "K1" else "g-k2")
    closure_hard = V.validate(closure_inst, closure_acc, closure_grp, "A")
    check("boundary-concurrent-actual-closure-hard",
          "closure" in _rules(closure_hard),
          str(closure_hard))

    # Concurrent actual footprint entering another possession's
    # exclusion-only buffer is hard buffer. Use reach=2 copy so the
    # footprints stay disjoint while the buffer reaches.
    buffer2_inst = _instance_with(
        base, [_activity("B1", "C001", loc_a),
               _activity("B2", "C001", loc_c)])
    buffer2_inst.buffers["Non-live (Consist)"] = (2, 0)
    buffer2_acc = {"B1": [(1, 1, 0)], "B2": [(1, 1, 0)]}
    buffer2_grp = _groups(
        buffer2_inst, buffer2_acc,
        lambda aid, _week: "g-b1" if aid == "B1" else "g-b2")
    buffer2_hard = V.validate(buffer2_inst, buffer2_acc, buffer2_grp, "A")
    check("boundary-concurrent-exclusion-buffer-hard",
          "buffer" in _rules(buffer2_hard) and
          "closure" not in _rules(buffer2_hard),
          str(buffer2_hard))

    # Pure buffer-vs-buffer overlap is not hard; shared empty clearance
    # stays a buffer_note warning.
    bufbuf_inst = _instance_with(
        base, [_activity("Q1", "C001", loc_a),
               _activity("Q2", "C001", loc_c)])
    bufbuf_acc = {"Q1": [(1, 1, 0)], "Q2": [(1, 1, 0)]}
    bufbuf_grp = _groups(
        bufbuf_inst, bufbuf_acc,
        lambda aid, _week: "g-q1" if aid == "Q1" else "g-q2")
    check("boundary-pure-buffer-buffer-allowed",
          not V.validate(bufbuf_inst, bufbuf_acc, bufbuf_grp, "A"),
          str(V.validate(bufbuf_inst, bufbuf_acc, bufbuf_grp, "A")))
    check("boundary-pure-buffer-buffer-warned",
          "buffer_note" in _rules(V.warnings(
              bufbuf_inst, bufbuf_acc, bufbuf_grp, "A")),
          "buffer-buffer warning missing")

    # Same contract/type different local nights are not concurrent.
    diffnight_inst = _instance_with(
        base, [_activity("D1", "C001", loc_a),
               _activity("D2", "C001", loc_b)])
    diffnight_acc = {"D1": [(1, 1, 0)], "D2": [(1, 2, 0)]}
    diffnight_grp = _groups(
        diffnight_inst, diffnight_acc,
        lambda aid, _week: "g-d1" if aid == "D1" else "g-d2")
    check("boundary-same-key-different-nights-allowed",
          not V.validate(
              diffnight_inst, diffnight_acc, diffnight_grp, "A"),
          str(V.validate(
              diffnight_inst, diffnight_acc, diffnight_grp, "A")))
    check("boundary-same-key-different-nights-no-warning",
          "buffer_note" not in _rules(V.warnings(
              diffnight_inst, diffnight_acc, diffnight_grp, "A")),
          str(V.warnings(diffnight_inst, diffnight_acc, diffnight_grp,
                         "A")))

    # Different contracts do not share a comparable local access-night
    # coordinate. A same-week actual footprint collision therefore cannot be
    # proven safe and must be rejected as a closure conflict.
    cross_inst = _instance_with(
        base, [_activity("X1", "C001", loc_a),
               _activity("X2", "C002", loc_b)])
    cross_acc = {"X1": [(1, 1, 0)], "X2": [(1, 1, 0)]}
    cross_grp = _groups(
        cross_inst, cross_acc,
        lambda aid, _week: "g-x1" if aid == "X1" else "g-x2")
    cross_hard = V.validate(cross_inst, cross_acc, cross_grp, "A")
    check("boundary-cross-contract-actual-overlap-hard",
          "closure" in _rules(cross_hard),
          str(cross_hard))
    check("boundary-cross-contract-actual-overlap-not-warning",
          "buffer_note" not in _rules(V.warnings(
              cross_inst, cross_acc, cross_grp, "A")),
          "cross-contract closure was also emitted as a warning")

    # Regression for the external-validator error pair reported from the PS1
    # data. A025 (C004) and A028 (C005) share PLAT:ALP:S03:EB; putting them in
    # the same week with distinct possession groups is a hard closure.
    reported_inst = _instance_with(
        base, [base.activities["A025"], base.activities["A028"]])
    reported_acc = {"A025": [(12, 1, 0)], "A028": [(12, 1, 0)]}
    reported_grp = _groups(
        reported_inst, reported_acc,
        lambda aid, _week: "g-a025" if aid == "A025" else "g-a028")
    reported_hard = V.validate(
        reported_inst, reported_acc, reported_grp, "A")
    check("boundary-reported-a025-a028-cross-contract-closure-hard",
          any(v["rule"] == "closure" and
              set(v["aids"]) == {"A025", "A028"}
              for v in reported_hard),
          str(reported_hard))

    # Exact same (location_id, week, co_share_group) is one co-shared
    # possession and exempt at that shared footprint.
    share_inst = _instance_with(
        base, [_activity("S1", "C001", loc_a),
               _activity("S2", "C001", loc_a)])
    share_acc = {"S1": [(1, 1, 0)], "S2": [(1, 1, 0)]}
    share_grp = _groups(
        share_inst, share_acc, lambda _aid, _week: "g-shared")
    check("boundary-exact-coshare-tuple-exempt",
          not V.validate(share_inst, share_acc, share_grp, "A"),
          str(V.validate(share_inst, share_acc, share_grp, "A")))

    # Existing hard Live opposite-bound and H01/H02 interchange mirror
    # behavior is preserved.
    live_inst = _instance_with(base, [base.activities["A003"],
                                      base.activities["A074"]])
    live_acc = {
        "A003": [(11, 1, 0), (12, 1, 0), (13, 1, 0),
                 (14, 1, 0), (21, 1, 0)],
        "A074": [(21, 1, 0)],
    }
    live_grp = _groups(live_inst, live_acc)
    check("boundary-live-mirror-preserved-hard",
          "mirror" in _rules(V.validate(live_inst, live_acc, live_grp, "A")),
          "Live mirror not preserved")

    # Solver State.test agrees with the independent validator for
    # representative accept/reject placements.
    st_reject = S.State(closure_inst, "A")
    st_reject.place("K1", 1, 1, "g-k1", 0)
    check("boundary-solver-rejects-concurrent-closure",
          not st_reject.test("K2", 1, 1, "g-k2"),
          "solver accepted a concurrent closure")
    st_accept_night = S.State(diffnight_inst, "A")
    st_accept_night.place("D1", 1, 1, "g-d1", 0)
    check("boundary-solver-accepts-different-nights",
          st_accept_night.test("D2", 1, 2, "g-d2"),
          "solver rejected different local nights")
    st_reject_cross = S.State(cross_inst, "A")
    st_reject_cross.place("X1", 1, 1, "g-x1", 0)
    check("boundary-solver-rejects-cross-contract-closure",
          not st_reject_cross.test("X2", 1, 1, "g-x2"),
          "solver accepted a cross-contract closure")
    st_accept_bufbuf = S.State(bufbuf_inst, "A")
    st_accept_bufbuf.place("Q1", 1, 1, "g-q1", 0)
    check("boundary-solver-accepts-buffer-buffer",
          st_accept_bufbuf.test("Q2", 1, 1, "g-q2"),
          "solver rejected pure buffer-buffer")
    st_reject_buf = S.State(buffer2_inst, "A")
    st_reject_buf.place("B1", 1, 1, "g-b1", 0)
    check("boundary-solver-rejects-exclusion-buffer",
          not st_reject_buf.test("B2", 1, 1, "g-b2"),
          "solver accepted an exclusion-only intrusion")
