'use client';

/**
 * Project TAO — Track Access Optimiser
 * Production candidate wired to the deterministic FastAPI pipeline.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { strToU8, zipSync } from 'fflate';
import { EXPECTED, assignFileToCanonicalSlot, classifyDroppedFiles } from '../intake.mjs';
import { buildPlanningModel, formatWeekStart, parseCsv, recommendWorkdays, selectBestPolicy } from '../planning.mjs';
import { explainEvidence, runPipeline, runReplan } from './live-pipeline.mjs';
import type { PipelineEvent } from './live-pipeline.mjs';
import styles from './mockup.module.css';

/* ------------------------------------------------------------------ */
/* Demo data                                                           */
/* ------------------------------------------------------------------ */

const LINE_COLORS = ['#34483a', '#7b3037', '#3d5a80', '#9b7427', '#6d4c5e'];

type Screen = 'welcome' | 'intake' | 'processing' | 'results' | 'recovery' | 'settings';
type PolicyId = 'A' | 'B' | 'C';
type View = 'night' | 'month' | 'horizon';
type TerminalDetail = 'standard' | 'detailed';
type ReplanEffort = 'same' | 'extended';
type ResultSelection = 'best' | 'policy-a';
type RecoveryId = 'missing' | 'schema' | 'infeasible' | 'offline' | 'partial';
const OUTPUT_FILES = ['SCHEDULE_ACCESS.csv', 'SCHEDULE_OCCUPANCY.csv', 'RESULTS.csv'] as const;

type SchemaGate = { passed: boolean; evidence_id?: string; errors: Array<{ code?: string; detail: string; file?: string; row?: number; field?: string }> };
type ConversionMapping = {
  source_file?: string;
  source_ref?: string;
  target_file?: string;
  target_field?: string;
  confidence?: string;
  note?: string;
};
type ConversionUncertainty = {
  source_file?: string;
  source_ref?: string;
  target_file?: string;
  target_field?: string;
  reason?: string;
};
type ConversionDraft = {
  provider: string;
  model: string;
  draft_id: string;
  untrusted_draft: true;
  tables: Record<string, string>;
  mappings: ConversionMapping[];
  uncertainties: ConversionUncertainty[];
  schema_gate: SchemaGate;
};
type SolveResult = {
  status: string;
  report: {
    scenario: PolicyId;
    feasible: boolean;
    hard_violations: Array<{ rule: string; detail: string }>;
    soft_scores: Record<string, unknown>;
    detail: { capacity_hotspots: string[]; nights_scheduled: number; eclo_nights: number };
  };
  files: Record<string, string>;
};
type RuleFinding = { rule: string; detail: string };
type ReplanResult = {
  status: string;
  explanation: string;
  changes: Array<{ activity_id: string; before_weeks: number[]; after_weeks: number[] }>;
  validator_gate: { passed: boolean; hard_violations: RuleFinding[]; soft_warnings: RuleFinding[] };
};
type ReplanPayload = { schema_gate: SchemaGate; replan: ReplanResult; files: Record<string, string> | null };
type RecoveryContext = {
  stage: 'validation' | 'optimisation' | 'connection';
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  issues: Array<{ scope: string; detail: string }>;
};

const WEEKS = 30;
const NIGHTS_PER_WEEK = 3; // Tue · Thu · Sat possession nights
const TOTAL_NIGHTS = WEEKS * NIGHTS_PER_WEEK; // 90
const HORIZON_START = new Date(2027, 0, 4); // Mon 4 Jan 2027
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NIGHT_OFFSETS = [1, 3, 5]; // Tue, Thu, Sat relative to W/C Monday

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
function weekStart(w: number): Date {
  return addDays(HORIZON_START, w * 7);
}
function nightDate(n: number): Date {
  const w = Math.floor((n - 1) / NIGHTS_PER_WEEK);
  return addDays(weekStart(w), NIGHT_OFFSETS[(n - 1) % NIGHTS_PER_WEEK]);
}
function fmtDay(d: Date): string {
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}
function fmtFull(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

interface Activity {
  id: string;
  name: string;
  line: 'Fenwick' | 'Marlowe';
  sector: string | null;
  station: string | null;
  platform: string | null;
  start: number; // first access_night ordinal (policy A)
  dur: number; // all-in nights
  crew: string;
  plant: string;
  buffer: string;
  fit?: string;
  offsets?: Partial<Record<PolicyId, number>>;
}

const ACTIVITIES: Activity[] = [
  { id: 'TAO-101', name: 'Plain-line tamping', line: 'Fenwick', sector: 'F1', station: null, platform: null, start: 2, dur: 5, crew: 'Tamping gang 4', plant: 'TTM-02', buffer: 'Bramley Sidings', offsets: { C: 4 } },
  { id: 'TAO-102', name: 'Rail renewal', line: 'Fenwick', sector: 'F2', station: null, platform: null, start: 8, dur: 5, crew: 'Renewals gang 1', plant: 'TRT-11', buffer: 'Bramley Sidings' },
  { id: 'TAO-103', name: 'Points renewal', line: 'Fenwick', sector: null, station: 'Colne Junction', platform: 'P2', start: 15, dur: 3, crew: 'S&C gang 2', plant: 'Kirow crane', buffer: 'Eskdale Yard' },
  { id: 'TAO-104', name: 'Ballast cleaning', line: 'Fenwick', sector: 'F3', station: null, platform: null, start: 18, dur: 5, crew: 'HOBC crew', plant: 'RM-80', buffer: 'Eskdale Yard', offsets: { B: -2 }, fit: 'Shares night 22 with TAO-112 (equality fit — handback night equals next first night). Durations are all-in; no padding added.' },
  { id: 'TAO-112', name: 'Cess & drainage renewals', line: 'Fenwick', sector: 'F3', station: null, platform: null, start: 22, dur: 4, crew: 'Civils gang 3', plant: 'RRV pair', buffer: 'Eskdale Yard', offsets: { B: -2 }, fit: 'Equality fit with TAO-104 at night 22 (policy A). Durations are all-in; no generic padding.' },
  { id: 'TAO-105', name: 'Signal commissioning', line: 'Fenwick', sector: null, station: 'Colne Junction', platform: null, start: 27, dur: 3, crew: 'S&T team 1', plant: 'Test unit', buffer: 'Eskdale Yard' },
  { id: 'TAO-110', name: 'OLE bonding', line: 'Fenwick', sector: 'F1', station: null, platform: null, start: 32, dur: 4, crew: 'OLE gang 2', plant: 'MEWP RRV', buffer: 'Bramley Sidings', offsets: { B: -1 } },
  { id: 'TAO-111', name: 'Crossing renewal', line: 'Fenwick', sector: null, station: 'Bramley', platform: 'P1', start: 37, dur: 4, crew: 'S&C gang 5', plant: 'Kirow crane', buffer: 'Bramley Sidings', offsets: { C: 3 } },
  { id: 'TAO-106', name: 'Track geometry survey', line: 'Marlowe', sector: 'M1', station: null, platform: null, start: 3, dur: 2, crew: 'Survey team', plant: 'UTV-1', buffer: 'Ipsley Loop' },
  { id: 'TAO-107', name: 'Sleeper replacement', line: 'Marlowe', sector: 'M2', station: null, platform: null, start: 9, dur: 5, crew: 'Renewals gang 2', plant: 'TRT-07', buffer: 'Ipsley Loop' },
  { id: 'TAO-108', name: 'Platform coping repairs', line: 'Marlowe', sector: null, station: 'Kestrel Bay', platform: 'P1', start: 16, dur: 4, crew: 'Civils gang 1', plant: 'RRV pair', buffer: 'Lulworth Buffer', offsets: { B: -1 } },
  { id: 'TAO-109', name: 'Drainage renewal', line: 'Marlowe', sector: 'M3', station: null, platform: null, start: 40, dur: 4, crew: 'Civils gang 2', plant: 'RRV trio', buffer: 'Lulworth Buffer' },
  { id: 'TAO-114', name: 'Rail grinding', line: 'Marlowe', sector: 'M3', station: null, platform: null, start: 43, dur: 3, crew: 'Grinding unit', plant: 'Loram RG-9', buffer: 'Lulworth Buffer', fit: 'Shares night 43 with TAO-109 (equality fit). Durations are all-in; no generic padding.' },
  { id: 'TAO-113', name: 'Buffer siding servicing', line: 'Marlowe', sector: null, station: 'Lulworth', platform: null, start: 47, dur: 2, crew: 'Yard crew', plant: 'Shunter', buffer: 'Lulworth Buffer', offsets: { C: -2 } },
];

const POLICIES: Array<{ id: PolicyId; name: string; score: number; blurb: string }> = [
  { id: 'A', name: 'Fixed supply', score: 412.6, blurb: 'Allows overrun, but forbids ECLO and excess location supply.' },
  { id: 'B', name: 'Zero overrun', score: 388.1, blurb: 'Meets planned completion dates, using allowed ECLO or excess supply when required.' },
  { id: 'C', name: 'Balanced capacity', score: 394.2, blurb: 'Balances overrun against the published limited supply and ECLO flexibility.' },
];
const BEST_POLICY: PolicyId = 'A';

function startFor(a: Activity, p: PolicyId): number {
  return a.start + (a.offsets?.[p] ?? 0);
}
function occupiedRange(a: Activity, p: PolicyId): [number, number] {
  const s = startFor(a, p);
  return [s, s + a.dur - 1];
}
function distinctNightSet(p: PolicyId): Set<number> {
  const s = new Set<number>();
  for (const a of ACTIVITIES) {
    const [from, to] = occupiedRange(a, p);
    for (let n = from; n <= to; n++) s.add(n);
  }
  return s;
}
function occupantsOf(n: number, p: PolicyId): Activity[] {
  return ACTIVITIES.filter((a) => {
    const [from, to] = occupiedRange(a, p);
    return n >= from && n <= to;
  });
}

const CONCEPTS: Array<{ name: string; file: string; rows: string; ai?: string }> = [
  { name: 'Lines', file: 'lines.csv', rows: '2 rows' },
  { name: 'Stations', file: 'stations.csv', rows: '9 rows', ai: 'Filename identified by consented AI (“stations FINAL(2).csv”)' },
  { name: 'Sectors', file: 'sectors.csv', rows: '6 rows' },
  { name: 'Location supply', file: 'location_supply.csv', rows: '18 rows' },
  { name: 'Buffer locations', file: 'buffer_locations.csv', rows: '4 rows' },
  { name: 'Parameters', file: 'parameters.csv', rows: '6 rows' },
  { name: 'Project details', file: 'project_details.csv', rows: '1 row' },
  { name: 'Activity details', file: 'activity_details.csv', rows: '14 rows', ai: 'Header variant normalised by AI draft' },
];

const FILE_TRACE: Array<[string, string, string]> = [
  ['lines.csv', '2 rows', 'header exact'],
  ['stations.csv', '9 rows', 'AI-identified filename · draft confirmed by validator'],
  ['sectors.csv', '6 rows', 'header exact'],
  ['location_supply.csv', '18 rows', '9 stations × 2 platforms'],
  ['buffer_locations.csv', '4 rows', 'header exact'],
  ['parameters.csv', '6 rows', 'duration_basis=all_in · equality_fit=true'],
  ['project_details.csv', '1 row', 'Colne Valley renewals programme'],
  ['activity_details.csv', '14 rows', 'header variant normalised · draft confirmed'],
];

const RELATION_CHECKS: Array<[string, string]> = [
  ['REL-01', 'Every activity references a known sector or station — 14/14'],
  ['REL-02', 'Every sector belongs to a known line — 6/6'],
  ['REL-03', 'Every supply location exists in stations — 18/18'],
  ['REL-04', 'Every buffer location adjoins its sector — 4/4'],
  ['REL-05', 'Every platform belongs to a listed station — 4/4'],
];

const DISPUTED_WARNINGS: string[] = [
  'stations.csv — filename “stations FINAL(2).csv” did not match the concept; resolved by consented AI identification, confirmed by the validator.',
  'activity_details.csv — header variant “duration” normalised to “duration_nights_all_in”; AI draft, validator-confirmed.',
];

const RECOVERY_CASES: Array<{
  id: RecoveryId;
  label: string;
  stage: string;
  stageIndex: number;
  tone: 'warning' | 'blocked' | 'paused' | 'partial';
  title: string;
  summary: string;
  preserved: string;
  issues: Array<{ scope: string; cause: string; action: string }>;
  primary: string;
  secondary: string;
  ai: string;
}> = [
  {
    id: 'missing', label: '5 of 8 tables', stage: 'Dataset intake', stageIndex: 0, tone: 'warning',
    title: 'Three required tables are still missing.',
    summary: 'Project TAO recognised five canonical tables. It cannot validate or optimise until Parameters, Project details and Activity details are supplied.',
    preserved: 'The five recognised tables are saved in this session. The user only needs to add the missing files.',
    issues: [
      { scope: '06 · Parameters', cause: 'No matching table was found.', action: 'Add file' },
      { scope: '07 · Project details', cause: 'No matching table was found.', action: 'Add file' },
      { scope: '08 · Activity details', cause: 'No matching table was found.', action: 'Add file' },
    ],
    primary: 'Add the 3 missing files', secondary: 'Download table templates',
    ai: 'AI may identify an inaccurately named file after explicit consent, but it cannot invent a missing table.',
  },
  {
    id: 'schema', label: 'Schema mismatch', stage: 'Deterministic validation', stageIndex: 1, tone: 'blocked',
    title: 'Two relationships need correction.',
    summary: 'All eight tables are present, but the validator found references that cannot exist in the supplied network topology.',
    preserved: 'The original files, recognised mappings and every passing table remain available. Only the affected rows need attention.',
    issues: [
      { scope: 'Sectors · 14 rows', cause: 'station_id S99 is not present in Stations.', action: 'Review rows' },
      { scope: 'Buffer locations · 3 rows', cause: 'The same location appears on both sides of a buffer rule.', action: 'Review rows' },
    ],
    primary: 'Open guided repair', secondary: 'Download error report',
    ai: 'AI can draft corrections beside the original values. The user must review them and rerun deterministic validation.',
  },
  {
    id: 'infeasible', label: 'No feasible plan', stage: 'Optimisation', stageIndex: 2, tone: 'blocked',
    title: 'The supplied constraints cannot produce a feasible plan.',
    summary: 'Every official policy stopped on the same hard blockers. No schedule or export has been presented as valid.',
    preserved: 'The validated dataset and solver evidence are retained. A new run starts from optimisation after an explicit input change.',
    issues: [
      { scope: '11 activities', cause: 'Required locations have no available supply in their requested weeks.', action: 'Review activities' },
      { scope: '4 precedence chains', cause: 'The final activity falls beyond the 30-week horizon.', action: 'Review chains' },
    ],
    primary: 'Review explicit constraints', secondary: 'Export solver diagnostics',
    ai: 'AI may explain blockers or draft a disruption request. Only the solver can establish that a revised plan is feasible.',
  },
  {
    id: 'offline', label: 'Run interrupted', stage: 'Optimisation connection', stageIndex: 2, tone: 'paused',
    title: 'The run paused safely.',
    summary: 'The optimiser connection was interrupted after validation. Project TAO has not discarded or silently resubmitted anything.',
    preserved: 'All eight files, the validated schema and evidence TAO-72F4 are stored locally at the last successful checkpoint.',
    issues: [
      { scope: 'Optimiser request', cause: 'Connection closed before Policy A returned a final status.', action: 'View technical detail' },
    ],
    primary: 'Resume from optimisation', secondary: 'Save local snapshot',
    ai: 'AI is not used to recover transport failures. Retrying reuses the validated local checkpoint.',
  },
  {
    id: 'partial', label: 'One policy failed', stage: 'Results review', stageIndex: 3, tone: 'partial',
    title: 'Policies A and C are valid; Policy B is unavailable.',
    summary: 'A capacity contradiction blocked Policy B at Linden in weeks 9–11. The two independently validated alternatives remain fully usable.',
    preserved: 'Policy A and Policy C keep their Gantt, topology, evidence and exports. The failed policy is clearly disabled, not hidden.',
    issues: [
      { scope: 'Policy B · Linden', cause: 'Two Priority 1 activities require the same exclusive workfront.', action: 'Inspect conflict' },
    ],
    primary: 'Continue with best valid policy C', secondary: 'Inspect Policy B evidence',
    ai: 'AI can summarise the difference between valid policies, but official objective_score still determines the recommended result.',
  },
];

const EVIDENCE_HASH = '9f3c7a2b-d4e1-8f06-c5a9-e21a7c40b2d8';

/* Schematic geometry (topological, not geographic) */
const STATIONS = [
  { name: 'Aldgate North', x: 64, y: 64, label: 'top' },
  { name: 'Bramley', x: 192, y: 64, label: 'top' },
  { name: 'Colne Junction', x: 320, y: 64, label: 'none', interchange: true },
  { name: 'Darnley', x: 448, y: 64, label: 'top' },
  { name: 'Eskdale', x: 576, y: 64, label: 'top' },
  { name: 'Harborne', x: 64, y: 156, label: 'bottom' },
  { name: 'Ipsley', x: 192, y: 156, label: 'bottom' },
  { name: 'Colne Junction', x: 320, y: 156, label: 'none', interchange: true },
  { name: 'Kestrel Bay', x: 448, y: 156, label: 'bottom' },
  { name: 'Lulworth', x: 576, y: 156, label: 'bottom' },
] as const;

const SECTORS = [
  { id: 'F1', y: 64, x1: 64, x2: 192 },
  { id: 'F2', y: 64, x1: 192, x2: 320 },
  { id: 'F3', y: 64, x1: 320, x2: 576 },
  { id: 'M1', y: 156, x1: 64, x2: 192 },
  { id: 'M2', y: 156, x1: 192, x2: 320 },
  { id: 'M3', y: 156, x1: 320, x2: 576 },
] as const;

const MONTH_RANGES = [
  { label: 'Jan 2027', from: 0, to: 3 },
  { label: 'Feb 2027', from: 4, to: 7 },
  { label: 'Mar 2027', from: 8, to: 12 },
  { label: 'Apr 2027', from: 13, to: 16 },
  { label: 'May 2027', from: 17, to: 21 },
  { label: 'Jun 2027', from: 22, to: 25 },
  { label: 'Jul 2027', from: 26, to: 29 },
];

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function CheckIcon() {
  return (
    <svg className={styles.checkIcon} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="9" className={styles.checkIconCircle} />
      <path d="M6 10.4l2.6 2.6L14 7.4" className={styles.checkIconTick} />
    </svg>
  );
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadJson(filename: string, value: unknown) {
  download(filename, JSON.stringify(value, null, 2), 'application/json');
}

function apiPayloadError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
  if (typeof record.detail === 'string') return record.detail;
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const first = record.errors[0] as Record<string, unknown>;
    if (typeof first.detail === 'string') return first.detail;
  }
  return fallback;
}

function csvRow(values: Array<string | number>): string {
  return values
    .map((value) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    })
    .join(',');
}

function correctedDraftFiles(): Record<string, Uint8Array> {
  const lines = ['line_id,line_name', 'F,Fenwick', 'M,Marlowe'].join('\n');
  const stations = [
    ['station_id', 'station_name', 'line_id'],
    ['AN', 'Aldgate North', 'F'], ['BR', 'Bramley', 'F'], ['CJ', 'Colne Junction', 'F'],
    ['DA', 'Darnley', 'F'], ['ES', 'Eskdale', 'F'], ['HA', 'Harborne', 'M'],
    ['IP', 'Ipsley', 'M'], ['KB', 'Kestrel Bay', 'M'], ['LU', 'Lulworth', 'M'],
  ].map(csvRow).join('\n');
  const sectors = [
    ['sector_id', 'line_id', 'from_station_id', 'to_station_id'],
    ['F1', 'F', 'AN', 'BR'], ['F2', 'F', 'BR', 'CJ'], ['F3', 'F', 'CJ', 'ES'],
    ['M1', 'M', 'HA', 'IP'], ['M2', 'M', 'IP', 'CJ'], ['M3', 'M', 'CJ', 'LU'],
  ].map(csvRow).join('\n');
  const supply = [
    ['station_id', 'platform_id', 'available_workfronts'],
    ...['AN', 'BR', 'CJ', 'DA', 'ES', 'HA', 'IP', 'KB', 'LU'].flatMap((station) => [
      [station, 'P1', 1], [station, 'P2', 1],
    ]),
  ].map(csvRow).join('\n');
  const buffers = [
    ['buffer_id', 'location_name', 'sector_id'],
    ['BUF-01', 'Bramley Sidings', 'F1'], ['BUF-02', 'Eskdale Yard', 'F3'],
    ['BUF-03', 'Ipsley Loop', 'M1'], ['BUF-04', 'Lulworth Buffer', 'M3'],
  ].map(csvRow).join('\n');
  const parameters = [
    ['parameter', 'value'], ['duration_basis', 'all_in'], ['equality_fit', 'true'],
    ['planning_weeks', 30], ['nights_per_week', 3], ['policy_count', 3], ['timezone', 'Asia/Singapore'],
  ].map(csvRow).join('\n');
  const projectDetails = [
    ['project_id', 'project_name', 'horizon_start', 'planning_weeks'],
    ['TAO-DEMO', 'Colne Valley renewals programme', '2027-01-04', 30],
  ].map(csvRow).join('\n');
  const activityDetails = [
    ['activity_id', 'activity_name', 'line_id', 'sector_id', 'station_id', 'duration_nights_all_in', 'crew', 'plant'],
    ...ACTIVITIES.map((activity) => [
      activity.id, activity.name, activity.line === 'Fenwick' ? 'F' : 'M', activity.sector ?? '',
      activity.station ?? '', activity.dur, activity.crew, activity.plant,
    ]),
  ].map(csvRow).join('\n');
  const manifest = [
    ['table', 'location', 'original_value', 'ai_proposed_value', 'reason', 'confidence', 'accepted'],
    ['Stations', 'filename', 'stations FINAL(2).csv', 'stations.csv', 'Content matches the canonical Stations schema', 'high', 'not accepted by download'],
    ['Activity details', 'header row', 'duration', 'duration_nights_all_in', 'Header meaning matches the all-in duration field', 'high', 'not accepted by download'],
  ].map(csvRow).join('\n');
  const readme = [
    'PROJECT TAO — AI-CORRECTED DRAFT REVIEW BUNDLE',
    '',
    'This bundle is an untrusted AI draft for human inspection.',
    'Downloading it does not accept a correction, pass deterministic validation, or start optimisation.',
    '',
    'Contents:',
    '- Eight corrected CSV concepts',
    '- correction_manifest.csv with every proposed change, original value, reason and confidence',
    '',
    'Compare the manifest and CSVs with your original source files before confirming any change in Project TAO.',
  ].join('\n');

  return Object.fromEntries(Object.entries({
    'README.txt': readme,
    'correction_manifest.csv': manifest,
    'lines.csv': lines,
    'stations.csv': stations,
    'sectors.csv': sectors,
    'location_supply.csv': supply,
    'buffer_locations.csv': buffers,
    'parameters.csv': parameters,
    'project_details.csv': projectDetails,
    'activity_details.csv': activityDetails,
  }).map(([name, text]) => [name, strToU8(`${text}\n`)]));
}

function downloadCorrectedDraft(): void {
  const bytes = zipSync(correctedDraftFiles(), { level: 6 });
  const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'project-tao-ai-corrected-draft.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function draftBundleFiles(draft: ConversionDraft): Record<string, Uint8Array> {
  const manifest = [
    ['source_file', 'source_ref', 'target_file', 'target_field', 'confidence', 'note'],
    ...draft.mappings.map((mapping) => [
      mapping.source_file ?? '', mapping.source_ref ?? '', mapping.target_file ?? '',
      mapping.target_field ?? '', mapping.confidence ?? '', mapping.note ?? '',
    ]),
  ].map(csvRow).join('\n');
  const uncertainties = [
    ['source_file', 'source_ref', 'target_file', 'target_field', 'reason'],
    ...draft.uncertainties.map((item) => [
      item.source_file ?? '', item.source_ref ?? '', item.target_file ?? '',
      item.target_field ?? '', item.reason ?? '',
    ]),
  ].map(csvRow).join('\n');
  const readme = [
    'PROJECT TAO — AI-CORRECTED DRAFT REVIEW BUNDLE',
    '',
    `Draft: ${draft.draft_id}`,
    `Provider/model: ${draft.provider}/${draft.model}`,
    '',
    'This is an untrusted AI draft for human inspection.',
    'Downloading or editing it does not accept a correction or prove railway feasibility.',
    'Only the deterministic schema gate can admit all eight tables into the solver.',
    '',
    'Review correction_manifest.csv and uncertainties.csv against the original source data.',
  ].join('\n');
  const textFiles: Record<string, string> = {
    'README.txt': readme,
    'correction_manifest.csv': manifest,
    'uncertainties.csv': uncertainties,
  };
  for (const name of EXPECTED) textFiles[name] = draft.tables[name] ?? '';
  return Object.fromEntries(Object.entries(textFiles).map(([name, value]) => [name, strToU8(`${value}\n`)]));
}

function downloadConversionDraft(draft: ConversionDraft): void {
  const bytes = zipSync(draftBundleFiles(draft), { level: 6 });
  const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `project-tao-ai-corrected-draft-${draft.draft_id}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function requestDraft(tables: Record<string, string>): FormData {
  const body = new FormData();
  for (const name of EXPECTED) body.append('files', new File([tables[name] ?? ''], name, { type: 'text/csv' }));
  return body;
}

/* ------------------------------------------------------------------ */
/* Welcome overlay                                                     */
/* ------------------------------------------------------------------ */

function WelcomeOverlay({ onDone, reduced }: { onDone: () => void; reduced: boolean }) {
  const [phase, setPhase] = useState<'hello' | 'brand'>(reduced ? 'brand' : 'hello');
  const enterRef = useRef<HTMLButtonElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (reduced) {
      setPhase('brand');
      return;
    }
    const t = window.setTimeout(() => setPhase('brand'), 1300);
    return () => window.clearTimeout(t);
  }, [reduced]);

  useEffect(() => {
    if (phase === 'brand') enterRef.current?.focus();
    else skipRef.current?.focus();
  }, [phase]);

  return (
    <div
      className={styles.welcome}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Project TAO"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
      }}
    >
      <button ref={skipRef} type="button" className={styles.skipBtn} onClick={onDone}>
        Skip intro
      </button>
      <div className={styles.welcomeInner}>
        {phase === 'hello' ? (
          <p className={styles.welcomeWord}>Welcome</p>
        ) : (
          <div className={styles.brandBlock}>
            <p className={styles.brandMark}>Project TAO</p>
            <p className={styles.brandSub}>Plan track access with confidence</p>
            <div className={styles.welcomeActions}>
              <button ref={enterRef} type="button" className={styles.primaryBtn} onClick={onDone}>
                Enter workspace
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsScreen({
  budget, onBudget, replanEffort, onReplanEffort, terminalDetail, onTerminalDetail,
  resultSelection, onResultSelection, onDone,
}: {
  budget: number;
  onBudget: (value: number) => void;
  replanEffort: ReplanEffort;
  onReplanEffort: (value: ReplanEffort) => void;
  terminalDetail: TerminalDetail;
  onTerminalDetail: (value: TerminalDetail) => void;
  resultSelection: ResultSelection;
  onResultSelection: (value: ResultSelection) => void;
  onDone: () => void;
}) {
  return (
    <>
      <div className={styles.settingsHead}>
        <div>
          <span>Workspace preferences</span>
          <h1 className={styles.screenTitle} data-heading tabIndex={-1}>Settings</h1>
          <p className={styles.lede}>Fine-tune how Project TAO searches, replans and presents results. These controls never weaken the deterministic validator.</p>
        </div>
        <button type="button" className={styles.primaryBtn} onClick={onDone}>Done</button>
      </div>

      <section className={styles.settingsGroup} aria-labelledby="solver-effort-title">
        <div className={styles.settingCopy}>
          <span>Optimisation</span>
          <h2 id="solver-effort-title">Solver effort</h2>
          <p>CP-SAT receives this much search time for each of policies A, B and C. More time may find a better score or prove optimality more often, but it cannot change railway rules or guarantee improvement.</p>
        </div>
        <div className={styles.settingControl}>
          <label htmlFor="optimisation-seconds">Optimisation seconds per policy</label>
          <div className={styles.numberSetting}><input id="optimisation-seconds" type="number" min="1" max="60" value={budget} onChange={(event) => onBudget(Math.max(1, Math.min(60, Number(event.target.value) || 1)))} /><span>seconds</span></div>
          <div className={styles.settingPresets} aria-label="Optimisation time presets">
            {[4, 8, 20, 60].map((value) => <button key={value} type="button" aria-pressed={budget === value} onClick={() => onBudget(value)}>{value}s</button>)}
          </div>
          <small>Total maximum search time is roughly {budget * 3} seconds across all three policies.</small>
        </div>
      </section>

      <section className={styles.settingsGroup} aria-labelledby="replan-effort-title">
        <div className={styles.settingCopy}><span>Disruptions</span><h2 id="replan-effort-title">Replan effort</h2><p>Choose whether a disruption replan uses the normal budget or gets twice as long, capped at 60 seconds.</p></div>
        <div className={styles.settingControl}><div className={styles.segmented} role="group" aria-label="Replan effort">
          <button type="button" aria-pressed={replanEffort === 'same'} onClick={() => onReplanEffort('same')}><strong>Same</strong><small>{budget}s</small></button>
          <button type="button" aria-pressed={replanEffort === 'extended'} onClick={() => onReplanEffort('extended')}><strong>Extended</strong><small>{Math.min(60, budget * 2)}s</small></button>
        </div></div>
      </section>

      <section className={styles.settingsGroup} aria-labelledby="pipeline-detail-title">
        <div className={styles.settingCopy}><span>Visibility</span><h2 id="pipeline-detail-title">Pipeline detail</h2><p>Standard shows decision checkpoints. Detailed also shows each policy starting, useful while diagnosing slow or interrupted runs.</p></div>
        <div className={styles.settingControl}><div className={styles.segmented} role="group" aria-label="Pipeline detail">
          <button type="button" aria-pressed={terminalDetail === 'standard'} onClick={() => onTerminalDetail('standard')}><strong>Standard</strong><small>Checkpoints</small></button>
          <button type="button" aria-pressed={terminalDetail === 'detailed'} onClick={() => onTerminalDetail('detailed')}><strong>Detailed</strong><small>All events</small></button>
        </div></div>
      </section>

      <section className={styles.settingsGroup} aria-labelledby="initial-policy-title">
        <div className={styles.settingCopy}><span>Results</span><h2 id="initial-policy-title">Initial policy</h2><p>All three policies still run. This only controls which validated result is shown first in the workspace.</p></div>
        <div className={styles.settingControl}><div className={styles.segmented} role="group" aria-label="Initial policy">
          <button type="button" aria-pressed={resultSelection === 'best'} onClick={() => onResultSelection('best')}><strong>Best score</strong><small>Recommended</small></button>
          <button type="button" aria-pressed={resultSelection === 'policy-a'} onClick={() => onResultSelection('policy-a')}><strong>Policy A</strong><small>Fixed supply</small></button>
        </div></div>
      </section>

      <div className={styles.settingsFooter}><button type="button" className={styles.ghostBtn} onClick={() => { onBudget(8); onReplanEffort('same'); onTerminalDetail('detailed'); onResultSelection('best'); }}>Restore recommended defaults</button><p>Changes apply to the next solve or replan in this browser session.</p></div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Intake                                                              */
/* ------------------------------------------------------------------ */

function AiConversionPanel({
  sourceFiles,
  consent,
  onConsent,
  busy,
  error,
  draft,
  draftGate,
  selectedTable,
  onSelectTable,
  draftReviewed,
  onDraftReviewed,
  onCreate,
  onUpdateTable,
  onValidate,
  onAccept,
  onClear,
}: {
  sourceFiles: File[];
  consent: boolean;
  onConsent: (value: boolean) => void;
  busy: boolean;
  error: string;
  draft: ConversionDraft | null;
  draftGate: SchemaGate | null;
  selectedTable: string;
  onSelectTable: (value: string) => void;
  draftReviewed: boolean;
  onDraftReviewed: (value: boolean) => void;
  onCreate: () => void;
  onUpdateTable: (name: string, value: string) => void;
  onValidate: () => void;
  onAccept: () => void;
  onClear: () => void;
}) {
  return (
    <section id="ai-file-repair" className={styles.aiConversion} aria-labelledby="ai-conversion-title">
      <div className={styles.aiConversionHead}>
        <div>
          <span>Optional repair route</span>
          <h2 id="ai-conversion-title">AI-assisted data repair</h2>
        </div>
        <strong>{sourceFiles.length} source{sourceFiles.length === 1 ? '' : 's'}</strong>
      </div>

      <div className={styles.aiDisclosure}>
        <p><strong>What leaves this browser:</strong> the complete text, headers, fields and rows of the files listed below.</p>
        <p>Provider: <b>Gemini on Google Cloud Vertex AI</b>. Original files remain unchanged. AI output is an untrusted draft, never a feasibility decision.</p>
        <ul>{sourceFiles.map((file) => <li key={file.name}><code>{file.name}</code><span>{(file.size / 1024).toFixed(1)} KB</span></li>)}</ul>
      </div>

      {!draft ? (
        <div className={styles.aiSettings}>
          <label className={styles.consentRow}>
            <input type="checkbox" checked={consent} onChange={(event) => onConsent(event.target.checked)} disabled={busy} />
            <span>I explicitly consent to sending the listed files to Gemini on Vertex AI for data repair.</span>
          </label>
          <div className={styles.aiActions}>
            <button type="button" className={styles.primaryBtn} disabled={busy || !consent} onClick={onCreate}>
              {busy ? 'Creating draft…' : 'Create untrusted draft'}
            </button>
            <button type="button" className={styles.ghostBtn} disabled={busy} onClick={onClear}>Continue without AI</button>
          </div>
        </div>
      ) : (
        <div className={styles.aiDraft}>
          <div className={styles.aiDraftMeta}>
            <span><small>Provider</small>{draft.provider}</span>
            <span><small>Model</small>{draft.model}</span>
            <span><small>Draft ID</small>{draft.draft_id}</span>
          </div>
          <p className={styles.aiDraftWarning}>Untrusted draft — compare it with the originals, edit if needed, then rerun deterministic validation.</p>
          <div className={styles.aiTableTabs} role="tablist" aria-label="AI draft tables">
            {EXPECTED.map((name) => (
              <button key={name} type="button" role="tab" aria-selected={selectedTable === name} onClick={() => onSelectTable(name)}>
                {name.replace(/^\d+_/, '').replace('.csv', '')}
              </button>
            ))}
          </div>
          <textarea
            className={styles.aiDraftEditor}
            value={draft.tables[selectedTable] ?? ''}
            onChange={(event) => onUpdateTable(selectedTable, event.target.value)}
            disabled={busy}
            aria-label={`Edit ${selectedTable} CSV content`}
            spellCheck={false}
          />

          <details className={styles.aiProvenance}>
            <summary>Review {draft.mappings.length} mapping record{draft.mappings.length === 1 ? '' : 's'} and {draft.uncertainties.length} uncertaint{draft.uncertainties.length === 1 ? 'y' : 'ies'}</summary>
            {draft.mappings.length ? (
              <ul>{draft.mappings.map((mapping, index) => <li key={index}><code>{mapping.source_file ?? 'source'}</code> {mapping.source_ref ?? ''} → <code>{mapping.target_file ?? 'target'}</code> {mapping.target_field ?? ''}<span>{mapping.note ?? mapping.confidence ?? ''}</span></li>)}</ul>
            ) : <p>No mapping provenance was returned.</p>}
            {draft.uncertainties.length ? (
              <div className={styles.aiUncertainties}><strong>User clarification required</strong><p>Resolve or explicitly confirm each ambiguous item against the source data before accepting this draft.</p><ul>{draft.uncertainties.map((item, index) => <li key={index}>{item.source_file ?? 'source'} → {item.target_file ?? 'target'}: {item.reason ?? item.target_field ?? 'uncertain value'}</li>)}</ul></div>
            ) : null}
          </details>

          {draftGate?.passed ? <p className={styles.gatePassed} role="status">Deterministic schema gate passed.</p> : null}
          {draftGate && !draftGate.passed ? (
            <div className={styles.gateFailed} role="alert">
              <strong>Deterministic gate found {draftGate.errors.length} issue{draftGate.errors.length === 1 ? '' : 's'}.</strong>
              <ul>{draftGate.errors.slice(0, 8).map((item, index) => <li key={index}>{item.file ? `${item.file}: ` : ''}{item.detail}</li>)}</ul>
            </div>
          ) : null}

          <div className={styles.aiActions}>
            <button type="button" className={styles.ghostBtn} onClick={() => downloadConversionDraft(draft)}>Download AI-corrected draft (.zip)</button>
            <button type="button" className={styles.ghostBtn} disabled={busy} onClick={onValidate}>{busy ? 'Validating…' : 'Validate edited draft'}</button>
          </div>
          <small className={styles.reviewOnlyNote}>Downloading is review-only. It does not confirm the draft, rerun validation, or start optimisation.</small>
          <label className={styles.consentRow}>
            <input type="checkbox" checked={draftReviewed} onChange={(event) => onDraftReviewed(event.target.checked)} disabled={busy} />
            <span>I reviewed the corrected files and resolved or explicitly confirmed every ambiguous item against the source data.</span>
          </label>
          <button type="button" className={styles.primaryBtn} disabled={busy || !draftGate?.passed || !draftReviewed} onClick={onAccept}>Accept reviewed draft</button>
        </div>
      )}
      {error ? <p className={styles.intakeError} role="alert">{error}</p> : null}
    </section>
  );
}

function canonicalLabel(name: string): string {
  return name
    .replace(/^\d+_/, '')
    .replace(/\.csv$/i, '')
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ManualFileMapper({ files, unmatched, onAssign }: { files: Map<string, File>; unmatched: File[]; onAssign: (source: string, target: string) => void }) {
  const [source, setSource] = useState(unmatched[0]?.name ?? '');
  const [target, setTarget] = useState('');
  useEffect(() => {
    if (!unmatched.some((file) => file.name === source)) setSource(unmatched[0]?.name ?? '');
    setTarget('');
  }, [source, unmatched]);
  return (
    <section id="manual-file-mapper" className={styles.manualMapper} aria-labelledby="manual-mapper-title">
      <div className={styles.aiConversionHead}><div><span>Local naming step · no AI</span><h2 id="manual-mapper-title">Match each file to its CSV number</h2></div><strong>{unmatched.length} unmatched</strong></div>
      <p className={styles.mapperIntro}>Select the file, then choose what it represents. Project TAO creates an internal correctly named copy; your original file is never changed or uploaded for this step.</p>
      <div className={styles.mapperColumns}>
        <div><h3>1 · Select file</h3>{unmatched.map((file) => <button key={file.name} type="button" aria-pressed={source === file.name} onClick={() => setSource(file.name)}><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(1)} KB</small></button>)}</div>
        <div><h3>2 · Choose data type</h3>{EXPECTED.map((name) => <button key={name} type="button" disabled={files.has(name)} aria-pressed={target === name} onClick={() => setTarget(name)}><strong>{canonicalLabel(name)}</strong><small>{files.has(name) ? `Already filled · ${name}` : name}</small></button>)}</div>
      </div>
      <div className={styles.mapperConfirm}><p>{source && target ? <><code>{source}</code> → <code>{target}</code></> : 'Choose one source file and one available destination.'}</p><button type="button" className={styles.primaryBtn} disabled={!source || !target} onClick={() => onAssign(source, target)}>Confirm name mapping</button></div>
      <p className={styles.mapperBoundary}>If the filename is the only issue, no AI is used. After mapping, deterministic validation checks the actual columns and values. Gemini is offered only if that content check fails.</p>
    </section>
  );
}

function IntakeScreen({
  files,
  conversionFiles,
  onPick,
  onRemove,
  onNext,
  budget,
  error,
  busy,
  conversionConsent,
  onConversionConsent,
  conversionBusy,
  conversionError,
  conversionDraft,
  draftGate,
  selectedDraftTable,
  onSelectedDraftTable,
  draftReviewed,
  onDraftReviewed,
  onCreateDraft,
  onUpdateDraftTable,
  onValidateDraft,
  onAcceptDraft,
  onClearConversion,
  needsAiRepair,
  onAssign,
  onClearAll,
}: {
  files: Map<string, File>;
  conversionFiles: File[];
  onPick: (incoming: File[]) => void;
  onRemove: (name: string) => void;
  onNext: () => void;
  budget: number;
  error: string;
  busy: boolean;
  conversionConsent: boolean;
  onConversionConsent: (value: boolean) => void;
  conversionBusy: boolean;
  conversionError: string;
  conversionDraft: ConversionDraft | null;
  draftGate: SchemaGate | null;
  selectedDraftTable: string;
  onSelectedDraftTable: (value: string) => void;
  draftReviewed: boolean;
  onDraftReviewed: (value: boolean) => void;
  onCreateDraft: () => void;
  onUpdateDraftTable: (name: string, value: string) => void;
  onValidateDraft: () => void;
  onAcceptDraft: () => void;
  onClearConversion: () => void;
  needsAiRepair: boolean;
  onAssign: (source: string, target: string) => void;
  onClearAll: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const complete = files.size === EXPECTED.length && conversionFiles.length === 0;

  return (
    <>
      <div className={styles.screenHead}>
        <h1 className={styles.screenTitle} data-heading tabIndex={-1}>
          Import your track programme
        </h1>
        <p className={styles.lede}>
          Add your eight programme data files. Project TAO checks the data once, then builds the scheduling
          options for review and validated export.
        </p>
      </div>

      {conversionFiles.length > 0 ? (
        <section className={styles.topMismatchAlert} role="alert" aria-labelledby="file-mismatch-title">
          <div>
            <strong id="file-mismatch-title">Some files need attention before processing</strong>
            <p>
              {conversionFiles.length} file{conversionFiles.length === 1 ? '' : 's'} did not exactly match the eight expected CSV names or formats. No optimisation has started.
            </p>
            <ul>{conversionFiles.slice(0, 4).map((file) => <li key={file.name}><code>{file.name}</code></li>)}</ul>
          </div>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => document.getElementById('manual-file-mapper')?.scrollIntoView({ block: 'start' })}
          >
            Review unmatched files
          </button>
        </section>
      ) : null}

      {error ? <p className={styles.topMismatchAlert} role="alert">{error}</p> : null}

      <div className={styles.intakeGrid}>
      <div className={styles.intakeDropCell}>
      <div
        className={`${styles.drop} ${dragging ? styles.dropActive : ''}`}
        role="group"
        aria-label="Dataset drop area"
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          onPick(Array.from(event.dataTransfer.files));
        }}
      >
        <input
          ref={inputRef}
          className={styles.fileInput}
          type="file"
          accept=".csv,.tsv,.txt,.json,.md"
          multiple
          disabled={busy}
          onChange={(event) => onPick(Array.from(event.target.files ?? []))}
        />
        <p className={styles.dropTitle}>Drop your data files here</p>
        <p className={styles.dropHint}>Eight data files are expected. Files with different names can be matched manually — no AI needed.</p>
        <button type="button" className={styles.ghostBtn} disabled={busy} onClick={() => inputRef.current?.click()}>
          Choose files
        </button>
      </div>
      </div>
      <div className={styles.intakeStatusCell}>
      <div className={styles.countRow}>
      <p className={styles.countLine} aria-live="polite">
        <span className={styles.countNum}>{files.size}</span>
        <span className={styles.countText}>of 8 data files ready</span>
      </p>
      {files.size > 0 || conversionFiles.length > 0 ? (
        <button
          type="button"
          className={styles.clearAllBtn}
          onClick={onClearAll}
          disabled={busy || conversionBusy}
          aria-label="Remove all datasets"
        >
          Clear all files
        </button>
      ) : null}
      </div>

      <ol className={styles.checkList}>
        {EXPECTED.map((name) => {
          const present = files.get(name);
          return (
            <li key={name} className={`${styles.checkItem} ${present ? styles.on : styles.pendingFile}`}>
              {present ? <CheckIcon /> : <span className={styles.emptyCheck}>○</span>}
              <span className={styles.checkMain}>
                <span className={styles.checkName}>{name.replace(/^\d+_/, '').replace('.csv', '').replaceAll('_', ' ')}</span>
                <span className={styles.checkMeta}><code>{name}</code>{present ? ` · ${(present.size / 1024).toFixed(1)} KB` : ' · waiting'}</span>
              </span>
              {present ? <button type="button" className={styles.removeFile} onClick={() => onRemove(name)} aria-label={`Remove ${name}`}>Remove</button> : null}
            </li>
          );
        })}
      </ol>
      </div>
      </div>

      {conversionFiles.length > 0 ? <ManualFileMapper files={files} unmatched={conversionFiles} onAssign={onAssign} /> : null}

      {needsAiRepair ? (
        <AiConversionPanel
          sourceFiles={[...files.values()]}
          consent={conversionConsent}
          onConsent={onConversionConsent}
          busy={conversionBusy}
          error={conversionError}
          draft={conversionDraft}
          draftGate={draftGate}
          selectedTable={selectedDraftTable}
          onSelectTable={onSelectedDraftTable}
          draftReviewed={draftReviewed}
          onDraftReviewed={onDraftReviewed}
          onCreate={onCreateDraft}
          onUpdateTable={onUpdateDraftTable}
          onValidate={onValidateDraft}
          onAccept={onAcceptDraft}
          onClear={onClearConversion}
        />
      ) : null}

      <div className={styles.runControls}>
        <p className={styles.runConfigSummary}><strong>{budget}s per policy</strong><span>Configured in Settings</span></p>
        <button type="button" className={styles.primaryBtn} disabled={!complete || busy} onClick={onNext}>
          {busy ? 'Starting pipeline…' : complete ? 'Process dataset' : `Add ${EXPECTED.length - files.size} remaining file${EXPECTED.length - files.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Processing                                                          */
/* ------------------------------------------------------------------ */

function ProcessingScreen({
  onResults,
  busy,
  logs,
  results,
  errors,
  validation,
  fatalError,
  terminalDetail,
}: {
  onResults: () => void;
  busy: boolean;
  logs: string[];
  results: Partial<Record<PolicyId, SolveResult>>;
  errors: Partial<Record<PolicyId, string>>;
  validation: SchemaGate | null;
  fatalError: string;
  terminalDetail: TerminalDetail;
}) {
  const settled = POLICIES.every((policy) => results[policy.id] || errors[policy.id]);
  const hasResult = Object.keys(results).length > 0;
  const visibleLogs = terminalDetail === 'detailed' ? logs : logs.filter((line) => !line.startsWith('SOLVE-START'));
  return (
    <>
      <div className={styles.screenHead}>
        <h1 className={styles.screenTitle} data-heading tabIndex={-1}>
          Preparing your programme
        </h1>
        <p className={styles.lede}>
          Project TAO is checking your data and building the scheduling options. Only independently checked
          results can be exported.
        </p>
      </div>

      <div className={styles.liveTerminal} role="log" aria-live="polite" aria-label="Live pipeline terminal">
        <header><span>project-tao/pipeline</span><strong>{busy ? 'RUNNING' : fatalError ? 'STOPPED' : settled ? 'COMPLETE' : 'READY'}</strong></header>
        <div className={styles.terminalBody}>
          {visibleLogs.map((line, index) => <p key={`${index}-${line}`}><span>{String(index + 1).padStart(2, '0')}</span>{line}</p>)}
          {busy ? <p className={styles.terminalCursor}><span>··</span>waiting for the next deterministic checkpoint</p> : null}
        </div>
      </div>

      <section className={styles.livePolicyGrid} aria-label="Policy run status">
        {POLICIES.map((policy) => {
          const result = results[policy.id];
          const policyError = errors[policy.id];
          const score = result?.report.soft_scores.objective_score;
          return (
            <article key={policy.id} className={policyError ? styles.policyFailed : result ? styles.policyPassed : ''}>
              <span>Policy {policy.id}</span>
              <h2>{policy.name}</h2>
              <p>{policy.blurb}</p>
              <strong>{policyError ? 'Failed' : result ? `Score ${typeof score === 'number' ? score : '—'}` : 'Waiting'}</strong>
              {result ? <small>{result.report.hard_violations.length} hard violations · {result.report.detail.nights_scheduled} scheduled nights</small> : null}
              {policyError ? <small>{policyError}</small> : null}
            </article>
          );
        })}
      </section>

      {validation?.evidence_id ? <p className={styles.evidenceLine}>Schema evidence <code>{validation.evidence_id}</code></p> : null}
      {fatalError ? <p className={styles.intakeError} role="alert">{fatalError}</p> : null}

      <div className={styles.actionsRow}>
        <button type="button" className={styles.primaryBtn} disabled={busy || !hasResult} onClick={onResults}>
          {busy ? 'Processing policies…' : hasResult ? 'See results' : 'No valid result available'}
        </button>
        {busy ? <span className={styles.runningNote}>The terminal updates after each API checkpoint.</span> : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Railway schematic                                                   */
/* ------------------------------------------------------------------ */

function Schematic({
  hiSectors,
  hiStations,
}: {
  hiSectors: ReadonlySet<string>;
  hiStations: ReadonlyMap<string, string | null>;
}) {
  return (
    <figure className={styles.schemWrap}>
      <svg
        viewBox="0 0 640 208"
        role="img"
        aria-label="Topological schematic of the Fenwick and Marlowe Coast lines, connected at the Colne Junction interchange"
      >
        {/* base lines */}
        <line x1={64} y1={64} x2={576} y2={64} className={styles.railA} />
        <line x1={64} y1={156} x2={576} y2={156} className={styles.railB} />
        <line x1={320} y1={64} x2={320} y2={156} className={styles.railInter} />

        {/* sectors */}
        {SECTORS.map((s) => (
          <g key={s.id}>
            <line
              x1={s.x1}
              y1={s.y}
              x2={s.x2}
              y2={s.y}
              className={`${styles.seg} ${hiSectors.has(s.id) ? styles.segActive : ''}`}
            />
            <text
              x={(s.x1 + s.x2) / 2}
              y={s.y === 64 ? 92 : 138}
              textAnchor="middle"
              className={styles.secText}
            >
              {s.id}
            </text>
          </g>
        ))}

        {/* line names */}
        <text x={64} y={40} className={styles.lineText}>Fenwick line</text>
        <text x={64} y={182} className={styles.lineText}>Marlowe Coast line</text>
        <text x={334} y={112} className={styles.stText}>Colne Junction — interchange</text>

        {/* stations */}
        {STATIONS.map((st) => {
          const hi = hiStations.has(st.name);
          const platform = hiStations.get(st.name) ?? null;
          return (
            <g key={`${st.name}-${st.y}`}>
              <circle
                cx={st.x}
                cy={st.y}
                r={5.5}
                className={`${styles.station} ${hi ? styles.stationActive : ''}`}
              />
              {'interchange' in st && st.interchange ? (
                <circle cx={st.x} cy={st.y} r={10.5} className={styles.interRing} />
              ) : null}
              {hi ? <circle cx={st.x} cy={st.y} r={13.5} className={styles.hiRing} /> : null}
              {st.label === 'top' ? (
                <text x={st.x} y={st.y - 18} textAnchor="middle" className={styles.stText}>{st.name}</text>
              ) : null}
              {st.label === 'bottom' ? (
                <text x={st.x} y={st.y + 26} textAnchor="middle" className={styles.stText}>{st.name}</text>
              ) : null}
              {hi && platform ? (
                <text x={st.x + 16} y={st.y - 8} className={styles.platText}>{platform}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.schemNote}>
        Topological schematic — <strong>not geographic</strong>. Night references are <code>access_night</code>{' '}
        ordinals (1–90), not clock times. Highlight shows the occupied sector and station for the current selection.
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Gantt                                                               */
/* ------------------------------------------------------------------ */

function Gantt({
  policy,
  from,
  to,
  selectedId,
  onSelect,
}: {
  policy: PolicyId;
  from: number;
  to: number;
  selectedId: string | null;
  onSelect: (a: Activity) => void;
}) {
  const weeksVisible = to - from + 1;
  const nightStart = from * NIGHTS_PER_WEEK + 1;
  const span = weeksVisible * NIGHTS_PER_WEEK;
  const gridTemplate = `210px repeat(${weeksVisible}, minmax(30px, 1fr))`;
  const minWidth = 210 + weeksVisible * 34;

  const onRowKey = (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, ACTIVITIES.length - 1) : Math.max(idx - 1, 0);
    onSelect(ACTIVITIES[next]);
    const rows = document.querySelectorAll<HTMLButtonElement>('[data-gantt-row]');
    rows[next]?.focus();
  };

  return (
    <div className={styles.gantt} role="group" aria-label="Programme Gantt chart">
      <div style={{ minWidth }}>
        <div className={styles.ganttHead} style={{ gridTemplateColumns: gridTemplate }}>
          <span className={styles.cellLabel}>Activity · nights 1–{TOTAL_NIGHTS}</span>
          {Array.from({ length: weeksVisible }, (_, i) => from + i).map((w) => (
            <span key={w} className={styles.weekCell}>
              <span className={styles.weekPrefix}>W/C</span> {fmtDay(weekStart(w))}
            </span>
          ))}
        </div>
        <ul className={styles.ganttList}>
          {ACTIVITIES.map((a, idx) => {
            const [s, e] = occupiedRange(a, policy);
            const vs = Math.max(s, nightStart);
            const ve = Math.min(e, nightStart + span - 1);
            const inRange = ve >= vs;
            const sel = a.id === selectedId;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  data-gantt-row
                  className={`${styles.ganttRow} ${sel ? styles.ganttRowSel : ''}`}
                  style={{ gridTemplateColumns: gridTemplate }}
                  aria-pressed={sel}
                  aria-label={`${a.id} ${a.name}, ${a.line} line, access nights ${s} to ${e}. Select for details.`}
                  onClick={() => onSelect(a)}
                  onKeyDown={(ev) => onRowKey(ev, idx)}
                >
                  <span className={styles.cellLabel}>
                    <span className={styles.cellId}>{a.id}</span>
                    <span className={styles.cellName}>{a.name}</span>
                  </span>
                  <span className={styles.trackWrap}>
                    <span className={styles.gridLines} style={{ gridTemplateColumns: `repeat(${weeksVisible}, 1fr)` }} aria-hidden="true">
                      {Array.from({ length: weeksVisible }, (_, i) => (
                        <span key={i} className={styles.gridCell} />
                      ))}
                    </span>
                    {inRange ? (
                      <>
                        <span
                          className={`${styles.bar} ${sel ? styles.barSel : ''}`}
                          style={{
                            left: `${((vs - nightStart) / span) * 100}%`,
                            width: `${((ve - vs + 1) / span) * 100}%`,
                          }}
                        />
                        {Array.from({ length: ve - vs + 1 }, (_, i) => vs + i).map((n) => (
                          <span
                            key={n}
                            className={`${styles.tick} ${sel ? styles.tickSel : ''}`}
                            style={{ left: `${((n - nightStart + 0.5) / span) * 100}%` }}
                          />
                        ))}
                      </>
                    ) : (
                      <span className={styles.outsideNote}>outside this window</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p className={styles.legend}>
        Bars are possession spans; ticks are individual access nights (<code>access_night</code> ordinals). Bars that
        meet at one shared edge-night are equality fits — durations are all-in, no generic padding is added.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Results workspace                                                   */
/* ------------------------------------------------------------------ */

function ResultsScreen() {
  const [policy, setPolicy] = useState<PolicyId>(BEST_POLICY);
  const [view, setView] = useState<View>('horizon');
  const [selectedId, setSelectedId] = useState<string | null>(ACTIVITIES[3].id);
  const [night, setNight] = useState(22);
  const [monthIdx, setMonthIdx] = useState(1);
  const [rangeFrom, setRangeFrom] = useState(0);
  const [rangeTo, setRangeTo] = useState(WEEKS - 1);
  const [exportNote, setExportNote] = useState('');
  const [warningsOpen, setWarningsOpen] = useState(false);

  const selected = ACTIVITIES.find((a) => a.id === selectedId) ?? null;
  const activePolicy = POLICIES.find((p) => p.id === policy) ?? POLICIES[0];
  const scheduledNights = distinctNightSet(policy);
  const occupants = occupantsOf(night, policy);

  const hiSectors = new Set<string>();
  const hiStations = new Map<string, string | null>();
  if (view === 'night') {
    for (const a of occupants) {
      if (a.sector) hiSectors.add(a.sector);
      if (a.station) hiStations.set(a.station, a.platform);
    }
  } else if (selected) {
    if (selected.sector) hiSectors.add(selected.sector);
    if (selected.station) hiStations.set(selected.station, selected.platform);
  }

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const order: View[] = ['night', 'month', 'horizon'];
    const next = e.key === 'ArrowRight' ? Math.min(idx + 1, order.length - 1) : Math.max(idx - 1, 0);
    setView(order[next]);
    document.getElementById(`tao-tab-${order[next]}`)?.focus();
  };

  const exportCsv = () => {
    const header = 'activity_id,name,line,sector,station,platform,first_access_night,last_access_night,all_in_nights';
    const rows = ACTIVITIES.map((a) => {
      const [s, e] = occupiedRange(a, policy);
      return [a.id, a.name, a.line, a.sector ?? '', a.station ?? '', a.platform ?? '', s, e, a.dur].join(',');
    });
    download(`tao-programme-policy-${policy.toLowerCase()}-demo.csv`, [header, ...rows].join('\n'), 'text/csv');
    setExportNote(`Programme CSV for policy ${policy} prepared — generated locally, nothing transmitted.`);
  };

  const exportEvidence = () => {
    const payload = {
      validator: 'tao-validator 1.3.2 (deterministic)',
      ruleset: 'PS1-2026.11',
      evidence_hash: EVIDENCE_HASH,
      horizon: { start: '2027-01-04', weeks: WEEKS, access_nights: TOTAL_NIGHTS },
      policies: POLICIES.map((p) => ({
        id: p.id,
        name: p.name,
        objective_score: p.score,
        hard_violations: 0,
        scheduled_nights: distinctNightSet(p.id).size,
      })),
      disputed_warnings: DISPUTED_WARNINGS,
      note: 'Official objective_score outranks disputed warnings. AI output was an untrusted draft; validator output is authoritative.',
    };
    download('tao-validator-evidence-demo.json', JSON.stringify(payload, null, 2), 'application/json');
    setExportNote('Validator evidence JSON prepared — generated locally, nothing transmitted.');
  };

  const monthRange = MONTH_RANGES[monthIdx];
  const monthNights = Array.from(scheduledNights).filter((n) => nightDate(n).getMonth() === monthIdx).length;
  const monthActivities = ACTIVITIES.filter((a) => {
    const [s, e] = occupiedRange(a, policy);
    return Array.from(scheduledNights).some(
      (n) => n >= s && n <= e && nightDate(n).getMonth() === monthIdx,
    );
  }).length;

  const clampFrom = (v: number) => {
    const from = Math.min(v, rangeTo - 3);
    setRangeFrom(Math.max(0, from));
  };
  const clampTo = (v: number) => {
    const to = Math.max(v, rangeFrom + 3);
    setRangeTo(Math.min(WEEKS - 1, to));
  };

  const [selStart, selEnd] = selected ? occupiedRange(selected, policy) : [0, 0];

  return (
    <>
      <div className={styles.workspaceHead}>
        <div>
          <h1 className={styles.screenTitle} data-heading tabIndex={-1}>
            Programme workspace
          </h1>
          <p className={styles.scoreRow}>
            Policy {activePolicy.id} · {activePolicy.name} — official objective_score{' '}
            <code>{activePolicy.score.toFixed(1)}</code> · hard violations 0 · {scheduledNights.size} scheduled nights
            {policy === BEST_POLICY ? <span className={styles.bestBadge}>best official score</span> : null}
          </p>
          <p className={styles.scoreNote}>
            The official objective_score outranks disputed warnings (2 advisory). All dates are week-commencing (W/C).
          </p>
        </div>
        <div className={styles.policySwitch} role="group" aria-label="Policy switch">
          {POLICIES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.segBtn}
              aria-pressed={policy === p.id}
              title={`${p.name} — ${p.blurb} objective_score ${p.score.toFixed(1)}`}
              onClick={() => setPolicy(p.id)}
            >
              {p.id} · {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Programme views">
        {(
          [
            ['night', 'Night detail'],
            ['month', 'Month window'],
            ['horizon', 'Full horizon'],
          ] as Array<[View, string]>
        ).map(([v, label], idx) => (
          <button
            key={v}
            id={`tao-tab-${v}`}
            type="button"
            role="tab"
            aria-selected={view === v}
            aria-controls={`tao-panel-${v}`}
            className={styles.tab}
            onClick={() => setView(v)}
            onKeyDown={(e) => onTabKey(e, idx)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'night' ? (
        <section id="tao-panel-night" role="tabpanel" aria-labelledby="tao-tab-night" className={styles.panel}>
          <div className={styles.nightCtl}>
            <button type="button" className={styles.ghostBtn} onClick={() => setNight((n) => Math.max(1, n - 1))} aria-label="Previous night">
              ←
            </button>
            <label className={styles.rangeField}>
              <span className={styles.visuallyHidden}>Access night ordinal</span>
              <input
                type="range"
                min={1}
                max={TOTAL_NIGHTS}
                value={night}
                onChange={(e) => setNight(Number(e.target.value))}
                aria-label={`Access night ordinal, ${night} of ${TOTAL_NIGHTS}`}
              />
            </label>
            <button type="button" className={styles.ghostBtn} onClick={() => setNight((n) => Math.min(TOTAL_NIGHTS, n + 1))} aria-label="Next night">
              →
            </button>
            <p className={styles.nightReadout}>
              Night <strong>{night}</strong> of {TOTAL_NIGHTS} — {fmtFull(nightDate(night))}
            </p>
          </div>
          {occupants.length > 0 ? (
            <ul className={styles.occList}>
              {occupants.map((a) => (
                <li key={a.id} className={styles.occItem}>
                  <span>
                    <code className={styles.cellId}>{a.id}</code> {a.name}
                  </span>
                  <span className={styles.occSector}>
                    {a.line} · {a.sector ? `sector ${a.sector}` : `${a.station}${a.platform ? ` ${a.platform}` : ''}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptyNote}>No possessions scheduled on this night under policy {policy}.</p>
          )}
        </section>
      ) : null}

      {view === 'month' ? (
        <section id="tao-panel-month" role="tabpanel" aria-labelledby="tao-tab-month" className={styles.panel}>
          <div className={styles.chipRow} role="group" aria-label="Choose month">
            {MONTH_RANGES.map((m, i) => (
              <button
                key={m.label}
                type="button"
                className={styles.chip}
                aria-pressed={monthIdx === i}
                onClick={() => setMonthIdx(i)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className={styles.scoreNote}>
            {monthRange.label}: {monthNights} scheduled nights across {monthActivities} activities (policy {policy}).
          </p>
          <Gantt policy={policy} from={monthRange.from} to={monthRange.to} selectedId={selectedId} onSelect={(a) => setSelectedId(a.id)} />
        </section>
      ) : null}

      {view === 'horizon' ? (
        <section id="tao-panel-horizon" role="tabpanel" aria-labelledby="tao-tab-horizon" className={styles.panel}>
          <div className={styles.rangeControls}>
            <label className={styles.rangeField}>
              From W/C
              <select className={styles.select} value={rangeFrom} onChange={(e) => clampFrom(Number(e.target.value))}>
                {Array.from({ length: WEEKS }, (_, w) => (
                  <option key={w} value={w}>{fmtDay(weekStart(w))} 2027</option>
                ))}
              </select>
            </label>
            <label className={styles.rangeField}>
              To W/C
              <select className={styles.select} value={rangeTo} onChange={(e) => clampTo(Number(e.target.value))}>
                {Array.from({ length: WEEKS }, (_, w) => (
                  <option key={w} value={w}>{fmtDay(weekStart(w))} 2027</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                setRangeFrom(0);
                setRangeTo(WEEKS - 1);
              }}
            >
              Reset to full 30 weeks
            </button>
          </div>
          <Gantt policy={policy} from={rangeFrom} to={rangeTo} selectedId={selectedId} onSelect={(a) => setSelectedId(a.id)} />
        </section>
      ) : null}

      <div className={styles.lowerGrid}>
        <Schematic hiSectors={hiSectors} hiStations={hiStations} />

        <section className={styles.detail} aria-label="Selected activity details">
          <h2 className={styles.traceTitle}>Selected activity</h2>
          {selected ? (
            <dl className={styles.detailGrid}>
              <dt>Activity</dt>
              <dd><code>{selected.id}</code> — {selected.name}</dd>
              <dt>Line · location</dt>
              <dd>
                {selected.line} · {selected.sector ? `sector ${selected.sector}` : selected.station}
                {selected.platform ? ` · platform ${selected.platform}` : ''}
              </dd>
              <dt>First night</dt>
              <dd><code>access_night</code> {selStart} — {fmtFull(nightDate(selStart))}</dd>
              <dt>Final night</dt>
              <dd><code>access_night</code> {selEnd} — {fmtFull(nightDate(selEnd))}</dd>
              <dt>Duration</dt>
              <dd>{selected.dur} nights, all-in (delivery, work and handback included)</dd>
              <dt>Fit</dt>
              <dd>{selected.fit ?? 'Standard fit — no shared nights. No generic padding applied.'}</dd>
              <dt>Crew · plant</dt>
              <dd>{selected.crew} · {selected.plant}</dd>
              <dt>Buffer location</dt>
              <dd>{selected.buffer}</dd>
              {selected.offsets?.[policy] ? (
                <>
                  <dt>Policy {policy} variation</dt>
                  <dd>
                    Moved {Math.abs(selected.offsets?.[policy] ?? 0)}{' '}
                    {(selected.offsets?.[policy] ?? 0) < 0 ? 'earlier' : 'later'} by{' '}
                    {Math.abs(selected.offsets?.[policy] ?? 0)} night(s) versus policy A.
                  </dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className={styles.emptyNote}>Select an activity in the Gantt or night view.</p>
          )}
        </section>
      </div>

      <section className={styles.exports} aria-label="Exports">
        <div className={styles.exportRow}>
          <button type="button" className={styles.ghostBtn} onClick={exportCsv}>
            Export programme (CSV)
          </button>
          <button type="button" className={styles.ghostBtn} onClick={exportEvidence}>
            Export validator evidence (JSON)
          </button>
          <button type="button" className={styles.ghostBtn} aria-expanded={warningsOpen} onClick={() => setWarningsOpen((o) => !o)}>
            Issue log — 2 disputed warnings
          </button>
        </div>
        {warningsOpen ? (
          <div className={styles.warnPanel}>
            <ul className={styles.warnList}>
              {DISPUTED_WARNINGS.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className={styles.scoreNote}>
              Advisory only — the official objective_score outranks disputed warnings, and the validator and solver
              remain authoritative.
            </p>
          </div>
        ) : null}
        <p className={styles.confirmText} aria-live="polite">{exportNote}</p>
      </section>
    </>
  );
}

function ReplanPanel({ files, policy, budget }: { files: Map<string, File>; policy: PolicyId; budget: number }) {
  const [disruption, setDisruption] = useState('delay A001 by 1 week');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState<ReplanPayload | null>(null);

  useEffect(() => {
    setPayload(null);
    setError('');
  }, [policy]);

  const submit = async () => {
    if (!disruption.trim()) return;
    setBusy(true);
    setError('');
    setPayload(null);
    try {
      const next = await runReplan({ files, policy, budget, disruption: disruption.trim() }) as ReplanPayload;
      setPayload(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const replanResult = payload?.replan;
  const releasedFiles = payload?.files;
  return (
    <section className={styles.replanPanel} aria-labelledby="controlled-replan-title">
      <div className={styles.panelHeading}>
        <div>
          <span className={styles.replanEyebrow}>Controlled replan · Policy {policy}</span>
          <h2 id="controlled-replan-title">Controlled disruption replan</h2>
          <p>Describe one change and Project TAO will rebuild the schedule, then independently check it before releasing files.</p>
        </div>
      </div>
      <div className={styles.replanCommand}>
        <label>
          <span>Disruption instruction</span>
          <input aria-label="Disruption instruction" value={disruption} disabled={busy} onChange={(event) => setDisruption(event.target.value)} />
        </label>
        <button type="button" className={styles.primaryBtn} disabled={busy || !disruption.trim()} onClick={() => void submit()}>
          {busy ? 'Replanning and validating…' : 'Replan + validate'}
        </button>
      </div>
      <p className={styles.replanExamples}>Accepted forms: <code>block A001 in week 12</code> or <code>delay A001 by 2 weeks</code>.</p>
      {error ? <p className={styles.intakeError} role="alert">{error} The current validated programme is unchanged.</p> : null}
      {replanResult ? (
        <div className={styles.replanResult}>
          <div className={replanResult.validator_gate.passed ? styles.gatePassed : styles.gateFailed} role="status">
            <strong>{replanResult.validator_gate.passed ? 'Independent validator passed' : 'Independent validator blocked export'}</strong>
            <p>{replanResult.explanation}</p>
          </div>
          {replanResult.changes.length > 0 ? (
            <div className={styles.replanDetails}>
              <h3>Schedule changes</h3>
              <ul>{replanResult.changes.map((change) => <li key={change.activity_id}><code>{change.activity_id}</code><span>{change.before_weeks.join(', ') || '—'} → {change.after_weeks.join(', ') || '—'}</span></li>)}</ul>
            </div>
          ) : <p className={styles.replanNoChange}>No scheduled weeks changed.</p>}
          {replanResult.validator_gate.soft_warnings.length > 0 ? (
            <div className={styles.replanDetails}><h3>Advisory warnings</h3><ul>{replanResult.validator_gate.soft_warnings.map((item, index) => <li key={`${item.rule}-${index}`}><code>{item.rule}</code><span>{item.detail}</span></li>)}</ul></div>
          ) : null}
          {replanResult.validator_gate.hard_violations.length > 0 ? (
            <div className={`${styles.replanDetails} ${styles.replanViolations}`}><h3>Hard violations</h3><ul>{replanResult.validator_gate.hard_violations.map((item, index) => <li key={`${item.rule}-${index}`}><code>{item.rule}</code><span>{item.detail}</span></li>)}</ul></div>
          ) : null}
          {replanResult.validator_gate.passed && releasedFiles ? (
            <div className={styles.exportRow}>
              {OUTPUT_FILES.filter((name) => releasedFiles[name]).map((name) => (
                <button key={name} type="button" className={styles.ghostBtn} onClick={() => download(`REPLAN_${policy}_${name}`, releasedFiles[name], 'text/csv')}>Download REPLAN_{name}</button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

type ScheduleAccess = { access_seq: number; week: number; eclo: boolean; access_night: number };
type ScheduleActivity = {
  activity_id: string;
  activity_type: string;
  startWeek: number;
  endWeek: number;
  accesses: ScheduleAccess[];
};

/** One access record = one night of work. ECLO nights yield 1.5×, shown as a dot plus a half-dot. */
function AccessMark({ access }: { access: ScheduleAccess }) {
  if (!access.eclo) return <i className={styles.liveAccessDot} />;
  return (
    <span className={styles.ecloPair} title="ECLO night — 1.5× work yield">
      <i className={styles.liveAccessDot} />
      <i className={styles.liveHalfDot} />
    </span>
  );
}

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatDayDate(horizonStart: string, week: number, dayIdx: number): string {
  const name = WEEKDAY_SHORT[dayIdx] ?? `Day ${dayIdx + 1}`;
  const base = new Date(`${horizonStart}T00:00:00`);
  if (isNaN(base.getTime())) return name;
  const target = new Date(base.getTime() + ((week - 1) * 7 + dayIdx) * 86400000);
  return `${name} ${target.getDate()} ${target.toLocaleString('en-GB', { month: 'short' })}`;
}

function DayNoteBubble({
  activityId,
  week,
  weekLabel,
  horizonStart,
  existing,
  anchor,
  onPick,
  onClear,
  onClose,
}: {
  activityId: string;
  week: number;
  weekLabel: string;
  horizonStart: string;
  existing: { day: number; source: 'user' | 'suggested' } | null;
  anchor: { x: number; y: number };
  onPick: (dayIdx: number) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const width = 288;
  const left = Math.max(8, Math.min(anchor.x - width / 2, window.innerWidth - width - 8));
  const below = anchor.y + 8;
  const top = Math.max(8, below + 400 > window.innerHeight ? anchor.y - 408 : below);
  return (
    <>
      <div className={styles.bubbleBackdrop} onClick={onClose} aria-hidden="true" />
      <div
        className={styles.dayBubble}
        role="dialog"
        aria-label={`Preferred workday for ${activityId}, week ${week}`}
        style={{ left, top }}
        tabIndex={-1}
        autoFocus
        onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
      >
        <div className={styles.dayBubbleHead}>
          <div>
            <strong>Preferred workday</strong>
            <span>{activityId} · Week {week} ({weekLabel})</span>
          </div>
          <button type="button" aria-label="Close day picker" onClick={onClose}>×</button>
        </div>
        <div className={styles.dayOptions} role="group" aria-label="Workday options">
          {WEEKDAY_SHORT.map((day, dayIdx) => (
            <button
              key={day}
              type="button"
              aria-pressed={existing?.day === dayIdx}
              onClick={() => onPick(dayIdx)}
            >
              <strong>{day}</strong>
              <small>{formatDayDate(horizonStart, week, dayIdx)}</small>
            </button>
          ))}
        </div>
        {existing?.source === 'suggested' ? <p className={styles.dayBubbleNote}>Suggested workday — pick a day to confirm it as yours.</p> : null}
        <p className={styles.dayBubbleNote}>A planning note only — the validated schedule and its exports are unchanged.</p>
        <div className={styles.dayBubbleActions}>
          {existing != null ? <button type="button" className={styles.linkBtn} onClick={onClear}>Clear note</button> : null}
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}

function ScheduleWeekGrid({
  activities,
  horizonWeeks,
  horizonStart,
  selectedActivity,
  selectedWeek,
  onSelectActivity,
  onToggleWeek,
}: {
  activities: ScheduleActivity[];
  horizonWeeks: number;
  horizonStart: string;
  selectedActivity: string | null;
  selectedWeek: number | null;
  onSelectActivity: (id: string) => void;
  onToggleWeek: (week: number) => void;
}) {
  const weekColumns = `190px repeat(${horizonWeeks}, minmax(24px, 1fr))`;
  return (
    <div className={styles.scheduleView}>
      <div className={styles.scheduleViewHead}>
        <h3>By week</h3>
        <span>{horizonWeeks} weeks · dots are access records</span>
      </div>
      <div className={styles.scheduleViewBody}>
        <div className={styles.liveGantt} role="region" aria-label="Schedule by week" tabIndex={0}>
          <div className={styles.liveGanttHeadRow} style={{ gridTemplateColumns: weekColumns }}>
            <strong>Activity</strong>
            {Array.from({ length: horizonWeeks }, (_, index) => {
              const week = index + 1;
              return (
                <button
                  key={week}
                  type="button"
                  className={styles.weekHeadBtn}
                  aria-pressed={selectedWeek === week}
                  aria-label={`Highlight week ${week}`}
                  title={`W/C ${formatWeekStart(horizonStart, week)} — select to highlight this week everywhere`}
                  onClick={() => onToggleWeek(week)}
                >
                  W{week}
                </button>
              );
            })}
          </div>
          {activities.map((activity) => {
            const selected = activity.activity_id === selectedActivity;
            const weekMatch = selectedWeek != null && activity.accesses.some((access) => access.week === selectedWeek);
            return (
              <button
                type="button"
                key={activity.activity_id}
                className={`${styles.liveGanttRow} ${selected ? styles.liveGanttSelected : ''} ${weekMatch ? styles.liveGanttRowMatch : ''}`}
                style={{ gridTemplateColumns: weekColumns }}
                onClick={() => onSelectActivity(activity.activity_id)}
              >
                <span className={styles.liveActivityLabel}><strong>{activity.activity_id}</strong><small>{activity.activity_type}</small></span>
                {Array.from({ length: horizonWeeks }, (_, index) => {
                  const week = index + 1;
                  const accesses = activity.accesses.filter((access) => access.week === week);
                  const occupied = week >= activity.startWeek && week <= activity.endWeek;
                  const hasEclo = accesses.some((access) => access.eclo);
                  return <span key={week} className={`${occupied ? styles.liveOccupiedWeek : ''} ${selectedWeek === week ? styles.liveWeekCellSel : ''}`} title={accesses.length ? `${accesses.length} access record(s)${hasEclo ? ' · includes ECLO (1.5× yield)' : ''} · W/C ${formatWeekStart(horizonStart, week)}` : undefined}>{accesses.map((access) => <AccessMark key={access.access_seq} access={access} />)}</span>;
                })}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ScheduleDayGrid({
  activities,
  horizonWeeks,
  horizonStart,
  focusedWeek,
  selectedActivity,
  dayNotes,
  onSelectActivity,
  onStepWeek,
  onOpenDayBubble,
  onPlanDay,
  onSuggest,
}: {
  activities: ScheduleActivity[];
  horizonWeeks: number;
  horizonStart: string;
  focusedWeek: number;
  selectedActivity: string | null;
  dayNotes: Record<string, { day: number; source: 'user' | 'suggested'; reason?: string }>;
  onSelectActivity: (id: string) => void;
  onStepWeek: (delta: number) => void;
  onOpenDayBubble: (activityId: string, week: number, anchor: { x: number; y: number }) => void;
  onPlanDay: (activityId: string, week: number, dayIdx: number | null) => void;
  onSuggest: () => void;
}) {
  const dayColumns = `168px 62px repeat(7, minmax(40px, 72px))`;
  const weekActivities = activities.filter((activity) => activity.accesses.some((access) => access.week === focusedWeek));
  const totalNights = weekActivities.reduce(
    (total, activity) => total + activity.accesses.filter((access) => access.week === focusedWeek).length,
    0,
  );
  const plannedNights = weekActivities.reduce((total, activity) => {
    const note = dayNotes[`${activity.activity_id}|${focusedWeek}`];
    if (note == null) return total;
    return total + activity.accesses.filter((access) => access.week === focusedWeek).length;
  }, 0);
  const suggestableCount = weekActivities.filter(
    (activity) => dayNotes[`${activity.activity_id}|${focusedWeek}`] == null,
  ).length;
  return (
    <div className={`${styles.scheduleView} ${styles.dayView}`}>
      <div className={styles.scheduleViewHead}>
        <h3>By day</h3>
        <div className={styles.dayNav} role="group" aria-label="Focused week">
          <button type="button" aria-label="Previous week" disabled={focusedWeek <= 1} onClick={() => onStepWeek(-1)}>←</button>
          <span>W{focusedWeek} · W/C {formatWeekStart(horizonStart, focusedWeek)}</span>
          <button type="button" aria-label="Next week" disabled={focusedWeek >= horizonWeeks} onClick={() => onStepWeek(1)}>→</button>
        </div>
      </div>
      <p className={styles.dayProgress} role="status" aria-live="polite">
        {plannedNights} of {totalNights} nights planned
        {totalNights > 0 && plannedNights < totalNights ? ` · ${totalNights - plannedNights} to plan` : null}
        {totalNights > 0 && plannedNights === totalNights ? ' · week fully planned' : null}
      </p>
      <div className={styles.scheduleViewBody}>
        <div className={styles.liveGantt} role="region" aria-label={`Workdays for week ${focusedWeek}`} tabIndex={0}>
          <div className={styles.liveGanttHeadRow} style={{ gridTemplateColumns: dayColumns }}>
            <strong>Activity</strong>
            <span className={styles.dayGutterHead}>To plan</span>
            {WEEKDAY_SHORT.map((day, dayIdx) => (
              <span key={day} className={styles.dayColHead} title={formatDayDate(horizonStart, focusedWeek, dayIdx)}>{day}</span>
            ))}
          </div>
          {weekActivities.length === 0 ? (
            <p className={styles.emptyNote}>No scheduled work in week {focusedWeek} — step to another week.</p>
          ) : null}
          {weekActivities.map((activity) => {
            const selected = activity.activity_id === selectedActivity;
            const accesses = activity.accesses.filter((access) => access.week === focusedWeek);
            const hasEclo = accesses.some((access) => access.eclo);
            const note = dayNotes[`${activity.activity_id}|${focusedWeek}`];
            const openBubbleFor = (anchorEl: HTMLElement) => {
              onSelectActivity(activity.activity_id);
              const rect = anchorEl.getBoundingClientRect();
              onOpenDayBubble(activity.activity_id, focusedWeek, { x: rect.left + 220, y: rect.bottom });
            };
            return (
              <div
                key={activity.activity_id}
                className={`${styles.liveGanttRow} ${styles.dayGridRow} ${selected ? styles.liveGanttSelected : ''}`}
                style={{ gridTemplateColumns: dayColumns }}
                title={`${activity.activity_id} · Week ${focusedWeek} — pick a weekday to plan, or open details`}
              >
                <div className={styles.dayActivityCell}>
                  <button
                    type="button"
                    className={styles.dayActivityBtn}
                    aria-pressed={selected}
                    aria-label={`Select ${activity.activity_id}, week ${focusedWeek}, ${accesses.length} access record(s)${hasEclo ? ', includes ECLO' : ''}.`}
                    onClick={() => onSelectActivity(activity.activity_id)}
                  >
                    <strong>{activity.activity_id}</strong>
                    <small>{activity.activity_type} · {accesses.length} night{accesses.length === 1 ? '' : 's'}</small>
                    {note != null ? <small className={`${styles.agendaNote} ${note.source === 'suggested' ? styles.agendaNoteSuggested : ''}`} title={note.source === 'suggested' ? `Suggested: ${note.reason ?? ''}` : 'Your pick'}>{formatDayDate(horizonStart, focusedWeek, note.day)}</small> : null}
                  </button>
                  <button
                    type="button"
                    className={styles.dayDetailsBtn}
                    aria-label={`Open day picker for ${activity.activity_id}, week ${focusedWeek}`}
                    title={`Open day picker for ${activity.activity_id}, week ${focusedWeek}`}
                    onClick={(event) => openBubbleFor(event.currentTarget)}
                  >
                    ⋯
                  </button>
                </div>
                {note == null ? (
                  <button
                    type="button"
                    className={styles.dayGutterCell}
                    data-to-plan={`${activity.activity_id}|${focusedWeek}`}
                    title="Nights not yet day-planned — open day picker for detail"
                    aria-label={`${activity.activity_id}, week ${focusedWeek}, ${accesses.length} access record(s)${hasEclo ? ', includes ECLO' : ''}. Plan a workday.`}
                    onClick={(event) => openBubbleFor(event.currentTarget)}
                  >
                    {accesses.map((access) => <AccessMark key={access.access_seq} access={access} />)}
                  </button>
                ) : (
                  <span className={styles.dayGutterCell} title="All nights for this activity are day-planned" aria-hidden="true" />
                )}
                {WEEKDAY_SHORT.map((day, dayIdx) => {
                  const isPlannedHere = note?.day === dayIdx;
                  const label = isPlannedHere
                    ? `Unplan ${activity.activity_id} on ${formatDayDate(horizonStart, focusedWeek, dayIdx)} — move back to To plan`
                    : `Plan ${activity.activity_id} on ${formatDayDate(horizonStart, focusedWeek, dayIdx)}${note == null ? '' : ' — move from ' + formatDayDate(horizonStart, focusedWeek, note.day)}`;
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`${styles.dayCell} ${isPlannedHere ? styles.dayCellPlanned : ''}`}
                      data-plan-day={`${activity.activity_id}|${focusedWeek}|${dayIdx}`}
                      aria-pressed={isPlannedHere}
                      aria-label={label}
                      title={`${formatDayDate(horizonStart, focusedWeek, dayIdx)}${isPlannedHere ? ` · ${accesses.length} planned night(s)` : ' — select to plan one night here'}`}
                      onClick={() => onPlanDay(activity.activity_id, focusedWeek, isPlannedHere ? null : dayIdx)}
                    >
                      {isPlannedHere ? accesses.map((access) => <AccessMark key={access.access_seq} access={access} />) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className={styles.daySuggestRow}>
        <button
          type="button"
          className={styles.ghostBtn}
          onClick={onSuggest}
          disabled={suggestableCount === 0}
        >
          {suggestableCount === 0 ? 'Week fully planned' : `Suggest workdays (${suggestableCount} unplanned)`}
        </button>
        <span>Job-type order: contract priority, Live works, sole possessions — clashing possessions separated, shared possessions kept together, workfronts respected. Your picks are never overwritten.</span>
      </div>
    </div>
  );
}

function LiveResultsScreen({
  results,
  errors,
  inputs,
  files,
  budget,
  replanBudget,
  resultSelection,
  onRestart,
}: {
  results: Partial<Record<PolicyId, SolveResult>>;
  errors: Partial<Record<PolicyId, string>>;
  inputs: Record<string, string>;
  files: Map<string, File>;
  budget: number;
  replanBudget: number;
  resultSelection: ResultSelection;
  onRestart: () => void;
}) {
  const bestPolicy = selectBestPolicy(results as Record<string, SolveResult>) as PolicyId | null;
  const initialPolicy = resultSelection === 'best' ? bestPolicy : results.A ? 'A' : bestPolicy;
  const [policy, setPolicy] = useState<PolicyId>(initialPolicy ?? 'A');
  const [selectedActivity, setSelectedActivity] = useState<string | null>(null);
  const [scheduleViews, setScheduleViews] = useState<Array<'day' | 'week'>>(['day']);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [focusedWeek, setFocusedWeek] = useState<number | null>(null);
  const [dayNotes, setDayNotes] = useState<Record<string, { day: number; source: 'user' | 'suggested'; reason?: string }>>({});
  const [dayBubble, setDayBubble] = useState<{ activityId: string; week: number; anchor: { x: number; y: number } } | null>(null);
  const selectedResult = results[policy];

  useEffect(() => {
    if (results[policy]) return;
    const next = bestPolicy ?? (Object.keys(results)[0] as PolicyId | undefined);
    if (next) setPolicy(next);
  }, [bestPolicy, policy, results]);

  const model = useMemo(() => {
    if (!selectedResult?.files) return null;
    try {
      return buildPlanningModel(inputs, selectedResult.files);
    } catch {
      return null;
    }
  }, [inputs, selectedResult]);

  const activities = model?.activities.filter((activity) => activity.accesses.length > 0) ?? [];
  const active = activities.find((activity) => activity.activity_id === selectedActivity) ?? null;
  const activeLocations = new Set(active?.occupiedLocations ?? []);
  const score = selectedResult?.report.soft_scores.objective_score;
  const horizonWeeks = model?.horizonWeeks ?? 30;
  const horizonStart = model?.horizonStart ?? '2027-01-04';

  const toggleScheduleView = (view: 'day' | 'week') => {
    setScheduleViews((current) => {
      if (current.includes(view)) {
        if (current.length === 1) return current;
        return current.filter((item) => item !== view);
      }
      return view === 'day' ? ['day', ...current] : [...current, 'week'];
    });
  };

  const toggleWeek = (week: number) => {
    setSelectedWeek((current) => (current === week ? null : week));
    setFocusedWeek(week);
  };

  const workWeeks = Array.from(new Set(
    activities.flatMap((activity) => activity.accesses.map((access) => access.week).filter((week) => week > 0)),
  )).sort((a, b) => a - b);
  const dayWeek = focusedWeek ?? workWeeks[0] ?? 1;

  const stepWeek = (delta: number) => {
    const next = Math.min(horizonWeeks, Math.max(1, dayWeek + delta));
    setFocusedWeek(next);
    setSelectedWeek(next);
  };

  const planDay = (activityId: string, week: number, dayIdx: number | null) => {
    setSelectedActivity(activityId);
    setDayNotes((current) => {
      const next = { ...current };
      const key = `${activityId}|${week}`;
      if (dayIdx == null) delete next[key];
      else next[key] = { day: dayIdx, source: 'user' };
      return next;
    });
  };

  const suggestWorkdays = () => {
    const occupancyRows = parseCsv(selectedResult?.files?.['SCHEDULE_OCCUPANCY.csv'] ?? '');
    const occupancyByActivity = new Map<string, Array<{ location: string; group: string }>>();
    for (const row of occupancyRows) {
      if (Number(row.week) !== dayWeek) continue;
      const list = occupancyByActivity.get(row.activity_id) ?? [];
      list.push({ location: row.location_id ?? '', group: row.co_share_group ?? '' });
      occupancyByActivity.set(row.activity_id, list);
    }
    const contractByNumber = new Map<string, Record<string, string>>();
    for (const row of parseCsv(inputs['07_PROJECT_DETAILS.csv'] ?? '')) {
      contractByNumber.set(row.contract_number, row);
    }
    const candidates = [];
    for (const activity of activities) {
      const weekAccesses = activity.accesses.filter((access) => access.week === dayWeek);
      if (weekAccesses.length === 0) continue;
      const key = `${activity.activity_id}|${dayWeek}`;
      if (dayNotes[key]?.source === 'user') continue;
      const contract = contractByNumber.get(activity.contract_number) ?? {};
      const slots = occupancyByActivity.get(activity.activity_id) ?? [];
      const groups: Record<string, string> = {};
      for (const slot of slots) groups[slot.location] = slot.group;
      candidates.push({
        key,
        activityId: activity.activity_id,
        contractNumber: activity.contract_number,
        contractPriority: Number(contract.contract_priority) || 99,
        nature: contract.nature_of_activity ?? '',
        accessType: contract.access_type ?? '',
        seq: Math.min(...weekAccesses.map((access) => access.access_seq)),
        locations: slots.map((slot) => slot.location),
        groups,
        workfronts: Number(contract.number_of_workfronts) || 99,
      });
    }
    const picks = recommendWorkdays(candidates);
    if (picks.length === 0) return;
    setDayNotes((current) => {
      const next = { ...current };
      for (const pick of picks) next[pick.key] = { day: pick.day, source: 'suggested', reason: pick.reason };
      return next;
    });
  };

  const clearScheduleSelection = () => {
    setSelectedWeek(null);
  };

  const clearPlannerState = () => {
    setSelectedActivity(null);
    clearScheduleSelection();
    setFocusedWeek(null);
    setDayNotes({});
    setDayBubble(null);
  };

  const weekActivities = selectedWeek == null
    ? []
    : activities.filter((activity) => activity.accesses.some((access) => access.week === selectedWeek));
  const weekAccessCount = selectedWeek == null
    ? 0
    : weekActivities.reduce((total, activity) => total + activity.accesses.filter((access) => access.week === selectedWeek).length, 0);

  const dayNoteEntries = Object.entries(dayNotes);

  const exportDayNotes = () => {
    const header = 'activity_id,week,week_commencing,preferred_day,preferred_date,source,basis';
    const rows = dayNoteEntries.map(([key, note]) => {
      const separator = key.lastIndexOf('|');
      const activityId = key.slice(0, separator);
      const week = Number(key.slice(separator + 1));
      return [activityId, week, formatWeekStart(horizonStart, week), WEEKDAY_SHORT[note.day], formatDayDate(horizonStart, week, note.day), note.source, `"${(note.reason ?? '').replaceAll('"', '""')}"`].join(',');
    });
    download(`TAO_DAY_NOTES_${policy}.csv`, [header, ...rows].join('\n'), 'text/csv');
  };

  const stationActive = (lineCode: string, stationId: string) => {
    const platformPrefix = `PLAT:${lineCode}:${stationId}:`;
    return Array.from(activeLocations).some((location) => location === stationId || location.startsWith(platformPrefix));
  };

  return (
    <>
      <div className={styles.screenHead}>
        <span className={styles.draftBadge}>Deterministically validated programme</span>
        <h1 className={styles.screenTitle} data-heading tabIndex={-1}>Programme workspace</h1>
        <p className={styles.lede}>
          Compare the scheduling options, then inspect the activities against your network before exporting.
        </p>
      </div>

      <section className={styles.policyChooser} aria-label="Programme policy">
        {POLICIES.map((item) => {
          const result = results[item.id];
          const policyScore = result?.report.soft_scores.objective_score;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={policy === item.id}
              disabled={!result || Boolean(errors[item.id])}
              onClick={() => { setPolicy(item.id); clearPlannerState(); }}
            >
              <span className={styles.policyLetter}>{item.id}</span>
              <span className={styles.policyCopy}><strong>{item.name}</strong><small>{item.blurb}</small></span>
              <span className={styles.policyScore}>{typeof policyScore === 'number' ? policyScore : '—'}{bestPolicy === item.id ? <small>best score</small> : null}</span>
            </button>
          );
        })}
      </section>

      {selectedResult ? (
        <>
          <section className={styles.liveMetrics} aria-label="Selected policy metrics">
            <article><span>Official objective score</span><strong>{typeof score === 'number' ? score : '—'}</strong></article>
            <article><span>Hard violations</span><strong>{selectedResult.report.hard_violations.length}</strong></article>
            <article><span>Scheduled nights</span><strong>{selectedResult.report.detail.nights_scheduled}</strong></article>
            <article><span>ECLO nights</span><strong>{selectedResult.report.detail.eclo_nights}</strong></article>
          </section>

          {selectedResult.report.feasible ? (
          <>
          <section className={styles.livePanel}>
            <div className={styles.panelHeading}>
              <div><h2>Schedule</h2><p>Derived from the returned access schedule. Select an activity to highlight its railway footprint, or select a week to highlight its work everywhere.</p></div>
              <div className={styles.viewToggles} role="group" aria-label="Schedule views">
                <button type="button" aria-pressed={scheduleViews.includes('day')} onClick={() => toggleScheduleView('day')}>By day</button>
                <button type="button" aria-pressed={scheduleViews.includes('week')} onClick={() => toggleScheduleView('week')}>By week</button>
              </div>
            </div>
            {selectedWeek != null ? (
              <div className={styles.scheduleFocus} role="status">
                <strong>Week {selectedWeek} · W/C {formatWeekStart(horizonStart, selectedWeek)}</strong>
                <span>{weekActivities.length} {weekActivities.length === 1 ? 'activity' : 'activities'} · {weekAccessCount} access records</span>
                <button type="button" className={styles.linkBtn} onClick={clearScheduleSelection}>Clear selection</button>
              </div>
            ) : null}
            <div className={styles.scheduleGrid}>
              {scheduleViews.includes('day') ? (
                <ScheduleDayGrid
                  activities={activities}
                  horizonWeeks={horizonWeeks}
                  horizonStart={horizonStart}
                  focusedWeek={dayWeek}
                  selectedActivity={selectedActivity}
                  dayNotes={dayNotes}
                  onSelectActivity={setSelectedActivity}
                  onStepWeek={stepWeek}
                  onOpenDayBubble={(activityId, week, anchor) => setDayBubble({ activityId, week, anchor })}
                  onPlanDay={planDay}
                  onSuggest={suggestWorkdays}
                />
              ) : null}
              {scheduleViews.includes('week') ? (
                <ScheduleWeekGrid
                  activities={activities}
                  horizonWeeks={horizonWeeks}
                  horizonStart={horizonStart}
                  selectedActivity={selectedActivity}
                  selectedWeek={selectedWeek}
                  onSelectActivity={setSelectedActivity}
                  onToggleWeek={toggleWeek}
                />
              ) : null}
            </div>
            {dayNoteEntries.length > 0 ? (
              <div className={styles.dayNotes} aria-label="Planned workdays">
                <div className={styles.dayNotesHead}>
                  <strong>Planned workdays ({dayNoteEntries.length})</strong>
                  <button type="button" className={styles.ghostBtn} onClick={exportDayNotes}>Export day notes (CSV)</button>
                </div>
                <ul className={styles.dayNotesList}>
                  {dayNoteEntries.map(([key, note]) => {
                    const separator = key.lastIndexOf('|');
                    const activityId = key.slice(0, separator);
                    const week = Number(key.slice(separator + 1));
                    return (
                      <li key={key} title={note.source === 'suggested' ? `Suggested: ${note.reason ?? ''}` : 'Your pick'}>
                        <code>{activityId}</code>
                        <span>Week {week} → {formatDayDate(horizonStart, week, note.day)}</span>
                        {note.source === 'suggested' ? <em className={styles.noteSource}>Suggested</em> : null}
                        <button
                          type="button"
                          aria-label={`Remove workday note for ${activityId}, week ${week}`}
                          onClick={() => setDayNotes((current) => {
                            const next = { ...current };
                            delete next[key];
                            return next;
                          })}
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className={styles.dayNotesFootnote}>Planning notes only — kept out of the eight source files and the validated exports.</p>
              </div>
            ) : null}
            <p className={styles.scheduleCaption}>The day view focuses one week at a time — step with the arrows. Nights you have not day-planned sit in To plan; planned nights move onto their weekday. Dots are access records; a dot plus a half-dot is one ECLO night (1.5× yield). The schedule itself never fixes a calendar day. {activities.length} scheduled activities · {horizonWeeks} weeks.</p>
          </section>
          {dayBubble ? (
            <DayNoteBubble
              activityId={dayBubble.activityId}
              week={dayBubble.week}
              weekLabel={formatWeekStart(horizonStart, dayBubble.week)}
              horizonStart={horizonStart}
              existing={dayNotes[`${dayBubble.activityId}|${dayBubble.week}`] ?? null}
              anchor={dayBubble.anchor}
              onPick={(dayIdx) => {
                setDayNotes((current) => ({ ...current, [`${dayBubble.activityId}|${dayBubble.week}`]: { day: dayIdx, source: 'user' } }));
                setDayBubble(null);
              }}
              onClear={() => {
                setDayNotes((current) => {
                  const next = { ...current };
                  delete next[`${dayBubble.activityId}|${dayBubble.week}`];
                  return next;
                });
                setDayBubble(null);
              }}
              onClose={() => setDayBubble(null)}
            />
          ) : null}

          <section className={styles.livePanel}>
            <div className={styles.panelHeading}>
              <div><h2>Railway schematic</h2><p>Topological, not geographic. Interchange stations remain visible on every line they connect.</p></div>
              <span>{model?.lines.length ?? 0} lines</span>
            </div>
            <div className={styles.liveLines}>
              {model?.lines.map((line, lineIndex) => {
                const lineColor = LINE_COLORS[lineIndex % LINE_COLORS.length];
                const isActiveStation = (stationId: string) => stationActive(line.line_code, stationId);
                return (
                <article key={line.line_code} className={styles.liveLineRow}>
                  <header className={styles.liveLineTitle}>
                    <strong style={{ background: lineColor }}>{line.line_code}</strong>
                    <span>{line.line_name || 'Unnamed line'}</span>
                  </header>
                  <div className={styles.liveLineTrack}>
                    {line.stations.map((station, index) => {
                      const previous = index > 0 ? line.stations[index - 1] : null;
                      const active = isActiveStation(station.station_id);
                      const segmentActive = active || (previous != null && isActiveStation(previous.station_id));
                      return (
                      <div key={`${line.line_code}-${station.station_id}`} className={styles.liveStation}>
                        {previous ? (
                          <span
                            className={`${styles.liveRail} ${segmentActive ? styles.liveRailActive : ''}`}
                            style={segmentActive ? undefined : { background: lineColor }}
                            aria-hidden="true"
                          />
                        ) : null}
                        <i
                          className={`${station.is_interchange ? styles.liveInterchange : ''} ${active ? styles.liveStationActive : ''}`}
                          style={active ? undefined : { borderColor: lineColor }}
                          aria-hidden="true"
                        />
                        <span className={styles.liveStationLabel}>
                          {station.station_id}
                          {station.is_interchange ? <small>interchange</small> : null}
                        </span>
                      </div>
                      );
                    })}
                  </div>
                </article>
                );
              })}
            </div>
            <div className={styles.schemLegend} aria-label="Schematic legend">
              {(model?.lines ?? []).map((line, lineIndex) => (
                <span key={line.line_code}>
                  <i style={{ background: LINE_COLORS[lineIndex % LINE_COLORS.length] }} aria-hidden="true" />
                  {line.line_code} · {line.line_name || 'Unnamed line'}
                </span>
              ))}
              <span><i className={styles.legendInterchange} aria-hidden="true" />Interchange station</span>
              <span><i className={styles.legendActive} aria-hidden="true" />Selected footprint</span>
            </div>
            <div className={styles.liveSelection}>
              {active ? (
                <><strong>{active.activity_id} · {active.activity_type}</strong><span>Weeks {active.startWeek}–{active.endWeek} · {active.accesses.length} accesses</span><div>{active.occupiedLocations.map((location) => <code key={location}>{location}</code>)}</div></>
              ) : <p>Select an activity in the Gantt to highlight its occupied sectors and platforms.</p>}
            </div>
          </section>
          </>) : (
          <section className={styles.livePanel} aria-label="Why this policy has no schedule">
            <div className={styles.panelHeading}>
              <div>
                <h2>No feasible schedule</h2>
                <p>Policy {policy} · {POLICIES.find((item) => item.id === policy)?.name ?? ''} could not place every access within the rules, so no programme, schematic or export is shown for it.</p>
              </div>
              <span>{selectedResult.report.hard_violations.length} blocker{selectedResult.report.hard_violations.length === 1 ? '' : 's'}</span>
            </div>
            <div className={styles.validationBlock} role="alert">
              <strong>Export blocked by the independent validator</strong>
              <ul>{selectedResult.report.hard_violations.map((violation, index) => <li key={`${violation.rule}-${index}`}>{violation.rule}: {violation.detail}</li>)}</ul>
            </div>
            <p className={styles.scoreNote}>
              {POLICIES.filter((item) => item.id !== policy && results[item.id]?.report?.feasible).map((item) => item.id).join(', ')
                ? `Policy ${POLICIES.filter((item) => item.id !== policy && results[item.id]?.report?.feasible).map((item) => item.id).join(', ')} is valid — use the policy switcher above to inspect it.`
                : 'None of the three policies produced a valid schedule. Loosen the binding constraint in the eight source files and process again.'}
            </p>
            <div className={styles.exportRow}>
              <button type="button" className={styles.linkBtn} onClick={onRestart}>Process another dataset</button>
            </div>
          </section>
          )}

          <section className={styles.exports} aria-label="Validated exports">
            <div className={styles.exportRow}>
              {OUTPUT_FILES.filter((name) => selectedResult.files[name]).map((name) => (
                <button key={name} type="button" className={styles.ghostBtn} onClick={() => download(`${policy}_${name}`, selectedResult.files[name], 'text/csv')}>Download {name}</button>
              ))}
              <button type="button" className={styles.linkBtn} onClick={onRestart}>Process another dataset</button>
            </div>
          </section>
          <ReplanPanel files={files} policy={policy} budget={replanBudget} />
        </>
      ) : <p className={styles.intakeError}>No validated policy result is available.</p>}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Deterministic recovery                                               */
/* ------------------------------------------------------------------ */

function LiveRecoveryScreen({
  context,
  onRetry,
  onBack,
  onAiRepair,
}: {
  context: RecoveryContext;
  onRetry: () => void;
  onBack: () => void;
  onAiRepair?: () => void;
}) {
  const [explanation, setExplanation] = useState<{ provider: string; explanation: string } | null>(null);
  const [explainBusy, setExplainBusy] = useState(false);
  const [explainError, setExplainError] = useState('');
  const [explainConsent, setExplainConsent] = useState(false);
  const stages = ['Upload', 'Validate', 'Optimise', 'Review'];
  const stoppedAt = context.stage === 'validation' ? 1 : 2;

  const requestExplanation = async () => {
    setExplainBusy(true);
    setExplainError('');
    try {
      const response = await explainEvidence({ evidence: context.evidence, consent: explainConsent });
      setExplanation(response);
    } catch (cause) {
      setExplainError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExplainBusy(false);
    }
  };

  return (
    <>
      <div className={styles.screenHead}>
        <h1 className={styles.screenTitle} data-heading tabIndex={-1}>Pipeline recovery</h1>
        <p className={styles.lede}>
          Project TAO stopped at the failed checkpoint. Your uploaded files remain in this browser session and no invalid export was released.
        </p>
      </div>

      <div className={styles.recoveryWorkspace} aria-live="polite">
          <div className={styles.routeState} aria-label={`Stopped at ${context.stage}`}>
            {stages.map((stage, index) => (
              <div key={stage} className={index < stoppedAt ? styles.routeDone : index === stoppedAt ? styles.routeStopped : styles.routeWaiting}>
                <span>{index < stoppedAt ? '✓' : String(index + 1).padStart(2, '0')}</span>
                <strong>{stage}</strong>
              </div>
            ))}
          </div>

          <article className={`${styles.recoverySummary} ${styles.recovery_blocked}`}>
            <div className={styles.recoveryEyebrow}><span>ACTION REQUIRED</span><small>{context.stage}</small></div>
            <h2>{context.title}</h2>
            <p>{context.summary}</p>
            <div className={styles.preservedWork}><strong>What remains safe</strong><p>The selected source files and any earlier deterministic checkpoint remain available. Project TAO did not replace or export an invalid plan.</p></div>
          </article>

          <div className={styles.issueList}>
            <header><span>Checked evidence</span><small>{context.issues.length} issue{context.issues.length === 1 ? '' : 's'}</small></header>
            {context.issues.map((issue, index) => (
              <article key={`${issue.scope}-${index}`}>
                <div><strong>{issue.scope}</strong><p>{issue.detail}</p></div>
              </article>
            ))}
          </div>

          <div className={styles.recoveryActions}>
            <button type="button" className={styles.primaryBtn} onClick={onRetry}>Retry deterministic pipeline</button>
            {context.stage === 'validation' && onAiRepair ? <button type="button" className={styles.ghostBtn} onClick={onAiRepair}>Review data with AI assistance</button> : null}
            <button type="button" className={styles.ghostBtn} onClick={() => downloadJson('project-tao-recovery-evidence.json', context.evidence)}>Download checked evidence</button>
            <button type="button" className={styles.linkBtn} onClick={onBack}>Return to dataset intake</button>
          </div>

          <div className={styles.aiBoundary}>
            <span>AI</span>
            <div>
              <strong>Explain checked evidence</strong>
              <p>Without consent, Project TAO produces a local deterministic summary. With consent, only the structured evidence above is sent to Gemini on Google Cloud Vertex AI—never the uploaded CSV files.</p>
              <label className={styles.consentRow}><input type="checkbox" checked={explainConsent} onChange={(event) => setExplainConsent(event.target.checked)} disabled={explainBusy} /><span>Use Gemini on Vertex AI to explain this structured evidence.</span></label>
              <button type="button" className={styles.aiDraftDownload} disabled={explainBusy} onClick={() => void requestExplanation()}>{explainBusy ? 'Explaining…' : 'Explain evidence'}</button>
              {explainError ? <small role="alert">{explainError}</small> : null}
              {explanation ? <div className={styles.recoveryExplanation} role="status"><small>{explanation.provider === 'gemini-vertex' ? 'Gemini explanation' : 'Deterministic explanation'}</small><p>{explanation.explanation}</p></div> : null}
            </div>
          </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function MockupPage() {
  const reduced = useReducedMotion();
  const [screen, setScreen] = useState<Screen>('welcome');
  const [settingsReturnScreen, setSettingsReturnScreen] = useState<Screen>('intake');
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [conversionFiles, setConversionFiles] = useState<File[]>([]);
  const [budget, setBudget] = useState(8);
  const [replanEffort, setReplanEffort] = useState<ReplanEffort>('same');
  const [terminalDetail, setTerminalDetail] = useState<TerminalDetail>('detailed');
  const [resultSelection, setResultSelection] = useState<ResultSelection>('best');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<string[]>(['[standby] Waiting for the eight official PS1 CSV files.']);
  const [validation, setValidation] = useState<SchemaGate | null>(null);
  const [results, setResults] = useState<Partial<Record<PolicyId, SolveResult>>>({});
  const [policyErrors, setPolicyErrors] = useState<Partial<Record<PolicyId, string>>>({});
  const [inputTexts, setInputTexts] = useState<Record<string, string>>({});
  const [conversionConsent, setConversionConsent] = useState(false);
  const [conversionBusy, setConversionBusy] = useState(false);
  const [conversionError, setConversionError] = useState('');
  const [conversionDraft, setConversionDraft] = useState<ConversionDraft | null>(null);
  const [draftGate, setDraftGate] = useState<SchemaGate | null>(null);
  const [selectedDraftTable, setSelectedDraftTable] = useState<string>(EXPECTED[0]);
  const [draftReviewed, setDraftReviewed] = useState(false);
  const [recoveryContext, setRecoveryContext] = useState<RecoveryContext | null>(null);
  const [needsAiRepair, setNeedsAiRepair] = useState(false);

  useEffect(() => {
    if (screen === 'welcome') return;
    const t = window.setTimeout(() => {
      document.querySelector<HTMLElement>('[data-heading]')?.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [screen]);

  const pick = (incoming: File[]) => {
    const classified = classifyDroppedFiles(incoming);
    setFiles((current) => {
      const next = new Map(current);
      for (const file of classified.canonical) next.set(file.name, file);
      return next;
    });
    if (classified.conversion.length > 0) {
      setConversionFiles((current) => Array.from(new Map([...current, ...classified.conversion].map((file) => [file.name, file])).values()));
      setConversionConsent(false);
      setConversionDraft(null);
      setDraftGate(null);
      setDraftReviewed(false);
      setConversionError('');
    }
    setError('');
  };

  const remove = (name: string) => {
    setFiles((current) => {
      const next = new Map(current);
      next.delete(name);
      return next;
    });
  };

  const clearAllFiles = () => {
    setFiles(new Map());
    resetConversionState(true);
    setNeedsAiRepair(false);
    setError('');
    setResults({});
    setPolicyErrors({});
    setValidation(null);
    setInputTexts({});
  };

  const appendLog = (message: string) => setLogs((current) => [...current, message]);

  const resetConversionState = (removeSources: boolean) => {
    if (removeSources) setConversionFiles([]);
    setConversionConsent(false);
    setConversionBusy(false);
    setConversionError('');
    setConversionDraft(null);
    setDraftGate(null);
    setDraftReviewed(false);
    setSelectedDraftTable(EXPECTED[0]);
  };

  const createConversionDraft = async () => {
    if (!conversionConsent || files.size !== EXPECTED.length) return;
    setConversionBusy(true);
    setConversionError('');
    setConversionDraft(null);
    setDraftGate(null);
    setDraftReviewed(false);
    try {
      const body = new FormData();
      const sources = Array.from(new Map([...files.values(), ...conversionFiles].map((file) => [file.name, file])).values());
      for (const file of sources) body.append('files', file);
      body.append('provider', 'gemini-vertex');
      body.append('consent', 'true');
      const response = await fetch('/api/ai/convert', {
        method: 'POST',
        body,
      });
      const payload = await response.json();
      if (!response.ok || !payload.tables) throw new Error(apiPayloadError(payload, 'AI conversion failed'));
      const draft = payload as ConversionDraft;
      setConversionDraft(draft);
      setDraftGate(draft.schema_gate);
      setSelectedDraftTable(EXPECTED.find((name) => name in draft.tables) ?? EXPECTED[0]);
    } catch (cause) {
      setConversionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConversionBusy(false);
    }
  };

  const updateDraftTable = (name: string, value: string) => {
    if (!conversionDraft) return;
    setConversionDraft({ ...conversionDraft, tables: { ...conversionDraft.tables, [name]: value } });
    setDraftGate(null);
    setDraftReviewed(false);
  };

  const validateDraft = async () => {
    if (!conversionDraft) return;
    setConversionBusy(true);
    setConversionError('');
    try {
      const response = await fetch('/api/validate', { method: 'POST', body: requestDraft(conversionDraft.tables) });
      const payload = await response.json();
      setDraftGate(payload as SchemaGate);
      setDraftReviewed(false);
      if (!response.ok) setConversionError(apiPayloadError(payload, 'Draft validation failed'));
    } catch (cause) {
      setConversionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConversionBusy(false);
    }
  };

  const acceptDraft = () => {
    if (!conversionDraft || !draftGate?.passed || !draftReviewed) return;
    const accepted = new Map<string, File>();
    for (const name of EXPECTED) {
      accepted.set(name, new File([conversionDraft.tables[name] ?? ''], name, { type: 'text/csv' }));
    }
    setFiles(accepted);
    resetConversionState(true);
    setNeedsAiRepair(false);
    setError('');
    setResults({});
    setPolicyErrors({});
    setValidation(null);
  };

  const processDataset = async () => {
    setBusy(true);
    setError('');
    setValidation(null);
    setResults({});
    setPolicyErrors({});
    setRecoveryContext(null);
    setLogs(['BOOT    Deterministic Project TAO pipeline started.']);
    setScreen('processing');
    try {
      const texts: Record<string, string> = {};
      for (const [name, file] of files) texts[name] = await file.text();
      setInputTexts(texts);
      const outcome = await runPipeline({
        files,
        budget,
        onEvent: (event: PipelineEvent) => {
          appendLog(`${event.kind.toUpperCase().padEnd(11)}${event.message}`);
          if (event.kind === 'validation' && event.validation) setValidation(event.validation as SchemaGate);
          if (event.kind === 'solve-done' && event.policy && event.result) {
            setResults((current) => ({ ...current, [event.policy!]: event.result as SolveResult }));
          }
          if (event.kind === 'solve-error' && event.policy) {
            setPolicyErrors((current) => ({ ...current, [event.policy!]: event.message }));
          }
        },
      });
      setValidation(outcome.validation as SchemaGate);
      setNeedsAiRepair(false);
      setResults(outcome.results as Partial<Record<PolicyId, SolveResult>>);
      setPolicyErrors(outcome.errors as Partial<Record<PolicyId, string>>);
      if (Object.keys(outcome.results).length === 0) {
        const issues = Object.entries(outcome.errors).map(([policy, detail]) => ({ scope: `Policy ${policy}`, detail }));
        setRecoveryContext({
          stage: 'optimisation',
          title: 'No official policy produced a releasable schedule.',
          summary: 'All policy attempts stopped without a validator-approved result. The uploaded and schema-checked dataset is preserved for retry or correction.',
          evidence: { evidence_id: outcome.validation.evidence_id, status: 'no_policy_result', errors: issues.map((item) => ({ code: item.scope, detail: item.detail })) },
          issues,
        });
        setScreen('recovery');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure = cause as Error & { stage?: string; evidence?: SchemaGate };
      const evidence = failure.evidence ?? { passed: false, errors: [{ code: 'connection_or_pipeline_error', detail: message }] };
      const issues = (evidence.errors ?? []).map((item, index) => ({
        scope: item.file ?? item.code ?? `Issue ${index + 1}`,
        detail: item.detail,
      }));
      setError(message);
      appendLog(`STOP       ${message}`);
      setRecoveryContext({
        stage: failure.stage === 'validation' ? 'validation' : 'connection',
        title: failure.stage === 'validation' ? 'The dataset did not pass deterministic validation.' : 'The pipeline was interrupted safely.',
        summary: message,
        evidence: { evidence_id: evidence.evidence_id, status: failure.stage === 'validation' ? 'rejected_input' : 'interrupted', errors: evidence.errors },
        issues: issues.length ? issues : [{ scope: 'Pipeline', detail: message }],
      });
      setScreen('recovery');
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setScreen('intake');
    setResults({});
    setPolicyErrors({});
    setValidation(null);
    setRecoveryContext(null);
    setError('');
  };

  const openSettings = () => {
    setSettingsReturnScreen(screen === 'settings' || screen === 'welcome' ? 'intake' : screen);
    setScreen('settings');
  };
  const replanBudget = replanEffort === 'extended' ? Math.min(60, budget * 2) : budget;

  return (
    <div className={styles.page}>
      {screen === 'welcome' ? <WelcomeOverlay onDone={() => setScreen('intake')} reduced={reduced} /> : null}

      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <span className={styles.wordmark}>Project TAO</span>
          <span className={styles.tagline}>Track Access Optimiser</span>
          <div className={styles.topbarActions}>
            {validation?.passed ? <span className={styles.demoPill}>Validator passed</span> : null}
            <button type="button" className={styles.settingsButton} aria-label="Open settings" aria-pressed={screen === 'settings'} disabled={busy || screen === 'welcome'} onClick={openSettings}>
              <span aria-hidden="true">⚙</span> Settings
            </button>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        {screen === 'intake' ? (
          <IntakeScreen
            files={files}
            conversionFiles={conversionFiles}
            onPick={pick}
            onRemove={remove}
            onNext={() => void processDataset()}
            budget={budget}
            error={error}
            busy={busy}
            conversionConsent={conversionConsent}
            onConversionConsent={setConversionConsent}
            conversionBusy={conversionBusy}
            conversionError={conversionError}
            conversionDraft={conversionDraft}
            draftGate={draftGate}
            selectedDraftTable={selectedDraftTable}
            onSelectedDraftTable={setSelectedDraftTable}
            draftReviewed={draftReviewed}
            onDraftReviewed={setDraftReviewed}
            onCreateDraft={() => void createConversionDraft()}
            onUpdateDraftTable={updateDraftTable}
            onValidateDraft={() => void validateDraft()}
            onAcceptDraft={acceptDraft}
            onClearConversion={() => resetConversionState(true)}
            needsAiRepair={needsAiRepair}
            onClearAll={clearAllFiles}
            onAssign={(source, target) => {
              try {
                const assigned = assignFileToCanonicalSlot(files, conversionFiles, source, target);
                setFiles(assigned.files);
                setConversionFiles(assigned.unmatched);
                setError('');
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              }
            }}
          />
        ) : null}
        {screen === 'processing' ? <ProcessingScreen onResults={() => setScreen('results')} busy={busy} logs={logs} results={results} errors={policyErrors} validation={validation} fatalError={error} terminalDetail={terminalDetail} /> : null}
        {screen === 'results' ? <LiveResultsScreen results={results} errors={policyErrors} inputs={inputTexts} files={files} budget={budget} replanBudget={replanBudget} resultSelection={resultSelection} onRestart={restart} /> : null}
        {screen === 'recovery' && recoveryContext ? <LiveRecoveryScreen context={recoveryContext} onRetry={() => void processDataset()} onBack={restart} onAiRepair={() => { setNeedsAiRepair(true); setScreen('intake'); window.setTimeout(() => document.getElementById('ai-file-repair')?.scrollIntoView({ block: 'start' }), 50); }} /> : null}
        {screen === 'settings' ? <SettingsScreen budget={budget} onBudget={setBudget} replanEffort={replanEffort} onReplanEffort={setReplanEffort} terminalDetail={terminalDetail} onTerminalDetail={setTerminalDetail} resultSelection={resultSelection} onResultSelection={setResultSelection} onDone={() => setScreen(settingsReturnScreen)} /> : null}
      </main>
    </div>
  );
}
