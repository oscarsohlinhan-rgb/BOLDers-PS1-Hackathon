/**
 * TypeScript declarations for web/app/planning.mjs
 */

export interface ParsedCsvRow {
  [key: string]: string;
}

export function parseCsv(text: string): ParsedCsvRow[];

export interface PolicyResult {
  report: {
    feasible: boolean;
    soft_scores: {
      objective_score?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function selectBestPolicy(results: Record<string, PolicyResult>): string | null;

export interface LineStation {
  station_id: string;
  seq: number;
  is_interchange: boolean;
}

export interface LineSector {
  sector_id: string;
  from_station_id: string;
  to_station_id: string;
  seq: number;
  is_shared: boolean;
}

export interface LineTopology {
  line_code: string;
  line_name: string;
  stations: LineStation[];
  sectors: LineSector[];
}

export interface ActivityAccess {
  access_seq: number;
  week: number;
  eclo: boolean;
  access_night: number;
}

export interface Activity {
  activity_id: string;
  contract_number: string;
  activity_type: string;
  start_location_id: string;
  end_location_id: string;
  total_accesses: number;
  planned_start_date: string;
  predecessor_activity_id: string;
  activity_priority: number;
  startWeek: number;
  endWeek: number;
  accesses: ActivityAccess[];
  occupiedLocations: string[];
}

export interface PlanningModel {
  horizonStart: string;
  horizonWeeks: number;
  lines: LineTopology[];
  activities: Activity[];
}

export function buildPlanningModel(
  inputs: Record<string, string>,
  outputs: Record<string, string>
): PlanningModel;

export function formatWeekStart(horizonStart: string, week: number): string;

export const DAY_NATURE_ORDER: Record<string, number>;
export const DAY_ACCESS_ORDER: Record<string, number>;

export interface SectorInfo {
  line: string;
  bound: string;
  seq: number;
}

export function buildSectorIndex(
  sectors: ParsedCsvRow[],
): Map<string, SectorInfo>;

export function bufferedFootprint(
  locations: string[],
  nature: string | undefined,
  sectorIndex?: Map<string, SectorInfo>,
): Set<string>;

export interface WorkdayCandidate {
  key: string;
  activityId: string;
  contractNumber?: string;
  contractPriority: number;
  nature?: string;
  accessType?: string;
  seq: number;
  locations?: string[];
  groups?: Record<string, string>;
  workfronts?: number;
  sectorIndex?: Map<string, SectorInfo>;
}

export interface WorkdayPick {
  key: string;
  day: number;
  reason: string;
}

export function recommendWorkdays(candidates: WorkdayCandidate[]): WorkdayPick[];