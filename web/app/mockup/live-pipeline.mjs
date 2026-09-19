import { EXPECTED } from '../intake.mjs';

export const PIPELINE_POLICIES = ['A', 'B', 'C'];

export function apiError(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error === 'object' && typeof payload.error.detail === 'string') {
    return payload.error.detail;
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0 && typeof payload.errors[0]?.detail === 'string') {
    return payload.errors[0].detail;
  }
  return fallback;
}

export function requestBundle(files) {
  const missing = EXPECTED.filter((name) => !files.has(name));
  if (missing.length > 0) throw new Error(`Missing: ${missing.join(', ')}`);
  const body = new FormData();
  for (const name of EXPECTED) body.append('files', files.get(name));
  return body;
}

export async function runPipeline({ files, budget, fetchImpl = fetch, onEvent = () => {} }) {
  onEvent({ kind: 'stage', message: 'Reading eight canonical CSV files.' });
  const validationResponse = await fetchImpl('/api/validate', {
    method: 'POST',
    body: requestBundle(files),
  });
  const validation = await validationResponse.json();
  if (!validationResponse.ok || !validation.passed) {
    const failure = new Error(apiError(validation, 'Deterministic schema validation failed'));
    failure.stage = 'validation';
    failure.evidence = validation;
    throw failure;
  }
  onEvent({ kind: 'validation', message: `Deterministic validation passed · ${validation.evidence_id || 'evidence recorded'}.`, validation });

  const results = {};
  const errors = {};
  for (const policy of PIPELINE_POLICIES) {
    onEvent({ kind: 'solve-start', policy, message: `Policy ${policy} optimisation started.` });
    const body = requestBundle(files);
    body.append('scenario', policy);
    body.append('time_budget', String(budget));
    try {
      const response = await fetchImpl('/api/solve', { method: 'POST', body });
      const payload = await response.json();
      if (!response.ok || !payload.report) throw new Error(apiError(payload, `Policy ${policy} failed`));
      results[policy] = payload;
      onEvent({ kind: 'solve-done', policy, message: `Policy ${policy} settled.`, result: payload });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors[policy] = message;
      onEvent({ kind: 'solve-error', policy, message });
    }
  }
  onEvent({ kind: 'done', message: 'All official policies settled.' });
  return { validation, results, errors };
}

export async function runReplan({ files, policy, budget, disruption, fetchImpl = fetch }) {
  const body = requestBundle(files);
  body.append('scenario', policy);
  body.append('time_budget', String(budget));
  body.append('disruption', disruption);
  const response = await fetchImpl('/api/replan', { method: 'POST', body });
  const payload = await response.json();
  if (!response.ok || !payload.replan) throw new Error(apiError(payload, 'Disruption replan failed'));
  return payload;
}

export async function explainEvidence({ evidence, consent = false, fetchImpl = fetch }) {
  const allowed = ['evidence_id', 'errors', 'hard_violations', 'soft_warnings', 'status', 'scenario'];
  const checked = Object.fromEntries(allowed.filter((key) => key in evidence).map((key) => [key, evidence[key]]));
  const response = await fetchImpl('/api/ai/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...checked, consent }),
  });
  const payload = await response.json();
  if (!response.ok || typeof payload.explanation !== 'string') throw new Error(apiError(payload, 'Evidence explanation failed'));
  return payload;
}
