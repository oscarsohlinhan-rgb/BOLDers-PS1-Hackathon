import assert from 'node:assert/strict';
import test from 'node:test';
import { explainEvidence, runPipeline, runReplan } from '../app/mockup/live-pipeline.mjs';

const expected = [
  '01_LINES.csv', '02_STATIONS.csv', '03_SECTORS.csv', '04_LOCATION_SUPPLY.csv',
  '05_BUFFER_LOCATION.csv', '06_PARAMETERS.csv', '07_PROJECT_DETAILS.csv', '08_ACTIVITY_DETAILS.csv',
];

function fileMap() {
  return new Map(expected.map((name) => [name, new File([`${name}\nvalue\n`], name, { type: 'text/csv' })]));
}

function jsonResponse(payload, ok = true) {
  return { ok, async json() { return payload; } };
}

test('runPipeline validates once then solves all three official policies', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const scenario = options.body.get('scenario');
    calls.push([url, scenario]);
    if (url === '/api/validate') return jsonResponse({ passed: true, evidence_id: 'SCHEMA-1', errors: [] });
    return jsonResponse({ status: 'ok', report: { scenario, feasible: true, hard_violations: [], soft_scores: { objective_score: scenario.charCodeAt(0) }, detail: { nights_scheduled: 1, eclo_nights: 0, capacity_hotspots: [] } }, files: { 'SCHEDULE_ACCESS.csv': 'x', 'SCHEDULE_OCCUPANCY.csv': 'y', 'RESULTS.csv': 'z' } });
  };

  const result = await runPipeline({ files: fileMap(), budget: 3, fetchImpl });

  assert.deepEqual(calls, [['/api/validate', null], ['/api/solve', 'A'], ['/api/solve', 'B'], ['/api/solve', 'C']]);
  assert.deepEqual(Object.keys(result.results), ['A', 'B', 'C']);
  assert.deepEqual(result.errors, {});
  assert.equal(result.validation.evidence_id, 'SCHEMA-1');
});

test('runPipeline stops before solving when deterministic validation fails', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ passed: false, errors: [{ detail: 'broken relationship' }] }, false);
  };

  await assert.rejects(
    () => runPipeline({ files: fileMap(), budget: 3, fetchImpl }),
    /broken relationship/,
  );
  assert.equal(calls, 1);
});

test('runPipeline preserves valid policies when one policy fails', async () => {
  const fetchImpl = async (url, options) => {
    if (url === '/api/validate') return jsonResponse({ passed: true, evidence_id: 'SCHEMA-2', errors: [] });
    const scenario = options.body.get('scenario');
    if (scenario === 'B') return jsonResponse({ error: { detail: 'no feasible Policy B plan' } }, false);
    return jsonResponse({ status: 'ok', report: { scenario, feasible: true, hard_violations: [], soft_scores: { objective_score: 10 }, detail: { nights_scheduled: 1, eclo_nights: 0, capacity_hotspots: [] } }, files: {} });
  };

  const result = await runPipeline({ files: fileMap(), budget: 3, fetchImpl });
  assert.deepEqual(Object.keys(result.results), ['A', 'C']);
  assert.equal(result.errors.B, 'no feasible Policy B plan');
});

test('runReplan sends the preserved dataset and narrow disruption to the validator-gated endpoint', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, scenario: options.body.get('scenario'), budget: options.body.get('time_budget'), disruption: options.body.get('disruption') };
    return jsonResponse({
      schema_gate: { passed: true, evidence_id: 'SCHEMA-R', errors: [] },
      replan: {
        status: 'feasible', explanation: 'Validated replan.', changes: [],
        validator_gate: { passed: true, hard_violations: [], soft_warnings: [] },
      },
      files: { 'SCHEDULE_ACCESS.csv': 'a', 'SCHEDULE_OCCUPANCY.csv': 'o', 'RESULTS.csv': 'r' },
    });
  };

  const result = await runReplan({ files: fileMap(), policy: 'C', budget: 7, disruption: 'delay A001 by 2 weeks', fetchImpl });

  assert.deepEqual(captured, { url: '/api/replan', scenario: 'C', budget: '7', disruption: 'delay A001 by 2 weeks' });
  assert.equal(result.replan.validator_gate.passed, true);
  assert.equal(result.files['RESULTS.csv'], 'r');
});

test('runReplan surfaces an actionable parser error without losing the current programme', async () => {
  const fetchImpl = async () => jsonResponse({ error: "unsupported disruption; use 'block A001 in week 12'" }, false);
  await assert.rejects(
    () => runReplan({ files: fileMap(), policy: 'A', budget: 3, disruption: 'move everything', fetchImpl }),
    /unsupported disruption/,
  );
});

test('explainEvidence sends only allowlisted evidence and explicit Gemini consent', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body), headers: options.headers };
    return jsonResponse({ provider: 'disabled', evidence_id: 'SCHEMA-3', explanation: 'Only the deterministic validator decides feasibility.' });
  };

  const response = await explainEvidence({
    evidence: { evidence_id: 'SCHEMA-3', status: 'rejected_input', errors: [{ code: 'missing_required_file', detail: 'missing table' }], ignored: 'do not send' },
    fetchImpl,
  });

  assert.equal(captured.url, '/api/ai/explain');
  assert.deepEqual(captured.body, { evidence_id: 'SCHEMA-3', status: 'rejected_input', errors: [{ code: 'missing_required_file', detail: 'missing table' }], consent: false });
  assert.deepEqual(captured.headers, { 'Content-Type': 'application/json' });
  assert.equal(response.provider, 'disabled');
});

test('explainEvidence can explicitly opt structured evidence into Vertex Gemini', async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse({ provider: 'gemini-vertex', explanation: 'Check the missing field.' });
  };
  await explainEvidence({ evidence: { status: 'rejected_input', secret: 'excluded' }, consent: true, fetchImpl });
  assert.deepEqual(body, { status: 'rejected_input', consent: true });
});
