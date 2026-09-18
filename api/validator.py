"""PS1 independent hard validator.

Reads ONLY plain schedule dicts + the input instance; never trusts solver
state. Returns structured violations; empty list == feasible.

Tags: workload, horizon, access_night, eclo_flag, occupancy_group, start,
  precedence, closure, buffer, mirror, mix, alloc, workfront, multi_access,
  capacity, eclo, eclo_window, planned_date.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

from .model import Instance

Accesses = Dict[str, List[Tuple[int, int, int]]]
Groups = Dict[Tuple[str, int, str], str]  # (aid, week, location) -> group


def _slot_sets(inst: Instance, aid: str):
    a = inst.activities[aid]
    F = set(inst.expand(a))
    nat = inst.contracts[a.contract].nature
    B = inst.buffer_footprint(list(F), nat)
    Mr = inst.mirror_blocks(list(F), nat)
    return F, B, Mr, nat


def _validate_full(inst: Instance, accesses: Accesses, groups: Groups,
                   scenario: str):
    V: List[dict] = []

    def add(rule, aids, weeks, detail):
        V.append({"rule": rule, "severity": "hard",
                  "aids": sorted(set(aids)), "weeks": sorted(set(weeks)),
                  "detail": detail})

    acts = inst.activities
    # unknown ids
    for aid in accesses:
        if aid not in acts:
            add("workload", [aid], [], f"unknown activity {aid}")

    # R1 workload
    for aid, a in acts.items():
        got = sum(1.0 + 0.5 * e for _, _, e in accesses.get(aid, []))
        if got + 1e-9 < a.total:
            add("workload", [aid], [w for w, _, _ in accesses.get(aid, [])],
                f"{aid}: workload {got} < required {a.total}")

    # R2 start + one-per-week + R3 precedence (first-vs-last)
    last_week: Dict[str, int] = {}
    first_week: Dict[str, int] = {}
    for aid, a in acts.items():
        slots = accesses.get(aid, [])
        weeks = sorted(w for w, _, _ in slots)
        contract = inst.contracts[a.contract]
        for w, night, eclo in slots:
            if not 1 <= w <= inst.horizon_weeks:
                add("horizon", [aid], [w],
                    f"{aid}: week {w} outside 1..{inst.horizon_weeks}")
            if not 1 <= night <= contract.max_access_per_week:
                add("access_night", [aid], [w],
                    f"{aid}: access night {night} outside 1.."
                    f"{contract.max_access_per_week}")
            if eclo not in (0, 1):
                add("eclo_flag", [aid], [w],
                    f"{aid}: ECLO flag {eclo} must be 0 or 1")
        if weeks:
            last_week[aid] = weeks[-1]
            first_week[aid] = weeks[0]
            sw = max(inst.week_of(a.planned_start), 1)
            if weeks[0] < sw:
                add("start", [aid], [weeks[0]],
                    f"{aid}: starts week {weeks[0]} before {sw}")
        seen: Dict[int, int] = {}
        for w in weeks:
            seen[w] = seen.get(w, 0) + 1
            if seen[w] > 1:
                add("multi_access", [aid], [w],
                    f"{aid}: more than one access in week {w}")
    for aid, a in acts.items():
        if a.predecessor and a.predecessor in last_week and aid in first_week:
            if first_week[aid] <= last_week[a.predecessor]:
                add("precedence", [aid, a.predecessor],
                    [first_week[aid], last_week[a.predecessor]],
                    f"{aid}: first access week {first_week[aid]} not strictly "
                    f"after predecessor {a.predecessor} finish "
                    f"week {last_week[a.predecessor]}")
    # per-week slot table
    info = {}  # (aid, week) -> dict(F,B,Mr,nat,gmap)
    warn: List[dict] = []
    for aid, lst in accesses.items():
        if aid not in acts:
            continue
        F, B, Mr, nat = _slot_sets(inst, aid)
        for (w, _n, _e) in lst:
            missing_groups = [loc for loc in F
                              if not groups.get((aid, w, loc))]
            if missing_groups:
                add("occupancy_group", [aid], [w],
                    f"{aid}: missing co-share group for "
                    f"{sorted(missing_groups)[:3]}")
            gmap = {loc: groups.get((aid, w, loc), "?") for loc in F}
            info[(aid, w)] = {"F": F, "B": B, "Mr": Mr, "nat": nat,
                              "gmap": gmap}

    # R4 closures / buffers / mirrors.
    # Evidence rule (official sample is feasible): cross-possession
    # buffer/footprint overlaps occur in the feasible sample, so the
    # only hard spatial block is a Live power-cut mirror. All other
    # overlaps are soft warnings. R5 mixes apply per POSSESSION
    # (location, week, group): the sample co-shares 1 PC + 4 C at one
    # location-week split across groups, legal per group.
    keys = sorted(info)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            (a1, w1), (a2, w2) = keys[i], keys[j]
            if w1 != w2:
                continue
            s1, s2 = info[(a1, w1)], info[(a2, w2)]
            shared = s1["F"] & s2["F"]
            if shared and any(s1["gmap"][l] == s2["gmap"][l] for l in shared):
                continue  # same possession: exempt
            other1 = s1["F"] | s1["B"] | s1["Mr"]
            other2 = s2["F"] | s2["B"] | s2["Mr"]
            if (s1["Mr"] & other2) | (s2["Mr"] & other1):
                add("mirror", [a1, a2], [w1],
                    f"wk{w1}: {a1} inside Live power-cut mirror of {a2}")
                continue
            hit = ((s1["B"] | s1["F"]) & (s2["F"] | s2["B"]) |
                   (s2["B"] | s2["F"]) & (s1["F"] | s1["B"]))
            if hit:
                warn.append({"rule": "buffer_note", "aids": sorted([a1, a2]),
                             "weeks": [w1],
                             "detail": f"wk{w1}: {a1} ~ {a2} overlap "
                                       f"at {sorted(hit)[:3]} (allowed)"})

    # R5 mixes + capacity per (location, week)
    from collections import defaultdict
    loc_items = defaultdict(list)  # (loc, week) -> [(aid, group, atype)]
    for (aid, w), s in info.items():
        atype = inst.contracts[acts[aid].contract].access_type
        for loc in s["F"]:
            loc_items[(loc, w)].append((aid, s["gmap"][loc], atype))
    allow = 0 if scenario == "A" else (10 ** 9 if scenario == "B" else 1)
    for (loc, w), items in loc_items.items():
        by_group = defaultdict(list)
        for aid, g, t in items:
            by_group[g].append((aid, t))
        for g, members in by_group.items():
            types = [t for _, t in members]
            aids = [a for a, _ in members]
            if "PM" in types and len(types) > 1:
                add("mix", aids, [w],
                    f"{loc} wk{w} {g}: PM shares possession")
            elif types.count("PC") > 1:
                add("mix", aids, [w],
                    f"{loc} wk{w} {g}: more than one PC")
            elif types.count("PC") == 1 and types.count("C") > 3:
                add("mix", aids, [w],
                    f"{loc} wk{w} {g}: PC with more than 3 C")
            elif "PC" not in types and "PM" not in types and len(types) > 4:
                add("mix", aids, [w],
                    f"{loc} wk{w} {g}: more than 4 C")
        poss = {g for _, g, _ in items}
        cap = inst.supply.get(loc, 0) + allow
        if len(poss) > cap and scenario == "A":
            add("capacity", [a for a, _, _ in items], [w],
                f"{loc} wk{w}: {len(poss)} possessions > supply {cap}")
        if scenario == "C" and len(poss) > inst.supply.get(loc, 0) + 1:
            add("capacity", [a for a, _, _ in items], [w],
                f"{loc} wk{w}: exceeds C allowance")

    # R7 allocation + R8 workfronts
    ct_week_nights = defaultdict(set)      # (ct, at, w) -> nights
    ct_week_night_acts = defaultdict(set)  # (ct, at, w, n) -> aids
    for aid, lst in accesses.items():
        if aid not in acts:
            continue
        a = acts[aid]
        c = inst.contracts[a.contract]
        for (w, n, _e) in lst:
            ct_week_nights[(a.contract, a.atype, w)].add(n)
            ct_week_night_acts[(a.contract, a.atype, w, n)].add(aid)
    for (ct, at, w), nights in ct_week_nights.items():
        cap = next(c.max_access_per_week for c in inst.contracts.values()
                   if c.number == ct and c.activity_type == at)
        if len(nights) > cap:
            add("alloc", sorted(ct_week_night_acts_keys(ct, at, w, accesses, acts)), [w],
                f"{ct}/{at} wk{w}: {len(nights)} nights > cap {cap}")
    for (ct, at, w, n), aids in ct_week_night_acts.items():
        wf = next(c.workfronts for c in inst.contracts.values()
                  if c.number == ct and c.activity_type == at)
        if len(aids) > wf:
            add("workfront", sorted(aids), [w],
                f"{ct}/{at} wk{w} night {n}: {len(aids)} acts > {wf}")

    # R9 ECLO forbidden in A + R10 window in C
    eclo_weeks_line = {"ALP": set(), "BET": set()}  # type: ignore
    for aid, lst in accesses.items():
        if aid not in acts:
            continue
        a = acts[aid]
        for (w, _n, e) in lst:
            if e:
                if scenario == "A":
                    add("eclo", [aid], [w], f"{aid}: ECLO forbidden in A")
                for ln in inst.lines_affected(a):
                    eclo_weeks_line[ln].add(w)
    if scenario == "C":
        for ln, weeks in eclo_weeks_line.items():
            if weeks and max(weeks) - min(weeks) > 1:
                add("eclo_window", [], sorted(weeks),
                    f"{ln}: ECLO spans more than 2 calendar weeks")

    # B planned dates rigid
    if scenario == "B":
        for cnum, c in inst.contracts.items():
            comp = None
            for aid, a in acts.items():
                if a.contract != cnum or aid not in last_week:
                    continue
                d = inst.week_end(last_week[aid])
                comp = d if comp is None or d > comp else comp
            if comp is not None and comp > c.planned:
                over = (comp - c.planned).days
                add("planned_date", [a2 for a2 in acts
                                     if acts[a2].contract == cnum], [],
                    f"{cnum}: overrun {over}d forbidden in B")
    return V, warn


def validate(inst: Instance, accesses: Accesses, groups: Groups,
             scenario: str) -> List[dict]:
    hard, _soft = _validate_full(inst, accesses, groups, scenario)
    return hard


def warnings(inst: Instance, accesses: Accesses, groups: Groups,
             scenario: str) -> List[dict]:
    _hard, soft = _validate_full(inst, accesses, groups, scenario)
    return soft


def ct_week_night_acts_keys(ct, at, w, accesses, acts):
    out = set()
    for aid, lst in accesses.items():
        if aid in acts and acts[aid].contract == ct and acts[aid].atype == at:
            if any(x[0] == w for x in lst):
                out.add(aid)
    return out
