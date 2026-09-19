"""PS1 shared model: parsing, week math, expansion, buffers, mirrors.

Single source of truth for solver, validator and exporter so the three
can never disagree on occupancy expansion (Codex risk #2).

Assumptions (documented and shared by solver/validator/exporter):
  A1 buffer geometry is computed for every possession. Same-week actual
     footprint overlaps across different contracts are hard closure conflicts;
     buffer-only ambiguity remains warning-level because the published
     zero-violation sample contains it under the literal expansion, despite the
     README calling buffers hard. Live mirrors remain hard.
  A2 Live mirror: a Live access blocks its mirrored footprint on the
     opposite bound plus the other line's H01_H02 tunnels and H01/H02
     platforms (all bounds) for that week. Full block, no entry.
  A3 ECLO window (scenario C): weeks are schedule weeks; an activity
     "affects" its footprint lines plus (both lines if Live).
"""
from __future__ import annotations

import csv
import os
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Dict, List, Optional, Set, Tuple


# ---------------------------------------------------------------- parsing

def _read_csv(path: str) -> List[Dict[str, str]]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _parse_date(s: str) -> date:
    return date.fromisoformat(s.strip())


# ------------------------------------------------------------- data model

@dataclass
class Sector:
    sector_id: str
    line: str
    frm: str
    to: str
    seq: int


@dataclass
class Contract:
    number: str
    activity_type: str
    nature: str            # Live | Non-live (Consist) | Non-live (Others)
    priority: int          # contract_priority 1..3
    completion: date       # contract_completion_date (contractual)
    planned: date          # planned_completion_date (target)
    workfronts: int
    access_type: str       # PM | PC | C
    max_access_per_week: int


@dataclass
class Activity:
    aid: str
    contract: str
    atype: str
    start_loc: str
    end_loc: str
    total: int
    planned_start: date
    predecessor: Optional[str]
    priority: int          # activity_priority 1..3


@dataclass
class Instance:
    lines: List[str]
    stations: Dict[str, dict]             # station_id -> {line, seq, interchange}
    sectors: Dict[str, Sector]            # sector_id -> Sector
    sectors_by_seq: Dict[Tuple[str, int], Sector]
    supply: Dict[str, int]                # location_id -> capacity per week
    buffers: Dict[str, Tuple[int, int]]   # nature -> (sectors, opposite_bound)
    horizon_start: date
    horizon_weeks: int
    contracts: Dict[str, Contract]
    activities: Dict[str, Activity]

    # -- week math ------------------------------------------------------
    def week_of(self, d: date) -> int:
        return (d - self.horizon_start).days // 7 + 1

    def week_end(self, week: int) -> date:
        """Simulated completion date convention: last day of schedule week."""
        return self.horizon_start + timedelta(days=7 * week - 1)

    def week_start(self, week: int) -> date:
        return self.horizon_start + timedelta(days=7 * (week - 1))

    # -- location helpers -----------------------------------------------
    @staticmethod
    def split_loc(loc: str) -> Tuple[str, str, str, str]:
        """(kind, line, middle, bound) e.g. SEC:ALP:S03_S04:EB."""
        kind, line, middle, bound = loc.split(":")
        return kind, line, middle, bound

    def expand(self, act: Activity) -> List[str]:
        """Full location footprint: every tunnel + platform sector touched.

        Walks sector seq from start to end sector (either direction),
        collecting tunnel sectors plus every station platform on the path.
        """
        _, sline, smid, bound = self.split_loc(act.start_loc)
        _, eline, emid, ebound = self.split_loc(act.end_loc)
        if sline != eline or bound != ebound:
            raise ValueError(f"{act.aid}: cross-line/bound span unsupported")
        s_sec = self._endpoint_sector(act.start_loc)
        e_sec = self._endpoint_sector(act.end_loc)
        lo, hi = sorted((s_sec.seq, e_sec.seq))
        out: List[str] = []
        plats: List[str] = []
        for seq in range(lo, hi + 1):
            sec = self.sectors_by_seq[(sline, seq)]
            out.append(f"{sec.sector_id}:{bound}")
            for st in (sec.frm, sec.to):
                p = f"PLAT:{sline}:{st}:{bound}"
                if p not in plats:
                    plats.append(p)
        return out + plats

    def _endpoint_sector(self, loc: str) -> Sector:
        kind, line, middle, _ = self.split_loc(loc)
        if kind == "SEC":
            for sec in self.sectors.values():
                if sec.line == line and f"{sec.frm}_{sec.to}" == middle:
                    return sec
            raise ValueError(f"unknown sector endpoint {loc}")
        # PLAT endpoint: nearest sector touching that station on the line
        cands = [s for s in self.sectors.values()
                 if s.line == line and middle in (s.frm, s.to)]
        if not cands:
            raise ValueError(f"unknown platform endpoint {loc}")
        return sorted(cands, key=lambda s: s.seq)[0]

    def buffer_footprint(self, footprint: List[str], nature: str) -> Set[str]:
        """Footprint plus exclusion-zone sectors (same bound, along seq)."""
        reach, _mirror = self.buffers[nature]
        blocked = set(footprint)
        if reach == 0:
            return blocked
        for loc in footprint:
            kind, line, middle, bound = self.split_loc(loc)
            if kind != "SEC":
                continue
            sec = next(s for s in self.sectors.values()
                       if s.line == line and f"{s.frm}_{s.to}" == middle)
            for seq in range(sec.seq - reach, sec.seq + reach + 1):
                other = self.sectors_by_seq.get((line, seq))
                if other is not None:
                    blocked.add(f"{other.sector_id}:{bound}")
        return blocked

    def mirror_blocks(self, footprint: List[str], nature: str) -> Set[str]:
        """A2: sectors fully closed by Live mirroring / crossover."""
        if nature != "Live":
            return set()
        blocked: Set[str] = set()
        lines = {self.split_loc(l)[1] for l in footprint}
        for loc in self.buffer_footprint(footprint, nature):
            kind, line, middle, bound = self.split_loc(loc)
            opp = "WB" if bound == "EB" else "EB"
            blocked.add(f"{kind}:{line}:{middle}:{opp}")
        for line in lines:
            other = "BET" if line == "ALP" else "ALP"
            for b in ("EB", "WB"):
                blocked.add(f"SEC:{other}:H01_H02:{b}")
                blocked.add(f"PLAT:{other}:H01:{b}")
                blocked.add(f"PLAT:{other}:H02:{b}")
                blocked.add(f"PLAT:{line}:H01:{b}")
                blocked.add(f"PLAT:{line}:H02:{b}")
        return blocked

    def lines_affected(self, act: Activity) -> Set[str]:
        """A3: footprint lines plus both lines if Live."""
        _, line, _, _ = self.split_loc(act.start_loc)
        nat = self.contracts[act.contract].nature
        return {"ALP", "BET"} if nat == "Live" else {line}


# ---------------------------------------------------------------- loading

REQUIRED_FILES = ["01_LINES.csv", "02_STATIONS.csv", "03_SECTORS.csv",
                  "04_LOCATION_SUPPLY.csv", "05_BUFFER_LOCATION.csv",
                  "06_PARAMETERS.csv", "07_PROJECT_DETAILS.csv",
                  "08_ACTIVITY_DETAILS.csv"]


def load_instance(data_dir: str) -> Instance:
    missing = [f for f in REQUIRED_FILES
               if not os.path.exists(os.path.join(data_dir, f))]
    if missing:
        raise ValueError(f"missing instance files: {missing}")
    g = lambda n: _read_csv(os.path.join(data_dir, n))

    lines = [r["line_code"] for r in g("01_LINES.csv")]
    stations = {r["station_id"]: {"line": r["line_code"], "seq": int(r["seq"]),
                                  "interchange": r["is_interchange"] == "1"}
                for r in g("02_STATIONS.csv")}
    sectors, by_seq = {}, {}
    for r in g("03_SECTORS.csv"):
        s = Sector(r["sector_id"], r["line_code"], r["from_station_id"],
                   r["to_station_id"], int(r["seq"]))
        sectors[s.sector_id] = s
        by_seq[(s.line, s.seq)] = s
    supply = {r["location_id"]: int(r["supply_capacity"])
              for r in g("04_LOCATION_SUPPLY.csv")}
    buffers = {r["nature_of_works"]: (int(r["up_to_buffer_sectors"]),
                                      int(r["opposite_bound_required"]))
               for r in g("05_BUFFER_LOCATION.csv")}
    params = {r["key"]: r["value"] for r in g("06_PARAMETERS.csv")}
    contracts = {}
    for r in g("07_PROJECT_DETAILS.csv"):
        contracts[r["contract_number"]] = Contract(
            r["contract_number"], r["activity_type"], r["nature_of_activity"],
            int(r["contract_priority"]), _parse_date(r["contract_completion_date"]),
            _parse_date(r["planned_completion_date"]), int(r["number_of_workfronts"]),
            r["access_type"], int(r["number_of_maximum_access_per_week"]))
    activities = {}
    for r in g("08_ACTIVITY_DETAILS.csv"):
        activities[r["activity_id"]] = Activity(
            r["activity_id"], r["contract_number"], r["activity_type"],
            r["start_location_id"], r["end_location_id"],
            int(r["total_accesses"]), _parse_date(r["planned_start_date"]),
            r["predecessor_activity_id"].strip() or None,
            int(r["activity_priority"]))

    # FK + sanity checks
    for a in activities.values():
        if a.contract not in contracts:
            raise ValueError(f"{a.aid}: unknown contract {a.contract}")
        if a.predecessor and a.predecessor not in activities:
            raise ValueError(f"{a.aid}: unknown predecessor {a.predecessor}")
    if _has_cycle(activities):
        raise ValueError("predecessor links contain a cycle")

    return Instance(lines, stations, sectors, by_seq, supply, buffers,
                    _parse_date(params["horizon_start"]),
                    int(params["horizon_weeks"]), contracts, activities)


def _has_cycle(activities: Dict[str, Activity]) -> bool:
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {k: WHITE for k in activities}

    def visit(u: str) -> bool:
        color[u] = GRAY
        p = activities[u].predecessor
        if p:
            if color[p] == GRAY:
                return True
            if color[p] == WHITE and visit(p):
                return True
        color[u] = BLACK
        return False

    return any(color[k] == WHITE and visit(k) for k in activities)


def topo_order(activities: Dict[str, Activity]) -> List[str]:
    """Predecessors before successors (Kahn, deterministic by aid)."""
    indeg = {k: 0 for k in activities}
    succ: Dict[str, List[str]] = {k: [] for k in activities}
    for a in activities.values():
        if a.predecessor:
            indeg[a.aid] += 1
            succ[a.predecessor].append(a.aid)
    ready = sorted([k for k, d in indeg.items() if d == 0])
    out = []
    while ready:
        u = ready.pop(0)
        out.append(u)
        for v in sorted(succ[u]):
            indeg[v] -= 1
            if indeg[v] == 0:
                ready.append(v)
        ready.sort()
    if len(out) != len(activities):
        raise ValueError("predecessor cycle detected")
    return out


# ---------------------------------------------------------------- scoring

TIER_WEIGHT = {1: 100.0, 2: 10.0, 3: 1.0}
ACT_NUDGE = {1: 0.3, 2: 0.2, 3: 0.0}


def activity_overrun_days(inst: Instance, act: Activity,
                          last_week: int) -> int:
    comp = inst.week_end(last_week)
    planned = inst.contracts[act.contract].planned
    return max(0, (comp - planned).days)
