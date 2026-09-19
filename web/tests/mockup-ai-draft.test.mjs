import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mockup = fs.readFileSync(new URL('../app/mockup/page.tsx', import.meta.url), 'utf8');

test('the AI-corrected dataset is downloadable as an explicitly untrusted review bundle', () => {
  assert.match(mockup, /Download AI-corrected draft \(\.zip\)/);
  assert.match(mockup, /correction_manifest\.csv/);
  assert.match(mockup, /Downloading is review-only/);
  assert.match(mockup, /does not confirm the draft, rerun validation, or start optimisation/);
});

test('the correction manifest keeps originals and proposals visible', () => {
  assert.match(mockup, /original_value/);
  assert.match(mockup, /ai_proposed_value/);
  assert.match(mockup, /stations FINAL\(2\)\.csv/);
  assert.match(mockup, /duration_nights_all_in/);
});
