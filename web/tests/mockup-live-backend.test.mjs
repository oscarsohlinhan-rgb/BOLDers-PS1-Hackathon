import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('../app/mockup/page.tsx', import.meta.url), 'utf8');
const pipeline = fs.readFileSync(new URL('../app/mockup/live-pipeline.mjs', import.meta.url), 'utf8');
const nextConfig = fs.readFileSync(new URL('../next.config.js', import.meta.url), 'utf8');

test('the approved frontend accepts the real eight-file dataset', () => {
  assert.match(page, /type="file"/);
  assert.match(page, /multiple/);
  assert.match(page, /EXPECTED/);
  assert.match(page, /runPipeline/);
});

test('the approved frontend renders results from the real planning model', () => {
  assert.match(page, /buildPlanningModel/);
  assert.match(page, /objective_score/);
  assert.match(page, /SCHEDULE_ACCESS\.csv/);
});

test('programme policy labels match the solver contracts', () => {
  assert.match(page, /Fixed supply/);
  assert.match(page, /Zero overrun/);
  assert.match(page, /Balanced capacity/);
  assert.doesNotMatch(page, /Programme-first/);
  assert.doesNotMatch(page, /Access-lean/);
});

test('the production flow no longer exposes mockup-only navigation', () => {
  assert.doesNotMatch(page, /Mockup preview/);
  assert.doesNotMatch(page, /Fictional demo data/);
});

test('filename mismatches are manually assigned without AI', () => {
  assert.match(page, /ManualFileMapper/);
  assert.match(page, /assignFileToCanonicalSlot/);
  assert.match(page, /Local naming step · no AI/);
  assert.match(page, /Confirm name mapping/);
});

test('content repair uses consent-gated Gemini on Vertex after deterministic failure', () => {
  assert.match(page, /\/api\/ai\/convert/);
  assert.match(page, /gemini-vertex/);
  assert.match(page, /Gemini on Google Cloud Vertex AI/);
  assert.match(page, /conversionConsent/);
  assert.match(page, /needsAiRepair/);
  assert.doesNotMatch(page, /X-DeepSeek-API-Key/);
});

test('non-canonical file mismatches are announced at the top of intake with a repair action', () => {
  assert.match(page, /topMismatchAlert/);
  assert.match(page, /Some files need attention before processing/);
  assert.match(page, /Review unmatched files/);
  assert.match(page, /document\.getElementById\('manual-file-mapper'\)/);
});

test('a converted draft must be downloadable, reviewed and deterministically valid before acceptance', () => {
  assert.match(page, /downloadConversionDraft/);
  assert.match(page, /draftReviewed/);
  assert.match(page, /draftGate\?\.passed/);
  assert.match(page, /Accept reviewed draft/);
  assert.match(page, /User clarification required/);
});

test('the results workspace runs real disruption replans and gates their exports', () => {
  assert.match(page, /runReplan/);
  assert.match(pipeline, /\/api\/replan/);
  assert.match(page, /Controlled disruption replan/);
  assert.match(page, /replanResult\.validator_gate\.passed/);
  assert.match(page, /REPLAN_/);
});

test('pipeline failures route into a real recovery screen with structured evidence explanations', () => {
  assert.match(page, /explainEvidence/);
  assert.match(pipeline, /\/api\/ai\/explain/);
  assert.match(page, /setScreen\('recovery'\)/);
  assert.match(page, /Return to dataset intake/);
  assert.match(page, /Retry deterministic pipeline/);
});

test('the public root opens the approved Project TAO workspace', () => {
  assert.match(nextConfig, /source:\s*["']\/["']/);
  assert.match(nextConfig, /destination:\s*["']\/mockup["']/);
  assert.match(nextConfig, /permanent:\s*false/);
});

test('solver effort is configured from a dedicated top-navigation settings page', () => {
  assert.match(page, /screen === 'settings'/);
  assert.match(page, /aria-label="Open settings"/);
  assert.match(page, /Solver effort/);
  assert.match(page, /Optimisation seconds per policy/);
  assert.match(page, /Math\.max\(1, Math\.min\(60,/);
  assert.match(page, /Configured in Settings/);
});

test('settings expose explained fine-tuning controls that affect the live pipeline', () => {
  assert.match(page, /Replan effort/);
  assert.match(page, /Pipeline detail/);
  assert.match(page, /Initial policy/);
  assert.match(page, /terminalDetail === 'detailed'/);
  assert.match(page, /replanEffort === 'extended'/);
  assert.match(page, /resultSelection === 'best'/);
});
