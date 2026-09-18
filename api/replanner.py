"""Deterministic disruption re-planning with a validator release gate.

The parser deliberately accepts only two narrow commands.  It is not an AI
planner: text becomes a small structured disruption, the scheduling core moves
the affected activity/dependency chain, and the independent validator alone
decides whether files may be released.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

from . import exporter as E
from . import model as M
from . import solver as S
from . import validator as V
from .model import Instance


@dataclass(frozen=True)
class Disruption:
    kind: str
    activity_id: str
    week: Optional[int] = None
    delay_weeks: int = 0


_BLOCK = re.compile(
    r"^\s*(?:block\s+)?(A\d+)\s+(?:is\s+)?(?:unavailable\s+)?"
    r"(?:in\s+)?week\s+(\d+)\s*$", re.IGNORECASE)
_DELAY = re.compile(
    r"^\s*delay\s+(A\d+)\s+by\s+(\d+)\s+weeks?\s*$",
    re.IGNORECASE)


def parse_disruption(text: str) -> Disruption:
    """Parse the intentionally narrow replan language."""
    match = _BLOCK.match(text)
    if match:
        return Disruption("block_week", match.group(1).upper(),
                          week=int(match.group(2)))
    match = _DELAY.match(text)
    if match:
        return Disruption("delay", match.group(1).upper(),
                          delay_weeks=int(match.group(2)))
    raise ValueError(
        "unsupported disruption; use 'block A001 in week 12' or "
        "'delay A001 by 2 weeks'")


def _descendants(inst: Instance, root: str) -> Set[str]:
    affected = {root}
    changed = True
    while changed:
        changed = False
        for aid, activity in inst.activities.items():
            if activity.predecessor in affected and aid not in affected:
                affected.add(aid)
                changed = True
    return affected


def _slot_group(inst: Instance, groups: S.Groups, aid: str, week: int) -> str:
    labels = sorted({groups.get((aid, week, loc), "g0")
                     for loc in inst.expand(inst.activities[aid])})
    return labels[0] if labels else "g0"


def _seed_locked(inst: Instance, scenario: str, accesses: S.Accesses,
                 groups: S.Groups, affected: Set[str]) -> S.State:
    state = S.State(inst, scenario)
    for aid in sorted(accesses):
        if aid in affected:
            continue
        for week, night, eclo in sorted(accesses[aid]):
            state.place(aid, week, night,
                        _slot_group(inst, groups, aid, week), eclo)
    numeric = []
    for slot in state.slots:
        match = re.fullmatch(r"g(\d+)", slot.group)
        if match:
            numeric.append(int(match.group(1)))
    state._counter = max(numeric or [0])
    return state


def _candidate_weeks(desired: int, lower: int, horizon: int,
                     forbidden: Set[int]) -> List[int]:
    valid = [w for w in range(lower, horizon + 1) if w not in forbidden]
    return sorted(valid, key=lambda w: (abs(w - desired), w))


def _place_preserving_churn(state: S.State, aid: str,
                            original: List[Tuple[int, int, int]],
                            first_not_before: int,
                            forbidden: Set[int]) -> None:
    """Reinsert an activity close to its old weeks, preserving ECLO flags."""
    previous = 0
    for old_week, _old_night, eclo in sorted(original):
        lower = max(state.start_week(aid), first_not_before, previous + 1)
        placed = False
        for strict in (True, False):
            if state.sc == "B" and strict:
                continue
            for week in _candidate_weeks(old_week, lower,
                                         state.inst.horizon_weeks, forbidden):
                slot = S._choose_slot(state, aid, week, strict=strict)
                if slot:
                    night, group = slot
                    state.place(aid, week, night, group, eclo)
                    previous = week
                    placed = True
                    break
            if placed:
                break
        if not placed:
            return


def _change_rows(before: S.Accesses, after: S.Accesses,
                 affected: Set[str]) -> List[dict]:
    changes = []
    for aid in sorted(affected):
        old = [w for w, _n, _e in sorted(before.get(aid, []))]
        new = [w for w, _n, _e in sorted(after.get(aid, []))]
        if old != new:
            changes.append({"activity_id": aid, "before_weeks": old,
                            "after_weeks": new})
    return changes


def replan(inst: Instance, scenario: str, baseline_accesses: S.Accesses,
           baseline_groups: S.Groups, text: str):
    """Return (public result, candidate accesses, candidate groups)."""
    disruption = parse_disruption(text)
    if disruption.activity_id not in inst.activities:
        raise ValueError("unknown activity %s" % disruption.activity_id)
    if disruption.week is not None and not (
            1 <= disruption.week <= inst.horizon_weeks):
        raise ValueError("week must be within the scheduling horizon")
    if disruption.delay_weeks < 1:
        if disruption.kind == "delay":
            raise ValueError("delay must be at least 1 week")

    before_violations = V.validate(
        inst, baseline_accesses, baseline_groups, scenario)
    before_warnings = V.warnings(
        inst, baseline_accesses, baseline_groups, scenario)
    before_report = E.build_report(
        inst, baseline_accesses, baseline_groups, scenario,
        before_violations)
    if before_violations:
        result = {
            "status": "baseline_invalid",
            "disruption": disruption.__dict__,
            "validator_gate": {"passed": False,
                               "hard_violations": before_violations,
                               "soft_warnings": before_warnings},
            "before_report": before_report,
            "after_report": None,
            "changes": [],
            "locked_activity_count": 0,
            "explanation": (
                "Baseline failed the independent validator; no replan or "
                "CSV release was attempted."),
        }
        return result, baseline_accesses, baseline_groups

    target_weeks = {w for w, _n, _e
                    in baseline_accesses[disruption.activity_id]}
    if (disruption.kind == "block_week" and
            disruption.week not in target_weeks):
        result = {
            "status": "unchanged",
            "disruption": disruption.__dict__,
            "validator_gate": {"passed": True, "hard_violations": [],
                               "soft_warnings": before_warnings},
            "before_report": before_report,
            "after_report": before_report,
            "changes": [],
            "locked_activity_count": len(inst.activities),
            "explanation": (
                "%s had no access in blocked week %s. The validated plan "
                "remains unchanged." %
                (disruption.activity_id, disruption.week)),
        }
        return result, baseline_accesses, baseline_groups

    affected = _descendants(inst, disruption.activity_id)
    state = _seed_locked(inst, scenario, baseline_accesses,
                         baseline_groups, affected)
    baseline_first = min(target_weeks)
    for aid in M.topo_order(inst.activities):
        if aid not in affected:
            continue
        min_week = state.start_week(aid)
        forbidden: Set[int] = set()
        if aid == disruption.activity_id:
            if disruption.kind == "delay":
                min_week = max(min_week,
                               baseline_first + disruption.delay_weeks)
            else:
                forbidden.add(int(disruption.week))
        _place_preserving_churn(
            state, aid, baseline_accesses.get(aid, []), min_week, forbidden)

    for aid in state.accesses:
        state.accesses[aid].sort()
    violations = V.validate(inst, state.accesses, state.groups, scenario)
    soft_warnings = V.warnings(
        inst, state.accesses, state.groups, scenario)
    after_report = E.build_report(
        inst, state.accesses, state.groups, scenario, violations)
    changes = _change_rows(baseline_accesses, state.accesses, affected)
    passed = not violations
    before_score = float(before_report["soft_scores"]["objective_score"])
    after_score = float(after_report["soft_scores"]["objective_score"])
    delta = round(after_score - before_score, 1)
    locked = len(inst.activities) - len(affected)
    if passed:
        explanation = (
            "Independent validator passed with 0 hard violations and %d "
            "buffer-semantics warnings. "
            "%d affected activities were reconsidered; %d activities stayed "
            "locked. %d activities changed weeks. Objective score delta: "
            "%+.1f. Feasibility comes from the validator, not this text."
            % (len(soft_warnings), len(affected), locked, len(changes), delta))
        status = "feasible"
    else:
        explanation = (
            "Independent validator rejected the candidate with %d hard "
            "violations. No CSVs were released. Locked work was not silently "
            "moved; a planner must relax the disruption or locks."
            % len(violations))
        status = "infeasible_under_locks"
    result = {
        "status": status,
        "disruption": disruption.__dict__,
        "validator_gate": {"passed": passed,
                           "hard_violations": violations,
                           "soft_warnings": soft_warnings},
        "before_report": before_report,
        "after_report": after_report,
        "changes": changes,
        "locked_activity_count": locked,
        "affected_activity_ids": sorted(affected),
        "explanation": explanation,
    }
    return result, state.accesses, state.groups
