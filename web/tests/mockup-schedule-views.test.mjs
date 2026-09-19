import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mockup = fs.readFileSync(new URL('../app/mockup/page.tsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../app/mockup/mockup.module.css', import.meta.url), 'utf8');

test('the intake drop target stretches to the file-status panel on wide screens', () => {
  assert.match(css, /\.intakeGrid/);
  assert.match(css, /align-items:\s*stretch/);
  assert.match(css, /\.intakeDropCell \.drop/);
  assert.match(mockup, /intakeGrid/);
  assert.match(mockup, /intakeStatusCell/);
});

test('one-shot dataset removal clears files, drafts, results and validation', () => {
  assert.match(mockup, /Remove all datasets/);
  assert.match(mockup, /Clear all files/);
  assert.match(mockup, /onClearAll/);
  assert.match(mockup, /clearAllFiles/);
  assert.match(mockup, /resetConversionState\(true\)/);
  assert.match(mockup, /setNeedsAiRepair\(false\)/);
});

test('the schedule always shows day and week presentations in an adaptive widget grid', () => {
  assert.match(mockup, /By day/);
  assert.match(mockup, /By week/);
  assert.doesNotMatch(mockup, /scheduleViews/);
  assert.doesNotMatch(mockup, /toggleScheduleView/);
  assert.match(mockup, /ScheduleDayGrid/);
  assert.match(mockup, /focusedWeek/);
  assert.match(mockup, /Previous week/);
  assert.match(mockup, /Next week/);
  assert.match(mockup, /To plan/);
  assert.match(css, /\.dayNav/);
  assert.match(css, /position:\s*sticky/);
  assert.match(mockup, /ScheduleWeekGrid/);
  assert.match(mockup, /scheduleGrid/);
  assert.match(css, /\.scheduleGrid/);
  assert.match(css, /auto-fit/);
});

test('weeks stay whole-week highlights without invented calendar dates', () => {
  assert.match(mockup, /schedule itself never fixes a calendar day/i);
  assert.match(mockup, /formatDayDate/);
  assert.match(mockup, /WEEKDAY_SHORT/);
});

test('a workday bubble records preferred days as planning notes only', () => {
  assert.match(mockup, /DayNoteBubble/);
  assert.match(mockup, /Preferred workday/);
  assert.match(mockup, /onOpenDayBubble/);
  assert.match(mockup, /dayNotes/);
  assert.match(mockup, /A planning note only/);
  assert.match(mockup, /Close day picker/);
});

test('day notes export as a sidecar file outside the canonical eight and validated exports', () => {
  assert.match(mockup, /TAO_DAY_NOTES_/);
  assert.match(mockup, /exportDayNotes/);
  assert.match(mockup, /Export day notes \(CSV\)/);
  assert.match(mockup, /activity_id,week,week_commencing,preferred_day,preferred_date/);
  assert.match(mockup, /kept out of the eight source files and the validated exports/);
});

test('ECLO nights render as a dot plus a half-dot for their 1.5x yield', () => {
  assert.match(mockup, /AccessMark/);
  assert.match(mockup, /ecloPair/);
  assert.match(mockup, /liveHalfDot/);
  assert.match(mockup, /1\.5× work yield/);
  assert.match(mockup, /a dot plus a half-dot is one ECLO night/);
  assert.match(css, /\.liveHalfDot/);
  assert.match(css, /\.ecloPair/);
});

test('an infeasible policy explains itself instead of showing empty grids', () => {
  assert.match(mockup, /No feasible schedule/);
  assert.match(mockup, /could not place every access within the rules/);
  assert.match(mockup, /Why this policy has no schedule/);
  assert.match(mockup, /Loosen the binding constraint/);
});

test('the day grid fits all seven days in its available width', () => {
  assert.match(mockup, /minmax\(40px, 72px\)/);
  assert.match(mockup, /dayView/);
  assert.match(css, /\.dayView/);
});

test('side-by-side schedule views stretch to equal height', () => {
  assert.match(css, /\.scheduleGrid/);
  assert.match(css, /\.scheduleViewBody \.liveGantt/);
});

test('unplanned nights can be auto-suggested from job-type rules without touching user picks', () => {
  assert.match(mockup, /suggestWorkdays/);
  assert.match(mockup, /recommendWorkdays/);
  assert.match(mockup, /Suggest workdays/);
  assert.match(mockup, /Your picks are never overwritten/);
  assert.match(mockup, /agendaNoteSuggested/);
  assert.match(mockup, /noteSource/);
  assert.match(mockup, /source,basis/);
});

test('suggestions come from the cloud Python engine with a local fallback', () => {
  assert.match(mockup, /\/api\/plan-days/);
  assert.match(mockup, /suggestWorkdaysLocal/);
  assert.match(mockup, /dayEngine/);
  assert.match(mockup, /Planned by the Python engine on the Cloud API/);
  assert.match(mockup, /Planned locally/);
});

test('each access renders as one day: only weeks with accesses are highlighted', () => {
  assert.match(mockup, /const hasWork = accesses\.length > 0/);
  assert.match(mockup, /Each dot is one day of work/);
});

test('day rows state whether each job can share track or needs sole use', () => {
  assert.match(mockup, /overlapInfo/);
  assert.match(mockup, /overlapBadge/);
  assert.match(mockup, /Sole use/);
  assert.match(mockup, /Shareable/);
  assert.match(mockup, /contracts={contractMap}/);
  assert.match(css, /\.overlapBadge/);
  assert.match(css, /\.overlapSole/);
  assert.match(css, /\.overlapShare/);
});

test('selecting a week highlights its work across every widget', () => {
  assert.match(mockup, /selectedWeek/);
  assert.match(mockup, /toggleWeek/);
  assert.match(mockup, /liveGanttRowMatch/);
  assert.match(mockup, /liveWeekCellSel/);
  assert.match(mockup, /scheduleFocus/);
  assert.match(mockup, /Clear selection/);
  assert.match(css, /\.liveGanttRowMatch/);
  assert.match(css, /\.scheduleFocus/);
});

test('the day view shows per-week planning progress in nights', () => {
  assert.match(mockup, /nights planned/);
  assert.match(mockup, /dayProgress/);
  assert.match(mockup, /plannedNights/);
  assert.match(mockup, /totalNights/);
  assert.match(mockup, /to plan/);
  assert.match(css, /\.dayProgress/);
});

test('day cells plan with one click while the bubble stays for detail', () => {
  assert.match(mockup, /onPlanDay/);
  assert.match(mockup, /planDay/);
  assert.match(mockup, /data-plan-day/);
  assert.match(mockup, /Plan \$/);
  assert.match(mockup, /Unplan \$/);
  assert.match(mockup, /Open day picker for/);
  assert.match(mockup, /dayDetailsBtn/);
  assert.match(mockup, /data-to-plan/);
  assert.match(mockup, /dayCellPlanned/);
  assert.match(css, /\.dayCellPlanned/);
  assert.match(css, /\.dayDetailsBtn/);
  // fast path coexists with the detail bubble, it does not replace it
  assert.match(mockup, /DayNoteBubble/);
  assert.match(mockup, /onOpenDayBubble/);
});

test('unplanned nights stay in To plan and only user-picked days appear on weekdays', () => {
  assert.match(mockup, /To plan/);
  assert.match(mockup, /Nights not yet day-planned/);
  assert.match(mockup, /schedule itself never fixes a calendar day/i);
  assert.match(mockup, /A planning note only/);
  assert.match(mockup, /kept out of the eight source files and the validated exports/);
});
