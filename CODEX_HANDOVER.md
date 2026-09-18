# Handover to Codex — PS1 Track Access Optimiser

## What this is
NEBULA X 2026 hackathon, Track 1 / PS1 railway track-access optimisation.
Deadline 19 Sep 16:00 SGT. Repo: `aochinwen/NebulaX-Hackathon-ProblemStatement`
@ `966c976`. This folder (`ps1-app/`) is our solver + validator + web app.

## State: math core + P6 deterministic replan DONE and verified, no generative AI
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
- `api/main.py` — FastAPI: `GET /health`, `POST /solve`
  (8 files + scenario + time_budget), `POST /replan` (same files + one narrow
  disruption command). Run from repo root: `python3 -m uvicorn api.main:app`.
- `api/replanner.py` — accepts only `block A001 in week 12` or
  `delay A001 by 2 weeks`; keeps unaffected activities locked, cascades through
  successors, templates the before/after explanation, and releases CSVs only
  after the independent validator returns zero hard violations.
- `web/` — Next.js 14 UI (upload 8, A/B/C tabs, solve, badge/scores,
  violations, CSV downloads, sample-dataset loader). `/api/*` rewrites to
  backend via `API_INTERNAL_URL`. tsc + `next build` clean.
- `api/tests/run_checks.py` — `python3 -m api.tests.run_checks`: ALL PASS.

## Verified numbers (public pack)
- Sample regression: 192/928/14 rows, 0 violations, overruns 14/7/7. ✓
- Our solve A: 0 violations, score 32.2, overrun 28d. B: 0 viol, zero overrun
  (excess 6 + ECLO 6 = 72). C: 0 viol, 32.2, no excess spent. ✓
- Mutations caught: dropped access (workload), A013-before-A012 (precedence),
  ECLO-in-A. ✓  Full stack (page 200 → rewrite → feasible) tested locally. ✓

## Evidence rules and hidden-validator risk
- Mix limits apply PER POSSESSION (location, week, co-share group), not per
  location-week. Capacity counts distinct groups vs LOCATION_SUPPLY
  (A: zero tolerance, C: +1 soft, B: soft only).
- **HIGH RISK:** literal buffer expansion finds 12 cross-possession overlaps in
  the published zero-violation sample, so the app treats them as warnings and
  hard-blocks Live mirrors only. However, §2.4 explicitly calls buffers rigid
  and says they never overlap. Do not call this settled until the reference
  validator or organiser confirms the intended expansion/semantics.
- `access_night` is local per contract+type+week. One access per activity
  per week. Predecessor = strictly later week. RESULTS overrun = max activity
  overrun per contract. Activity nudge applies per overrunning activity.

## Left to do
1. Deploy: Railway, one project two services (`api/railway.toml`,
   `web/railway.toml` in repo). api private, web public, `API_INTERNAL_URL`
   to `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`; do not hard-code
   port 8000. Set each service's Railway config-file/root path explicitly and
   warm before demo.
2. Winning demo: use the 18 Sep SMRT operator consultation as the narrative.
   Show a validated base plan, then inject a morning condition alert/urgent
   defect that removes an access opportunity, preserve locked/unaffected work,
   show exact moves and trade-offs, revalidate, and require human approval.
   Do not build the handwritten category queue literally; the challenged,
   operator-grounded design is in `docs/PRIORITY_AND_REPLAN_PIPELINE.md`.
3. Submission: private collaboration remote is
   `https://github.com/oscarsohlinhan-rgb/BOLDers-PS1-Hackathon`; prepare the
   final public/submission URL, hosted URL, 2–3-min video, write-up, and ZIP of
   9 CSVs (3 scenarios × 3 files). Pack says GitHub, PS1 README says GitLab —
   bring both URLs if the organisers do not clarify the conflict.
4. Open organiser questions: official validator + `trackaccess` helper absent;
   buffer semantics pending confirmation (ours documented in README).

## Gotchas
- Python 3.9 (stdlib-only core + fastapi/uvicorn). Local Next 14.2.35 in
  `web/node_modules` — run via `./node_modules/.bin/next` from `web/`, NEVER
  bare `npx next` (fetches Next 16 and breaks the build).
- `uvicorn` not on PATH: use `python3 -m uvicorn`.
- No secrets in repo/brain. Short replies.
