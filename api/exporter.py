"""PS1 exporter: exact CSV outputs, RESULTS dates, validator-style scores.

Conventions (verified against the supplied Scenario A sample):
  simulated_completion_date = last day of the contract's last access week
  contract overrun = max(0, completion - planned_completion_date).days
  activity overrun = same, per activity (drives priority_weighted_score)
"""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Tuple

from .model import Instance, TIER_WEIGHT, ACT_NUDGE, activity_overrun_days

Accesses = Dict[str, List[Tuple[int, int, int]]]
Groups = Dict[Tuple[str, int, str], str]  # (aid, week, location) -> group


def _group(groups: Groups, aid: str, w: int, loc: str) -> str:
    return groups.get((aid, w, loc), groups.get((aid, w), "g0"))  # type: ignore


def contract_completion(inst: Instance, accesses: Accesses,
                        cnum: str) -> Tuple[object, int]:
    comp = None
    for aid, a in inst.activities.items():
        if a.contract != cnum:
            continue
        for (w, _n, _e) in accesses.get(aid, []):
            d = inst.week_end(w)
            if comp is None or d > comp:
                comp = d
    planned = inst.contracts[cnum].planned
    if comp is None:
        return planned, 0  # workload violation flags the real problem
    return comp, max(0, (comp - planned).days)


def possessions_per_locweek(inst: Instance, accesses: Accesses,
                            groups: Groups):
    per = defaultdict(set)  # (loc, week) -> groups
    for aid, lst in accesses.items():
        if aid not in inst.activities:
            continue
        F = inst.expand(inst.activities[aid])
        for (w, _n, _e) in lst:
            for loc in F:
                per[(loc, w)].add(_group(groups, aid, w, loc))
    return per


def compute_scores(inst: Instance, accesses: Accesses, groups: Groups,
                   scenario: str) -> dict:
    over_total, over_n, early_total = 0, 0, 0
    tier_raw = {"1": 0, "2": 0, "3": 0}
    weighted = 0.0
    for cnum, c in inst.contracts.items():
        comp, over = contract_completion(inst, accesses, cnum)
        over_total += over
        if over:
            over_n += 1
            tier_raw[str(c.priority)] += over
        else:
            early_total += max(0, (c.planned - comp).days)
        for aid, a in inst.activities.items():
            if a.contract != cnum:
                continue
            weeks = [w for w, _, _ in accesses.get(aid, [])]
            if not weeks:
                continue
            ao = activity_overrun_days(inst, a, max(weeks))
            if ao:
                weighted += (TIER_WEIGHT[c.priority] *
                             (1 + ACT_NUDGE[a.priority]) * ao)
    per = possessions_per_locweek(inst, accesses, groups)
    excess = sum(max(0, len(gs) - inst.supply.get(loc, 0))
                 for (loc, _w), gs in per.items())
    eclo = sum(e for lst in accesses.values() for (_w, _n, e) in lst)
    nights = sum(len(lst) for lst in accesses.values())
    if scenario == "A":
        score = weighted
    elif scenario == "B":
        score = 7 * excess + 5 * eclo
    else:
        score = weighted + 7 * excess + 5 * eclo
    hotspots = sorted([f"{loc} wk{w}"
                       for (loc, w), gs in per.items()
                       if len(gs) >= inst.supply.get(loc, 0)])[:20]
    return {"scenario": scenario, "overrun_days_total": over_total,
            "contracts_overrunning": over_n,
            "earliness_days_total": early_total,
            "excess_access_nights_total": excess,
            "eclo_nights_total": eclo,
            "priority_overrun": tier_raw,
            "priority_weighted_score": round(weighted, 1),
            "objective_score": round(score, 1),
            "detail": {"capacity_hotspots": hotspots,
                       "nights_scheduled": nights, "eclo_nights": eclo}}


def total_score(inst: Instance, accesses: Accesses, groups: Groups,
                scenario: str) -> float:
    return float(compute_scores(inst, accesses, groups,
                                scenario)["objective_score"])


def build_outputs(inst: Instance, accesses: Accesses, groups: Groups,
                  scenario: str):
    """(access_rows, occupancy_rows, results_rows, scores) incl. headers."""
    access_rows = [["activity_id", "access_seq", "week", "eclo",
                    "access_night"]]
    for aid in sorted(accesses):
        for i, (w, n, e) in enumerate(sorted(accesses[aid]), 1):
            access_rows.append([aid, i, w, e, n])
    occ_rows = [["activity_id", "week", "location_id", "co_share_group"]]
    for aid in sorted(accesses):
        F = inst.expand(inst.activities[aid]) if aid in inst.activities else []
        for (w, _n, _e) in sorted(accesses[aid]):
            for loc in F:
                occ_rows.append([aid, w, loc, _group(groups, aid, w, loc)])
    res_rows = [["scenario", "contract_number", "simulated_completion_date",
                 "overrun_days"]]
    for cnum in sorted(inst.contracts):
        comp, over = contract_completion(inst, accesses, cnum)
        res_rows.append([scenario, cnum, comp.isoformat(), over])
    return access_rows, occ_rows, res_rows, compute_scores(inst, accesses,
                                                           groups, scenario)


def build_report(inst: Instance, accesses: Accesses, groups: Groups,
                 scenario: str, violations: list) -> dict:
    scores = compute_scores(inst, accesses, groups, scenario)
    detail = scores.pop("detail")
    return {"scenario": scenario, "feasible": not violations,
            "hard_violations": [{"rule": v["rule"], "severity": "hard",
                                 "detail": v["detail"]} for v in violations],
            "soft_scores": scores, "detail": detail}
