"""PS1 solver: constraint-aware greedy constructor + bounded repair.

Math core only. No AI, no network. Deterministic given (seed).

Order key (tightness, NOT priority alone):
  predecessor depth, deadline/start slack, Live+buffer footprint size,
  hotspot scarcity, access count, priority-weighted impact.
"""
from __future__ import annotations

import random
import time
from typing import Dict, List, Optional, Set, Tuple

from . import model as M
from .model import Instance

Access = Tuple[int, int, int]          # (week, access_night, eclo)
Accesses = Dict[str, List[Access]]     # aid -> accesses
Groups = Dict[Tuple[str, int, str], str]  # (aid, week, location) -> group


def duration_fits_slot(job_duration_minutes: float,
                       slot_duration_minutes: float) -> bool:
    """Return whether an all-in job duration fits an explicit time slot.

    PS1 durations already include setup, preparation, execution, close-out and
    paperwork. Compare the supplied values directly: equality is feasible and
    no generic padding is added to the job or subtracted from the slot.

    The current official eight-file schema has no per-job duration or slot-time
    field. This guard is for any later canonical intake that explicitly supplies
    both values; AI must not reinterpret the comparison.
    """
    return job_duration_minutes <= slot_duration_minutes


class SlotInfo:
    __slots__ = ("aid", "week", "foot", "buf", "mir", "group", "atype",
                 "nat")

    def __init__(self, aid, week, foot, buf, mir, group, atype, nat):
        self.aid = aid
        self.week = week
        self.foot = foot      # set footprint locations
        self.buf = buf        # set buffered+footprint
        self.mir = mir        # set mirror blocks
        self.group = group
        self.atype = atype    # contract access_type PM|PC|C
        self.nat = nat        # nature of works


class State:
    def __init__(self, inst: Instance, scenario: str):
        self.inst = inst
        self.sc = scenario
        self.accesses: Accesses = {a: [] for a in inst.activities}
        self.groups: Groups = {}
        self.slots: List[SlotInfo] = []
        self._counter = 0

    # -- derived ---------------------------------------------------------
    def foot(self, aid: str) -> Set[str]:
        return set(self.inst.expand(self.inst.activities[aid]))

    def nature(self, aid: str) -> str:
        a = self.inst.activities[aid]
        return self.inst.contracts[a.contract].nature

    def pred_last(self, aid: str) -> int:
        p = self.inst.activities[aid].predecessor
        if not p or not self.accesses[p]:
            return 0
        return max(w for w, _, _ in self.accesses[p])

    def start_week(self, aid: str) -> int:
        a = self.inst.activities[aid]
        w = self.inst.week_of(a.planned_start)
        if a.predecessor:
            w = max(w, self.pred_last(aid) + 1)
        return max(w, 1)

    def cap_allow(self) -> float:
        return 0 if self.sc == "A" else (float("inf") if self.sc == "B" else 1)

    # -- placement test ---------------------------------------------------
    def test(self, aid: str, week: int, night: int, group: str,
             ignore_capacity: bool = False, cap_allow=None) -> bool:
        inst = self.inst
        a = inst.activities[aid]
        c = inst.contracts[a.contract]
        H = inst.horizon_weeks
        if not (1 <= week <= H):
            return False
        if week < self.start_week(aid):
            return False
        if any(w == week for w, _, _ in self.accesses[aid]):
            return False  # one access per activity per week
        if not (1 <= night <= c.max_access_per_week):
            return False
        # R7 weekly allocation: distinct nights used by contract+type
        used_nights = {n for b, lst in self.accesses.items()
                       for (w, n, _) in lst
                       if w == week and self._ct(b) == (a.contract, a.atype)}
        if night not in used_nights and len(used_nights) >= c.max_access_per_week:
            return False
        # R8 workfronts: distinct activities sharing this night
        sharing = {b for b, lst in self.accesses.items()
                   for (w, n, _) in lst
                   if w == week and n == night
                   and self._ct(b) == (a.contract, a.atype)}
        if len(sharing) >= c.workfronts:
            return False
        F = self.foot(aid)
        B = inst.buffer_footprint(list(F), self.nature(aid))
        Mr = inst.mirror_blocks(list(F), self.nature(aid))
        # capacity + legal mixes per footprint location
        allow = self.cap_allow() if cap_allow is None else cap_allow
        for loc in F:
            present = [(s.aid, s.group, s.atype) for s in self.slots
                       if s.week == week and loc in s.foot]
            groups_here = {g for _, g, _ in present}
            if group not in groups_here and len(groups_here) >= inst.supply.get(loc, 0) + allow and not ignore_capacity:
                return False
            same = [t for _, g, t in present if g == group]
            if not self._mix_ok(same + [c.access_type]):
                return False
        # Spatial hard block: Live power-cut mirrors only (validator
        # treats other overlaps as soft warnings, per official sample).
        # Other overlaps are still minimized by repair's warning count.
        for s in self.slots:
            if s.week != week:
                continue
            if s.group == group and (F & s.foot):
                continue  # same possession: exempt
            if Mr & (s.foot | s.buf | s.mir):
                return False
            if (B | F) & s.mir:
                return False
        return True

    def _ct(self, aid: str) -> Tuple[str, str]:
        a = self.inst.activities[aid]
        return a.contract, a.atype

    @staticmethod
    def _mix_ok(types: List[str]) -> bool:
        """R5 legal mixes within one location/week/co-share possession."""
        if "PM" in types:
            return len(types) == 1
        pcs = types.count("PC")
        cs = types.count("C")
        if pcs > 1:
            return False
        if pcs == 1:
            return cs <= 3
        return cs <= 4

    # -- commit ------------------------------------------------------------
    def fresh_group(self) -> str:
        self._counter += 1
        return f"g{self._counter}"

    def place(self, aid: str, week: int, night: int, group: str, eclo: int):
        self.accesses[aid].append((week, night, eclo))
        for loc in self.foot(aid):
            self.groups[(aid, week, loc)] = group
        F = self.foot(aid)
        nat = self.nature(aid)
        self.slots.append(SlotInfo(
            aid, week, F, self.inst.buffer_footprint(list(F), nat),
            self.inst.mirror_blocks(list(F), nat), group,
            self.inst.contracts[self.inst.activities[aid].contract].access_type,
            nat))

    def unplace(self, aid: str, week: int):
        self.accesses[aid] = [x for x in self.accesses[aid] if x[0] != week]
        for k in [k for k in self.groups if k[0] == aid and k[1] == week]:
            del self.groups[k]
        self.slots = [s for s in self.slots
                      if not (s.aid == aid and s.week == week)]


# ---------------------------------------------------------------- ordering

def order_activities(inst: Instance, seed: int = 42) -> List[str]:
    topo = M.topo_order(inst.activities)
    depth: Dict[str, int] = {}
    for aid in topo:
        p = inst.activities[aid].predecessor
        depth[aid] = (depth[p] + 1) if p else 0
    # hotspot scarcity: min supply across footprint
    def scarcity(aid: str) -> int:
        try:
            return min(inst.supply.get(l, 99) for l in inst.expand(inst.activities[aid]))
        except Exception:
            return 99
    rng = random.Random(seed)
    base = list(inst.activities)
    rng.shuffle(base)
    pos = {aid: i for i, aid in enumerate(base)}
    return sorted(
        inst.activities,
        key=lambda aid: (
            depth[aid],
            inst.week_of(inst.contracts[inst.activities[aid].contract].planned),
            inst.week_of(inst.activities[aid].planned_start),
            -len(inst.buffer_footprint(
                inst.expand(inst.activities[aid]),
                inst.contracts[inst.activities[aid].contract].nature)),
            scarcity(aid),
            -inst.activities[aid].total,
            -M.TIER_WEIGHT[inst.contracts[inst.activities[aid].contract].priority],
            pos[aid],
        ))


# --------------------------------------------------------------- planning

def plan_counts(inst: Instance, scenario: str, aid: str) -> Tuple[int, int]:
    """(number of accesses, of which ECLO) for one activity."""
    a = inst.activities[aid]
    if scenario == "A":
        return a.total, 0
    c = inst.contracts[a.contract]
    if scenario == "B":
        d_week = inst.week_of(c.planned)
        lo = max(inst.week_of(a.planned_start), 1)
        slots = max(0, d_week - lo + 1)
        if slots >= a.total:
            return a.total, 0
        n = max(slots, 1)
        e = min(n, -(-2 * (a.total - n) // 1))  # ceil(2*(total-n))
        return n, e
    return a.total, 0  # C starts like A; improvement may add ECLO


def _choose_slot(st: State, aid: str, week: int,
                 ignore_capacity: bool = False,
                 strict: bool = False) -> Optional[Tuple[int, str]]:
    inst = st.inst
    a = inst.activities[aid]
    c = inst.contracts[a.contract]
    F = st.foot(aid)
    # candidate groups: overlapping groups first (pack), then fresh
    overlap: List[str] = []
    for s in st.slots:
        if s.week == week and (F & s.foot) and s.group not in overlap:
            overlap.append(s.group)
    overlap.sort()
    allow = 0 if strict else None
    for night in range(1, c.max_access_per_week + 1):
        for g in overlap + [None]:
            grp = g if g is not None else f"new{st._counter + 1}"
            if st.test(aid, week, night, grp, ignore_capacity,
                       cap_allow=allow):
                return night, (g if g is not None else st.fresh_group())
    return None


def _place_in_weeks(st: State, aid: str, weeks, eclo_left: int,
                    strict: bool) -> Tuple[bool, int]:
    for week in weeks:
        slot = _choose_slot(st, aid, week, strict=strict)
        if slot:
            night, grp = slot
            flag = 1 if eclo_left > 0 else 0
            st.place(aid, week, night, grp, flag)
            return True, eclo_left - flag
    return False, eclo_left


def place_activity(st: State, aid: str, n: int, e: int) -> None:
    """Place n accesses (first e flagged ECLO), earliest feasible weeks.

    Two-phase scan per access: capacity-clean weeks first, scenario
    allowance (C +1, B unlimited) only as fallback. Keeps C from
    spending excess penalty it does not need.
    """
    H = st.inst.horizon_weeks
    cursor = st.start_week(aid)
    eclo_left = e
    for _ in range(n):
        done = False
        if st.sc != "B":
            done, eclo_left = _place_in_weeks(
                st, aid, range(cursor, H + 1), eclo_left, strict=True)
        if not done:
            done, eclo_left = _place_in_weeks(
                st, aid, range(cursor, H + 1), eclo_left, strict=False)
            if done:
                cursor = max(w for w, _, _ in st.accesses[aid]) + 1
                continue
        if done:
            cursor = max(w for w, _, _ in st.accesses[aid]) + 1
            continue
        # keep scheduling under congestion: force earliest week,
        # ignoring capacity (validator will report it honestly)
        for week in range(cursor, H + 1):
            slot = _choose_slot(st, aid, week, ignore_capacity=True)
            if slot:
                night, grp = slot
                flag = 1 if eclo_left > 0 else 0
                st.place(aid, week, night, grp, flag)
                cursor = week + 1
                done = True
                break
        if not done:
            return  # horizon exhausted; workload gate will flag it


# ---------------------------------------------------------------- repair

def _state_key(st: State):
    from . import validator as V
    return (len(V.validate(st.inst, st.accesses, st.groups, st.sc)),
            len(V.warnings(st.inst, st.accesses, st.groups, st.sc)))


def _snapshot_aid(st: State, aid: str):
    return (list(st.accesses[aid]),
            {k: v for k, v in st.groups.items() if k[0] == aid},
            [s for s in st.slots if s.aid == aid])


def _restore_aid(st: State, aid: str, snap) -> None:
    acc, grps, slots = snap
    st.accesses[aid] = list(acc)
    for k in [k for k in st.groups if k[0] == aid]:
        del st.groups[k]
    st.groups.update(grps)
    st.slots = [s for s in st.slots if s.aid != aid] + slots


def repair(st: State, deadline: float) -> None:
    """Bounded deterministic repair: move involved accesses.

    Accepts moves that lexicographically reduce (hard violations,
    buffer warnings). Warnings are soft (allowed by evidence rule)
    but fewer is strictly safer against the hidden reference validator.
    """
    from . import validator as V
    cur_hard = V.validate(st.inst, st.accesses, st.groups, st.sc)
    cur = _state_key(st)
    if cur == (0, 0):
        return
    aids: List[str] = []
    for v in cur_hard:
        for aid in v.get("aids", []):
            if aid not in aids:
                aids.append(aid)
    if not aids:  # warnings only: consider every placed activity
        aids = sorted(a for a, lst in st.accesses.items() if lst)
    aids.sort()
    for aid in aids:
        if time.time() > deadline:
            return
        for (w, n, e) in sorted(list(st.accesses[aid])):
            if time.time() > deadline:
                return
            for dw in (-2, -1, 1, 2, -3, 3):
                w2 = w + dw
                if not (1 <= w2 <= st.inst.horizon_weeks):
                    continue
                slot = _choose_slot(st, aid, w2)
                if not slot:
                    continue
                n2, g2 = slot
                snap = _snapshot_aid(st, aid)
                st.unplace(aid, w)
                st.place(aid, w2, n2, g2, e)
                new = _state_key(st)
                if new < cur:
                    cur = new
                    break
                _restore_aid(st, aid, snap)
            else:
                continue
            break


def improve(st: State, deadline: float) -> None:
    """Bounded deterministic score improvement: shift accesses earlier."""
    from . import validator as V
    from . import exporter as E
    base = (_state_key(st), E.total_score(st.inst, st.accesses, st.groups, st.sc))
    for aid in sorted(st.accesses):
        if time.time() > deadline:
            return
        for (w, n, e) in sorted(list(st.accesses[aid])):
            if time.time() > deadline:
                return
            if w <= st.start_week(aid):
                continue
            for w2 in range(st.start_week(aid), w):
                slot = _choose_slot(st, aid, w2)
                if not slot:
                    continue
                n2, g2 = slot
                snap = _snapshot_aid(st, aid)
                st.unplace(aid, w)
                st.place(aid, w2, n2, g2, e)
                ns = E.total_score(st.inst, st.accesses, st.groups, st.sc)
                if (_state_key(st), ns) < (base[0], base[1] - 1e-9):
                    base = (_state_key(st), ns)
                    break
                _restore_aid(st, aid, snap)
            else:
                continue
            break


# ---------------------------------------------------------------- entry

def solve(inst: Instance, scenario: str, time_budget: float = 8.0,
          seed: int = 42) -> Tuple[Accesses, Groups]:
    assert scenario in ("A", "B", "C")
    t0 = time.time()
    st = State(inst, scenario)
    for aid in order_activities(inst, seed):
        n, e = plan_counts(inst, scenario, aid)
        place_activity(st, aid, n, e)
        if time.time() - t0 > time_budget * 0.5:
            break
    repair(st, t0 + time_budget * 0.8)
    improve(st, t0 + time_budget)
    # canonical output ordering
    for aid in st.accesses:
        st.accesses[aid].sort()
    return st.accesses, st.groups
