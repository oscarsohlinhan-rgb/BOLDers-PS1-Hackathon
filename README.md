# PS1 Track Access Optimiser (BOLDers, NEBULA X 2026)

Schedules contracted railway track access over a 30-week horizon for all three
scenarios (A/B/C) and proves each schedule against an independent hard validator.

Private team collaboration repository:
`https://github.com/oscarsohlinhan-rgb/BOLDers-PS1-Hackathon`.

## Layout

- `api/` — Python FastAPI service. Importer (`model.py`), greedy+repair solver
  (`solver.py`), independent validator (`validator.py`), exact exporter + scoring
  (`exporter.py`). Stdlib only + fastapi/uvicorn.
- `web/` — Next.js 14 UI. Upload 8 CSVs, pick scenario, solve, inspect
  violations/scores, download the 3 output CSVs. Proxies `/api/*` to the backend.
- `api/replanner.py` — narrow deterministic disruption parser and minimal-churn
  repair. Unaffected activities remain locked; only the independent validator
  can release replanned CSVs. The explainer is templated and never establishes
  feasibility.
- `api/pipeline.py` — deterministic eight-file schema gate, stable evidence
  IDs, solver orchestration, independent-validator release gate, and exact CSV
  release only for feasible candidates.
- `api/ai_explainer.py` — optional DeepSeek explanation of already-checked
  structured evidence. It has no scheduling, validation, approval, state-change,
  or export authority and degrades to deterministic text when AI is unavailable.
- `docs/PRIORITY_AND_REPLAN_PIPELINE.md` — operator-grounded redesign of the
  initial event-sorting sketch. It separates work type, lifecycle state,
  dynamic risk, deterministic feasibility, EWR judgment, and execution/replan.

## Local run

```
python3 -m pip install -r api/requirements.txt
python3 -m uvicorn api.main:app --port 8000  # from repo root
cd web && npm install && npm run dev      # opens on :3000, /api -> :8000
python3 -m api.tests.run_checks           # regression + mutation tests
```

The mutation suite includes feasible workload increases, exact-horizon and
one-over cases, competing work, workfront and weekly-allocation boundaries,
capacity and per-possession mix limits, predecessor timing, Scenario B dates,
Scenario C ECLO windows, Live mirrors, buffer warnings, and malformed schedule
fields. Every infeasible pipeline case must return no CSV files.

Optional AI configuration stays in the future Settings-page browser session.
Never commit a real key. `POST /ai/explain` accepts it only through an ephemeral
`X-DeepSeek-API-Key` header and does not persist or return it. The public API
does not read a server-wide DeepSeek key, which prevents unauthenticated users
from spending shared provider credit.

## Judging deployment

The official NebulaX Telegram channel stated on 18 September that submissions
must be available on Google Cloud to be considered for judging. Google Cloud is
therefore the primary deployment target. The existing Railway files are a
tested fallback only and are not sufficient as the judging deployment.

The same channel stated that PS1 permits five validator uploads per scenario
and the most recent upload, not the highest score, becomes final. Treat every
upload as a release: run the independent validator, archive the exact input and
output evidence IDs, and require explicit team approval first.

### Google Cloud Run

The repository includes separate, non-root containers for the FastAPI and
Next.js services. From an authenticated Google Cloud Shell or workstation:

```
./scripts/deploy_google_cloud.sh <project-id>
```

The script enables the required Google APIs, deploys `ps1-api`, discovers its
Cloud Run URL, then builds and deploys `ps1-web` with that URL as the internal
rewrite target. Both services use `asia-southeast1` by default, scale to zero,
and allow unauthenticated judging access. Override `GCP_REGION`, `API_SERVICE`,
or `WEB_SERVICE` only when the target project requires different names.

No provider key is deployed. The temporary `.env.production` generated during
the web build contains only the public API service URL and is deleted when the
script exits.

## Fallback deploy (Railway, one project, two services)

- Service `api`: Root Directory = `/`; Railway config-file path
  `/api/railway.toml`; private (no public domain). `.python-version` pins 3.9.
- Service `web`: Root Directory = `/web`; Railway config-file path
  `/web/railway.toml`; public URL = judge URL.
- Set web variable `API_INTERNAL_URL` with Railway reference variables, e.g.
  `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}` when the service is
  named `api`. Do not hard-code port 8000: the API binds Railway's `$PORT`.
- Warm both services before the demo. Core works with AI disabled (no AI in v1).

## Method + documented assumptions

- Greedy constructor ordered by constraint tightness (predecessor depth,
  deadline slack, buffer footprint, hotspot scarcity, workload, tier weight),
  then bounded deterministic repair + improvement (lexicographic: hard
  violations, buffer warnings, score). Fixed seed. Never crashes on congestion:
  unplaceable work is forced and honestly reported.
- Validator is independent (reads only plain schedule dicts + inputs).
- Evidence rule from the official sample (feasible, 0 violations): mix limits
  apply **per possession** (location, week, co-share group). Capacity counts distinct
  possession groups vs `LOCATION_SUPPLY` (A: zero tolerance, C: +1 soft,
  B: soft only). `access_night` is local per contract+type+week.
- **High-risk unresolved rule:** §2.4 prose says exclusion buffers never overlap
  and treats them as hard safety constraints, but applying that literal geometry
  makes the supplied zero-violation sample produce 12 overlaps. The current
  checker keeps those as warnings and hard-blocks Live mirrors only. Do not call
  this proven reference-validator behaviour; obtain the official validator or
  organiser ruling. Solver repair still minimizes warning count as a hedge.
- Open organiser questions: official validator + `trackaccess` helper absent;
  submission says GitHub here vs GitLab in PS1 README; buffer semantics pending
  official confirmation.

## Status

Scenario A/B/C all feasible on the public pack, 0 hard violations
(A 32.2 / B 72.0 / C 32.2). Sample regression 192/928/14 rows reproduced.
P6 stretch is implemented as a narrow deterministic command box (`block … in
week …` / `delay … by … weeks`), minimal-churn dependency repair, templated
before/after explanation and validator-gated export. There is no generative AI
in the feasibility or CSV path. The backend now includes a deterministic schema
gate and an optional DeepSeek evidence explainer; the mixed-format adapter,
roadblock persistence, Settings UI, and Google Cloud deployment remain pending.
