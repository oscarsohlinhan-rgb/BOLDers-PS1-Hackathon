"""Advisory weekday planning inside the weekly schedule.

Runs in the solver's own engine on the Cloud API so weekday placement uses
the exact overlap semantics as weekly optimisation: booked footprints,
exclusion-buffer halos, Live mirroring, co-share groups, and workfront caps.

Advisory only: preferred weekdays are a planning overlay. They are never
validated, never scored, and never written into canonical or submission
files. Deterministic for identical inputs.
"""
from __future__ import annotations

import csv
import io
import os
import tempfile
from typing import Any, Dict, List, Tuple

ENGINE = "tao-dayplan/1"
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
NATURE_ORDER = {"Live": 0, "Non-live (Consist)": 1, "Non-live (Others)": 2}
ACCESS_ORDER = {"PM": 0, "PC": 1, "C": 2}
STRATEGIES = ("spread", "frontload")

CANONICAL_FILES = [
    "01_LINES.csv", "02_STATIONS.csv", "03_SECTORS.csv",
    "04_LOCATION_SUPPLY.csv", "05_BUFFER_LOCATION.csv",
    "06_PARAMETERS.csv", "07_PROJECT_DETAILS.csv",
    "08_ACTIVITY_DETAILS.csv",
]
SCHEDULE_ACCESS = "SCHEDULE_ACCESS.csv"
SCHEDULE_OCCUPANCY = "SCHEDULE_OCCUPANCY.csv"


def _rows(text: str) -> List[Dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text or "")))


def _rank(value: Any, order: Dict[str, int]) -> int:
    return order.get(value, 99) if value is not None else 99


def _possession_key(group: Any) -> str | None:
    text = "" if group is None else str(group)
    return text if text != "" else None


def _shares_possession(a: Dict[str, Any], b: Dict[str, Any]) -> str | None:
    """Exact shared (location, co_share_group) possession, if any."""
    for loc in a["locations"]:
        if loc in b["booked"] and \
                _possession_key(a["groups"].get(loc)) is not None and \
                _possession_key(a["groups"].get(loc)) == \
                _possession_key(b["groups"].get(loc)):
            return loc
    return None


def _pair_clash(item: Dict[str, Any], entry: Dict[str, Any]) -> Dict[str, Any] | None:
    """Buffer/footprint clash between two items, or None.

    Sharing the exact (location, co_share_group) possession exempts that
    pair: same possession means the same night, hence the same weekday.
    """
    if _shares_possession(item, entry):
        return None
    for loc in item["foot"]:
        if loc in entry["foot_set"]:
            return {
                "other": entry["activity_id"],
                "loc": loc,
                "buffered": loc not in item["booked"]
                or loc not in entry["booked"],
            }
    return None


def _conflicts_on(item: Dict[str, Any], placed: List[Dict[str, Any]],
                  day: int) -> Dict[str, Any] | None:
    same_contract = 0
    for other in placed:
        if other["day"] != day:
            continue
        entry = other["item"]
        if item.get("contract_number") is not None and \
                entry.get("contract_number") == item.get("contract_number"):
            same_contract += 1
        hit = _pair_clash(item, entry)
        if hit:
            return hit
    cap = item.get("workfronts") or 99
    try:
        cap = int(cap)
    except (TypeError, ValueError):
        cap = 99
    if same_contract >= cap:
        return {"other": f"{same_contract}x {item.get('contract_number')}",
                "loc": "workfront limit"}
    return None


def plan_weekdays(bundle: Dict[str, str],
                  fixed: Dict[str, int],
                  strategy: str = "spread") -> Dict[str, Any]:
    """Suggest a weekday (0=Mon..6=Sun) for every scheduled night.

    bundle must hold the 8 canonical files plus SCHEDULE_ACCESS.csv and
    SCHEDULE_OCCUPANCY.csv. fixed maps "activity_id|week" to a weekday that
    is always preserved. strategy is "spread" (least-loaded clear weekday,
    our default so jobs keep ample space) or "frontload" (earliest clear
    weekday).
    """
    if strategy not in STRATEGIES:
        return {"status": "rejected_input",
                "error": {"code": "bad_strategy",
                          "detail": "strategy must be spread or frontload"}}
    for name in CANONICAL_FILES + [SCHEDULE_ACCESS, SCHEDULE_OCCUPANCY]:
        if not (bundle.get(name) or "").strip():
            return {"status": "rejected_input",
                    "error": {"code": "missing_file",
                              "detail": "plan-days needs the 8 canonical files plus "
                                        "SCHEDULE_ACCESS.csv and SCHEDULE_OCCUPANCY.csv"}}
    clean_fixed: Dict[str, int] = {}
    if fixed:
        if not isinstance(fixed, dict):
            return {"status": "rejected_input",
                    "error": {"code": "bad_fixed",
                              "detail": "fixed must map 'activity_id|week' to 0..6"}}
        for key, day in fixed.items():
            if not isinstance(key, str) or "|" not in key:
                continue
            if not isinstance(day, int) or isinstance(day, bool) \
                    or day < 0 or day > 6:
                return {"status": "rejected_input",
                        "error": {"code": "bad_fixed",
                                  "detail": f"fixed day for {key} must be 0..6"}}
            clean_fixed[key] = day

    from .model import load_instance

    with tempfile.TemporaryDirectory() as tmp:
        for fname in CANONICAL_FILES:
            with open(os.path.join(tmp, fname), "w", newline="") as handle:
                handle.write(bundle[fname])
        try:
            inst = load_instance(tmp)
        except (KeyError, ValueError) as exc:
            return {"status": "rejected_input",
                    "error": {"code": "model_load_error", "detail": str(exc)}}

    occupancy: Dict[Tuple[str, int], List[Tuple[str, str]]] = {}
    for row in _rows(bundle[SCHEDULE_OCCUPANCY]):
        try:
            week = int(row["week"])
        except (KeyError, TypeError, ValueError):
            continue
        occupancy.setdefault(
            (row.get("activity_id", ""), week), []).append(
                (row.get("location_id", ""), row.get("co_share_group", "")))
    seqs: Dict[Tuple[str, int], List[int]] = {}
    for row in _rows(bundle[SCHEDULE_ACCESS]):
        try:
            week = int(row["week"])
            seq = int(row["access_seq"])
        except (KeyError, TypeError, ValueError):
            continue
        seqs.setdefault((row.get("activity_id", ""), week), []).append(seq)

    items = []
    for (aid, week) in sorted(seqs):
        activity = inst.activities.get(aid)
        if activity is None:
            continue
        contract = inst.contracts.get(activity.contract)
        if contract is None:
            continue
        slots = occupancy.get((aid, week), [])
        locations = sorted({loc for loc, _ in slots if loc})
        groups = {loc: group for loc, group in slots}
        try:
            halo = set(inst.buffer_footprint(list(locations),
                                             contract.nature))
            halo |= set(inst.mirror_blocks(list(locations),
                                           contract.nature))
        except (KeyError, ValueError) as exc:
            return {"status": "rejected_input",
                    "error": {"code": "footprint_error", "detail": str(exc)}}
        items.append({
            "key": f"{aid}|{week}",
            "activity_id": aid,
            "week": week,
            "contract_number": activity.contract,
            "priority": contract.priority,
            "nature": contract.nature,
            "access_type": contract.access_type,
            "seq": min(seqs[(aid, week)]),
            "count": len(seqs[(aid, week)]),
            "locations": locations,
            "groups": groups,
            "booked": set(locations),
            "foot": sorted(halo),
            "foot_set": halo,
            "workfronts": contract.workfronts,
        })

    by_week: Dict[int, list] = {}
    for item in items:
        by_week.setdefault(item["week"], []).append(item)

    picks = []
    weeks = []
    for week in sorted(by_week):
        week_items = sorted(
            by_week[week],
            key=lambda item: (
                item["priority"],
                _rank(item["nature"], NATURE_ORDER),
                _rank(item["access_type"], ACCESS_ORDER),
                item["seq"],
                item["activity_id"],
            ),
        )
        placed = []
        for item in week_items:
            key = item["key"]
            if key in clean_fixed:
                placed.append({"item": item, "day": clean_fixed[key]})
                continue
            join = None
            for other in placed:
                loc = _shares_possession(item, other["item"])
                if not loc:
                    continue
                blocked = any(
                    _pair_clash(item, entry["item"]) is not None
                    for entry in placed
                    if entry["day"] == other["day"]
                    and entry["item"]["activity_id"]
                    != other["item"]["activity_id"]
                )
                if not blocked:
                    join = (other["day"], other["item"]["activity_id"], loc)
                    break
            if join is not None:
                day, other_id, loc = join
                placed.append({"item": item, "day": day})
                picks.append({
                    "activity_id": item["activity_id"], "week": week,
                    "day": day, "day_name": DAY_NAMES[day],
                    "source": "suggested",
                    "reason": f"Shares {item['groups'][loc]} possession at "
                              f"{loc} with {other_id}",
                })
                continue
            first_blocker = None
            clear_days = []
            for day in range(7):
                hit = _conflicts_on(item, placed, day)
                if hit is None:
                    clear_days.append(day)
                elif first_blocker is None:
                    first_blocker = hit
            if strategy == "frontload":
                chosen = clear_days[0] if clear_days else None
            else:
                chosen = None
                best_load = None
                for day in clear_days:
                    load = sum(1 for other in placed if other["day"] == day)
                    if best_load is None or load < best_load:
                        best_load = load
                        chosen = day
            if chosen is None:
                best = 0
                best_load = None
                for day in range(7):
                    load = sum(1 for other in placed if other["day"] == day)
                    if best_load is None or load < best_load:
                        best_load = load
                        best = day
                placed.append({"item": item, "day": best})
                picks.append({
                    "activity_id": item["activity_id"], "week": week,
                    "day": best, "day_name": DAY_NAMES[best],
                    "source": "suggested",
                    "reason": "Fully blocked week — least-loaded day",
                })
                continue
            placed.append({"item": item, "day": chosen})
            if first_blocker is None:
                reason = "First clear day"
            elif first_blocker.get("buffered"):
                reason = (f"Buffer overlap with {first_blocker['other']} "
                          f"at {first_blocker['loc']}")
            else:
                reason = (f"Clear of {first_blocker['other']} "
                          f"at {first_blocker['loc']}")
            picks.append({
                "activity_id": item["activity_id"], "week": week,
                "day": chosen, "day_name": DAY_NAMES[chosen],
                "source": "suggested", "reason": reason,
            })
        weeks.append(week)

    picks.sort(key=lambda pick: (pick["week"], pick["day"],
                                 pick["activity_id"]))
    return {"status": "ok", "engine": ENGINE, "strategy": strategy,
            "weeks": weeks, "picks": picks}
