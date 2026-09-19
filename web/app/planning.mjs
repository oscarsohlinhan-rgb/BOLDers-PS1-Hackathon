/**
 * Project TAO — Planning utilities
 * Pure JavaScript, no dependencies. Exports:
 * - parseCsv: robust CSV state-machine parser (quoted commas, doubled quotes)
 * - selectBestPolicy: picks feasible policy with lowest official objective_score
 * - buildPlanningModel: joins canonical inputs/outputs into a planning model
 * - formatWeekStart: derives calendar label from horizon_start + week offset
 */

const EXPECTED_INPUTS = [
  "01_LINES.csv",
  "02_STATIONS.csv",
  "03_SECTORS.csv",
  "04_LOCATION_SUPPLY.csv",
  "05_BUFFER_LOCATION.csv",
  "06_PARAMETERS.csv",
  "07_PROJECT_DETAILS.csv",
  "08_ACTIVITY_DETAILS.csv",
];

const EXPECTED_OUTPUTS = [
  "SCHEDULE_ACCESS.csv",
  "SCHEDULE_OCCUPANCY.csv",
];

/**
 * Robust CSV parser using a finite state machine.
 * Handles:
 * - Quoted fields with embedded commas
 * - Doubled quotes inside quoted fields ("" -> ")
 * - Unquoted fields
 * - CRLF and LF line endings
 * - Empty fields
 */
export function parseCsv(text) {
  if (!text || typeof text !== "string") return [];

  const rows = [];
  let field = "";
  const fields = [];
  let inQuotes = false;
  let i = 0;

  function pushField() {
    fields.push(field);
    field = "";
  }

  function pushRow() {
    if (fields.length > 0 || field !== "") {
      pushField();
      rows.push(fields.slice());
      fields.length = 0;
    }
  }

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        pushField();
      } else if (ch === "\r") {
        if (next === "\n") i++;
        pushRow();
      } else if (ch === "\n") {
        pushRow();
      } else {
        field += ch;
      }
    }
    i++;
  }

  pushRow();

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1);

  return dataRows.map((row) => {
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j] !== undefined ? row[j] : "";
    }
    return obj;
  });
}

/**
 * Select the best policy from solver results.
 * Returns the policy key (e.g., "A", "B", "C") of the feasible policy
 * with the lowest official objective_score.
 * If feasible policies exist but none carries a numeric score, returns
 * the first feasible policy. If no policy is feasible, returns the first
 * policy key.
 */
export function selectBestPolicy(results) {
  const policies = Object.keys(results);
  if (policies.length === 0) return null;

  let bestPolicy = null;
  let bestScore = Infinity;

  for (const policy of policies) {
    const result = results[policy];
    const report = result?.report;
    if (!report) continue;

    if (report.feasible === true) {
      const score = report.soft_scores?.objective_score;
      if (typeof score === "number" && score < bestScore) {
        bestScore = score;
        bestPolicy = policy;
      }
    }
  }

  if (bestPolicy !== null) return bestPolicy;

  for (const policy of policies) {
    if (results[policy]?.report?.feasible === true) return policy;
  }

  // No feasible policy — return first as fallback
  return policies[0];
}

/**
 * Build a planning model from canonical input and output CSV text.
 * Returns an object with:
 * - horizonStart: string (ISO date from 06_PARAMETERS)
 * - horizonWeeks: number (from 06_PARAMETERS)
 * - lines: array of { line_code, line_name, stations[], sectors[] }
 * - activities: array of { activity_id, contract_number, activity_type, startWeek, endWeek, accesses[], occupiedLocations[] }
 */
export function buildPlanningModel(inputs, outputs) {
  // Parse all CSV text
  const parsedInputs = {};
  for (const name of EXPECTED_INPUTS) {
    if (inputs[name]) {
      parsedInputs[name] = parseCsv(inputs[name]);
    }
  }
  const parsedOutputs = {};
  for (const name of EXPECTED_OUTPUTS) {
    if (outputs[name]) {
      parsedOutputs[name] = parseCsv(outputs[name]);
    }
  }

  // Horizon from 06_PARAMETERS
  let horizonStart = "2027-01-04";
  let horizonWeeks = 30;
  const params = parsedInputs["06_PARAMETERS.csv"] || [];
  for (const row of params) {
    if (row.key === "horizon_start") horizonStart = row.value;
    if (row.key === "horizon_weeks") horizonWeeks = parseInt(row.value, 10) || 30;
  }

  // Build line topology: lines -> stations (sorted by seq) -> sectors
  const linesMap = new Map();
  const linesData = parsedInputs["01_LINES.csv"] || [];
  for (const row of linesData) {
    linesMap.set(row.line_code, {
      line_code: row.line_code,
      line_name: row.line_name,
      stations: [],
      sectors: [],
    });
  }

  const stationsData = parsedInputs["02_STATIONS.csv"] || [];
  const stationsByLine = new Map();
  for (const row of stationsData) {
    const lineCode = row.line_code;
    if (!stationsByLine.has(lineCode)) stationsByLine.set(lineCode, []);
    stationsByLine.get(lineCode).push({
      station_id: row.station_id,
      seq: parseInt(row.seq, 10) || 0,
      is_interchange: row.is_interchange === "1" || row.is_interchange === "true",
    });
  }
  for (const [lineCode, stations] of stationsByLine) {
    stations.sort((a, b) => a.seq - b.seq);
    if (linesMap.has(lineCode)) {
      linesMap.get(lineCode).stations = stations;
    }
  }

  const sectorsData = parsedInputs["03_SECTORS.csv"] || [];
  for (const row of sectorsData) {
    const lineCode = row.line_code;
    if (linesMap.has(lineCode)) {
      linesMap.get(lineCode).sectors.push({
        sector_id: row.sector_id,
        from_station_id: row.from_station_id,
        to_station_id: row.to_station_id,
        seq: parseInt(row.seq, 10) || 0,
        is_shared: row.is_shared === "1" || row.is_shared === "true",
      });
    }
  }
  for (const line of linesMap.values()) {
    line.sectors.sort((a, b) => a.seq - b.seq);
  }

  const lines = Array.from(linesMap.values()).sort((a, b) => a.line_code.localeCompare(b.line_code));

  // Activities from 08_ACTIVITY_DETAILS + SCHEDULE_ACCESS + SCHEDULE_OCCUPANCY
  const activitiesData = parsedInputs["08_ACTIVITY_DETAILS.csv"] || [];
  const accessData = parsedOutputs["SCHEDULE_ACCESS.csv"] || [];
  const occupancyData = parsedOutputs["SCHEDULE_OCCUPANCY.csv"] || [];

  // Group accesses by activity_id
  const accessesByActivity = new Map();
  for (const row of accessData) {
    const aid = row.activity_id;
    if (!accessesByActivity.has(aid)) accessesByActivity.set(aid, []);
    accessesByActivity.get(aid).push({
      access_seq: parseInt(row.access_seq, 10) || 0,
      week: parseInt(row.week, 10) || 0,
      eclo: row.eclo === "1" || row.eclo === "true",
      access_night: parseInt(row.access_night, 10) || 0,
    });
  }
  for (const accesses of accessesByActivity.values()) {
    accesses.sort((a, b) => a.access_seq - b.access_seq);
  }

  // Group occupied locations by activity_id, preserving order of first appearance
  const occupiedByActivity = new Map();
  for (const row of occupancyData) {
    const aid = row.activity_id;
    if (!occupiedByActivity.has(aid)) occupiedByActivity.set(aid, []);
    const arr = occupiedByActivity.get(aid);
    if (!arr.includes(row.location_id)) arr.push(row.location_id);
  }

  const activities = [];
  for (const row of activitiesData) {
    const aid = row.activity_id;
    const accesses = accessesByActivity.get(aid) || [];
    const occupiedList = occupiedByActivity.get(aid) || [];

    // Determine start/end week from accesses
    const weeks = accesses.map((a) => a.week).filter((w) => w > 0);
    const startWeek = weeks.length > 0 ? Math.min(...weeks) : 0;
    const endWeek = weeks.length > 0 ? Math.max(...weeks) : 0;

    activities.push({
      activity_id: aid,
      contract_number: row.contract_number,
      activity_type: row.activity_type,
      start_location_id: row.start_location_id,
      end_location_id: row.end_location_id,
      total_accesses: parseInt(row.total_accesses, 10) || 0,
      planned_start_date: row.planned_start_date,
      predecessor_activity_id: row.predecessor_activity_id,
      activity_priority: parseInt(row.activity_priority, 10) || 0,
      startWeek,
      endWeek,
      accesses,
      occupiedLocations: occupiedList,
    });
  }

  return {
    horizonStart,
    horizonWeeks,
    lines,
    activities,
  };
}

/**
 * Deterministic weekday recommender for the day-planning overlay.
 * The solver's schedule never fixes a calendar day, so preferred workdays are
 * user-side planning notes only. This function suggests them with fixed,
 * explainable job-type rules — never AI judgment:
 * 1. Higher-priority contracts first (contract tier 1 before 2 before 3,
 *    mirroring the official overrun-weight bands).
 * 2. Larger safety footprints first (Live before Non-live (Consist) before
 *    Non-live (Others)).
 * 3. Harder possessions first (sole PM before PC master before C co-worker).
 * 4. Earliest access, then activity id — fully deterministic ties.
 * Sorted candidates are dealt across Mon..Sun round-robin (index 0..6), so
 * bigger weeks spread and small weeks front-load. Callers must exclude
 * user-picked notes beforehand; suggestions never overwrite them.
 */
export const DAY_NATURE_ORDER = {
  Live: 0,
  "Non-live (Consist)": 1,
  "Non-live (Others)": 2,
};

export const DAY_ACCESS_ORDER = { PM: 0, PC: 1, C: 2 };

export const DAY_BUFFER_RADIUS = { Live: 2, "Non-live (Consist)": 1 };

/** Index 03_SECTORS rows by sector_id for buffer-halo expansion. */
export function buildSectorIndex(sectors) {
  const byId = new Map();
  for (const row of sectors || []) {
    if (!row.sector_id) continue;
    byId.set(row.sector_id, {
      line: row.line_code || "",
      bound: String(row.sector_id).split(":").pop(),
      seq: parseInt(row.seq, 10) || 0,
    });
  }
  return byId;
}

const mirroredLocation = (id) => {
  if (id.endsWith(":EB")) return id.slice(0, -3) + ":WB";
  if (id.endsWith(":WB")) return id.slice(0, -3) + ":EB";
  return null;
};

/**
 * Booked locations plus the exclusion-buffer halo around them: Live reaches
 * 2 sectors both sides (and mirrors onto the opposite bound), Non-live
 * (Consist) reaches 1 sector, anything else stays on its booked locations.
 * Only one work may use a halo location per night, so halo overlap means
 * different weekdays — except co-sharers of the exact same possession, which
 * the rules keep buffer-free against each other.
 */
export function bufferedFootprint(locations, nature, sectorIndex) {
  const halo = new Set(locations || []);
  const radius = DAY_BUFFER_RADIUS[nature] || 0;
  if (radius > 0 && sectorIndex) {
    for (const loc of locations || []) {
      const info = sectorIndex.get(loc);
      if (!info) continue;
      for (const [id, other] of sectorIndex) {
        if (
          other.line === info.line &&
          other.bound === info.bound &&
          Math.abs(other.seq - info.seq) <= radius
        ) {
          halo.add(id);
        }
      }
    }
  }
  if (nature === "Live") {
    for (const loc of [...halo]) {
      const mirror = mirroredLocation(loc);
      if (mirror) halo.add(mirror);
    }
  }
  return halo;
}

const possessionOf = (item, location) => {
  const group =
    item.groups != null ? item.groups[location] : undefined;
  if (group == null || group === "") return `@@${item.key}|${location}`;
  return String(group);
};

/**
 * Constraint-aware weekday recommender (same honesty contract as above).
 * Beyond the priority/type ordering, it exhausts the published day-relevant
 * signals to KEEP APART what the rules keep apart and TOGETHER what the
 * rules run together:
 * - Same (location, co_share_group) in a week = one possession = one night,
 *   so those activities share the recommended weekday.
 * - Only one work per location including its exclusion-buffer halo may run
 *   per night: each activity's booked locations are expanded by its nature
 *   (Live 2 sectors both sides plus opposite-bound mirroring, Non-live
 *   (Consist) 1 sector, others none, using the 03_SECTORS topology), and any
 *   halo overlap between different possessions forces different weekdays.
 *   PM sole possessions separate the same way.
 * - A contract's number_of_workfronts caps how many of its activities share
 *   one weekday (concurrent teams).
 * Week-level signals (predecessors, planned dates, location supply, ECLO
 * windows) and buffer-depot staging (05) carry no published day mapping and
 * are deliberately not used. First clear weekday wins (Mon..Sun); a fully
 * blocked week falls back to the least-loaded day. Every pick carries a
 * short human-readable reason.
 */
export function recommendWorkdays(candidates) {
  const rank = (value, order) =>
    value != null && value in order ? order[value] : 99;
  const sorted = [...(candidates || [])].sort(
    (a, b) =>
      a.contractPriority - b.contractPriority ||
      rank(a.nature, DAY_NATURE_ORDER) - rank(b.nature, DAY_NATURE_ORDER) ||
      rank(a.accessType, DAY_ACCESS_ORDER) -
        rank(b.accessType, DAY_ACCESS_ORDER) ||
      a.seq - b.seq ||
      (a.activityId < b.activityId ? -1 : a.activityId > b.activityId ? 1 : 0),
  );
  const placed = [];
  const picks = [];
  for (const item of sorted) {
    const locs = item.locations || [];
    const booked = new Set(locs);
    const footprint = bufferedFootprint(locs, item.nature, item.sectorIndex);
    const prepared = { item, locs, booked, footprint };
    const sharesPossessionWith = (other) => {
      for (const loc of locs) {
        if (
          (other.locations || []).includes(loc) &&
          possessionOf(other, loc) === possessionOf(item, loc) &&
          !possessionOf(item, loc).startsWith("@@")
        ) {
          return loc;
        }
      }
      return null;
    };
    const pairClash = (entry, entryBooked, entryFootprint) => {
      if (sharesPossessionWith(entry)) return null;
      for (const loc of footprint) {
        if (entryFootprint.has(loc)) {
          return {
            other: entry.activityId,
            loc,
            buffered: !(booked.has(loc) && entryBooked.has(loc)),
          };
        }
      }
      return null;
    };
    // 1. Join an already-placed activity sharing the exact possession —
    // but only when nothing else on that day clashes with this item.
    let join = null;
    for (const p of placed) {
      const loc = sharesPossessionWith(p.item);
      if (!loc) continue;
      const blocked = placed.some(
        (other) =>
          other.day === p.day &&
          other.item.activityId !== p.item.activityId &&
          pairClash(other.item, other.booked, other.footprint) !== null,
      );
      if (!blocked) {
        join = { day: p.day, other: p.item.activityId, loc };
        break;
      }
    }
    const conflictsOn = (day) => {
      let sameContract = 0;
      for (const p of placed) {
        if (p.day !== day) continue;
        if (
          item.contractNumber != null &&
          p.item.contractNumber === item.contractNumber
        ) {
          sameContract += 1;
        }
        const hit = pairClash(p.item, p.booked, p.footprint);
        if (hit) return hit;
      }
      const cap = Number(item.workfronts) || 99;
      if (sameContract >= cap) {
        return { other: `${sameContract}x ${item.contractNumber}`, loc: "workfront limit" };
      }
      return null;
    };
    if (join) {
      placed.push({ ...prepared, day: join.day });
      picks.push({
        key: item.key,
        day: join.day,
        reason: `Shares ${possessionOf(item, join.loc)} possession at ${join.loc} with ${join.other}`,
      });
      continue;
    }
    let blocker = null;
    let chosen = null;
    for (let day = 0; day < 7; day += 1) {
      const hit = conflictsOn(day);
      if (!hit) {
        chosen = day;
        break;
      }
      if (!blocker) blocker = hit;
    }
    if (chosen == null) {
      let best = 0;
      let bestLoad = Infinity;
      for (let day = 0; day < 7; day += 1) {
        const load = placed.filter((p) => p.day === day).length;
        if (load < bestLoad) {
          bestLoad = load;
          best = day;
        }
      }
      chosen = best;
      placed.push({ ...prepared, day: chosen });
      picks.push({
        key: item.key,
        day: chosen,
        reason: "Fully blocked week — least-loaded day",
      });
      continue;
    }
    placed.push({ ...prepared, day: chosen });
    picks.push({
      key: item.key,
      day: chosen,
      reason: blocker
        ? blocker.buffered
          ? `Buffer overlap with ${blocker.other} at ${blocker.loc}`
          : `Clear of ${blocker.other} at ${blocker.loc}`
        : "First clear day",
    });
  }
  return picks;
}

/**
 * Format a week start date label from horizon_start and week offset.
 * Week 1 = horizon_start. Week N = horizon_start + (N-1)*7 days.
 * Returns e.g. "11 Jan 2027" for horizon_start="2027-01-04", week=2.
 */
export function formatWeekStart(horizonStart, week) {
  const base = new Date(horizonStart + "T00:00:00");
  if (isNaN(base.getTime())) return "Invalid date";
  const offsetDays = (week - 1) * 7;
  const target = new Date(base.getTime() + offsetDays * 86400000);
  const day = target.getDate();
  const month = target.toLocaleString("en-GB", { month: "short" });
  const year = target.getFullYear();
  return `${day} ${month} ${year}`;
}