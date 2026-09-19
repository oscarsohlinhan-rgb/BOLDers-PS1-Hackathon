# Handover to Codex — PS1 Track Access Optimiser

## What this is
NEBULA X 2026 hackathon, Track 1 / PS1 railway track-access optimisation.
Deadline 19 Sep 16:00 SGT. Repo: `aochinwen/NebulaX-Hackathon-ProblemStatement`
@ `966c976`. This folder (`ps1-app/`) is our solver + validator + web app.

## State: math core + deterministic pipeline/replan DONE and verified
- Google Cloud deployment is live: judge URL
  `https://ps1-web-243124675970.asia-southeast1.run.app`, API URL
  `https://ps1-api-243124675970.asia-southeast1.run.app`. Public health,
  multipart validate, Scenario A solve, 8/8 sample loading, and the rendered
  feasible result/download UI were smoke-tested successfully on 19 Sep 2026.
  Current revisions are API `ps1-api-00004-fcb` and web `ps1-web-00007-46v`,
  each at 100 percent traffic. The live release includes `POST /plan-days` and
  the day/week planning UI.
- `api/model.py` — parses 8 CSVs, week math, expansion (tunnel+platform walk),
  buffers, Live mirrors, predecessor DAG. Single shared primitive so solver,
  validator, exporter can never disagree on expansion.
- `api/solver.py` — greedy ordered by constraint tightness (predecessor depth,
  deadline slack, buffer footprint, hotspot scarcity, workload, tier weight) +
  bounded deterministic repair/improvement, lexicographic
  (hard violations, buffer warnings, score). Fixed seed. Never gives up on
  congestion: forces placement and reports honestly.
- `api/validator.py` — independent (plain dicts in, no solver state).
  `validate()` = hard violations, `warnings()` = soft buffer notes.
- `api/exporter.py` — exact 3-CSV outputs, RESULTS dates
  (last day of last access week — verified vs sample), §2.5 scores.
- `api/main.py` — FastAPI: `GET /health`, `POST /validate`, `POST /solve`
  (8 files + scenario + time_budget), `POST /replan` (same files + one narrow
  disruption command), `POST /plan-days` (the eight inputs plus generated
  access/occupancy schedules), and `POST /ai/explain` (structured evidence only).
  Run from repo root: `python3 -m uvicorn api.main:app`.
- `api/pipeline.py` — deterministic schema and relationship checks, stable
  evidence IDs, solve orchestration, independent-validator release gate, and
  no CSV output when the candidate is invalid.
- `api/ai_explainer.py` — optional DeepSeek explanation over already-checked
  evidence. AI has no scheduling, feasibility, approval, state-change, or CSV
  release authority. Missing key or provider failure uses deterministic text.
- `api/replanner.py` — accepts only `block A001 in week 12` or
  `delay A001 by 2 weeks`; keeps unaffected activities locked, cascades through
  successors, templates the before/after explanation, and releases CSVs only
  after the independent validator returns zero hard violations.
- `web/` — Next.js 14 UI (upload 8, A/B/C tabs, solve, badge/scores,
  violations, CSV downloads, sample-dataset loader). `/api/*` rewrites to
  backend via `API_INTERNAL_URL`. tsc + `next build` clean.
- `api/tests/run_checks.py` — `python3 -m api.tests.run_checks`: ALL PASS,
  including malformed input, missing schema/parameters, broken foreign keys,
  predecessor cycle, feasible and infeasible workload boundaries, workfront,
  allocation, capacity, possession-mix, predecessor, planned-date, ECLO,
  Live-mirror, buffer-warning, malformed schedule, and AI-boundary mutations.

## Verified numbers (public pack)
- Sample regression: 192/928/14 rows and overruns 14/7/7 reproduced; the stricter
  validator now reports its 50 cross-contract closure conflicts instead of
  treating the sample as feasibility ground truth. ✓
- Our 10-second solves: A 0 violations, score 1712.2, overrun 42d; B 0
  violations, score 30, zero overrun; C 0 violations, score 1712.2, overrun
  42d. ✓
- Mutations caught: dropped access (workload), A013-before-A012 (precedence),
  ECLO-in-A. ✓  Full stack (page 200 → rewrite → feasible) tested locally. ✓

## Evidence rules and hidden-validator risk
- Job duration is all-in: it already includes setup, preparation, execution,
  close-out and paperwork. Compare it directly to any explicitly supplied slot
  duration; equality is feasible and no generic padding may be added or
  deducted. The current eight-file public schema contains no minute-duration
  fields, so this is a guarded boundary for later canonical intake. AI cannot
  reinterpret or override it. The cross-possession buffer question is separate
  and does not reduce the available time of an individual job slot.
- Mix limits apply PER POSSESSION (location, week, co-share group), not per
  location-week. Capacity counts distinct groups vs LOCATION_SUPPLY
  (A: zero tolerance, C: +1 soft, B: soft only).
- Different contracts have no comparable local access-night axis. A same-week
  actual-footprint overlap across contracts is therefore a hard closure unless
  the exact location/week/co-share tuple is exempt. The external-validator
  evidence takes precedence over the sample's claimed feasibility; the sample
  contains 50 such conflicts. Pure buffer-vs-buffer and buffer-only ambiguity
  remain warnings pending organiser confirmation of §2.4 semantics.
- `access_night` is local per contract+type+week. One access per activity
  per week. Predecessor = strictly later week. RESULTS overrun = max activity
  overrun per contract. Activity nudge applies per overrunning activity.

## Left to do
1. Winning demo: use the 18 Sep SMRT operator consultation as the narrative.
   Show a validated base plan, then inject a morning condition alert/urgent
   defect that removes an access opportunity, preserve locked/unaffected work,
   show exact moves and trade-offs, revalidate, and require human approval.
   Do not build the handwritten category queue literally; the challenged,
   operator-grounded design is in `docs/PRIORITY_AND_REPLAN_PIPELINE.md`.
2. Submission: private collaboration remote is
   `https://github.com/oscarsohlinhan-rgb/BOLDers-PS1-Hackathon`; prepare the
   final public/submission URL, hosted URL, 2–3-min video, write-up, and ZIP of
   9 CSVs (3 scenarios × 3 files). PS1 permits five uploads per scenario and
   the latest upload is final, so gate each upload as a release. Pack says
   GitHub, PS1 README says GitLab; bring both URLs if organisers do not clarify.
3. Open organiser questions: official validator + `trackaccess` helper absent;
   buffer semantics pending confirmation (ours documented in README).
4. Product work still pending: mixed-file AI intake adapter, interrupted-work
   persistence, user-confirmation workflow, and Settings UI for an ephemeral AI
   key.

## Gotchas
- Python 3.9 (stdlib-only core + fastapi/uvicorn). Local Next 14.2.35 in
  `web/node_modules` — run via `./node_modules/.bin/next` from `web/`, NEVER
  bare `npx next` (fetches Next 16 and breaks the build).
- `uvicorn` not on PATH: use `python3 -m uvicorn`.
- No secrets in repo/brain. Short replies.
- The HTTP API accepts a DeepSeek key only through the ephemeral
  `X-DeepSeek-API-Key` header. Do not configure a shared server key on the
  public unauthenticated endpoint, and never commit the real key.
