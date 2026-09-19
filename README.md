# Project TAO — Track Access Optimiser (BOLDers, NEBULA X 2026)

Schedules contracted railway track access over a 30-week horizon for all three
scenarios (A/B/C) and proves each schedule against an independent hard validator.

Private team collaboration repository:
`https://github.com/oscarsohlinhan-rgb/BOLDers-PS1-Hackathon`.

## Layout

- `api/` — Python FastAPI service. Importer (`model.py`), greedy+repair solver
  (`solver.py`), independent validator (`validator.py`), exact exporter + scoring
  (`exporter.py`). Stdlib only + fastapi/uvicorn.
- `web/` — Next.js 14 Project TAO UI. A short skippable welcome transition
  yields to a focused drag-and-drop workspace. Upload a complete user-supplied
  8-file dataset and
  press one `Process dataset` button. There is no pre-run A/B/C selector: the
  pipeline validates the bundle, runs all three official policies, exposes a
  compact live stage log, and releases three output CSVs for each feasible
  policy. No dataset is preloaded or offered as a sample shortcut. Proxies
  `/api/*` to the backend.
- `api/replanner.py` — narrow deterministic disruption parser and minimal-churn
  repair kept as a backend endpoint only; the product UI no longer exposes a
  replan panel. Unaffected activities remain locked; only the independent
  validator can release replanned CSVs. The explainer is templated and never
  establishes feasibility.
- `api/dayplan.py` — advisory weekday planner running in the solver's own
  engine (`POST /api/plan-days`): contract priority, Live buffers plus
  opposite-bound mirroring, sole/shared possession rules, co-share groups,
  and workfront caps place each scheduled night on Mon–Sun with per-pick
  reasons. User picks are always preserved. Output is a planning overlay
  only: never validated, never scored, never written into canonical or
  submission files. The browser keeps a deterministic local fallback for
  offline use.
- `api/pipeline.py` — deterministic eight-file schema gate, stable evidence
  IDs, solver orchestration, independent-validator release gate, and exact CSV
  release only for feasible candidates.
- `api/ai_explainer.py` — optional Vertex Gemini explanation of already-checked
  structured evidence. It has no scheduling, validation, approval, state-change,
  or export authority and degrades to deterministic text when AI is unavailable.
- `docs/PRIORITY_AND_REPLAN_PIPELINE.md` — operator-grounded redesign of the
  initial event-sorting sketch. It separates work type, lifecycle state,
  dynamic risk, deterministic feasibility, EWR judgment, and execution/replan.
- `docs/UI_USER_FLOW.md` — standalone Mermaid interface journey covering the
  upload, implemented consent-gated AI conversion, processing, result, export,
  replan, and planned assistance screens.
  Backend control flow remains in the pipeline document rather than being mixed
  into this UI graph.

## Local run

```
python3 -m pip install -r api/requirements.txt
python3 -m uvicorn api.main:app --port 8000  # from repo root
cd web && npm install && npm run dev      # opens on :3000, /api -> :8000
cd web && npm test                         # UI interaction-contract tests
python3 -m unittest api.tests.test_ai_converter -v  # AI adapter boundary tests
python3 -m api.tests.run_checks           # regression + mutation tests
```

The mutation suite includes feasible workload increases, exact-horizon and
one-over cases, competing work, workfront and weekly-allocation boundaries,
capacity and per-possession mix limits, predecessor timing, Scenario B dates,
Scenario C ECLO windows, Live mirrors, buffer warnings, and malformed schedule
fields. Every infeasible pipeline case must return no CSV files.

The intake screen can offer an AI conversion draft when uploaded text data does
not already match the canonical eight-file contract. The local adapter accepts
CSV, TSV, JSON, Markdown, and plain text; opaque binary formats are rejected
before any provider call. Filename mismatches do not use AI: the user assigns
each unmatched file to an available `01`–`08` canonical slot and Project TAO
creates an internal renamed copy. Gemini is offered only after deterministic
content validation fails. The interface shows the exact files first and
requires explicit consent before `POST /ai/convert`. Originals remain
unchanged, the draft stays editable and untrusted, ambiguities require user
confirmation, and only the deterministic schema gate can admit all eight
canonical tables.

`POST /ai/explain` can produce a local deterministic summary without any cloud
call. With explicit consent it sends only allowlisted structured evidence to
Gemini on Vertex AI. The API uses the Cloud Run service identity through
Application Default Credentials; no user or provider API key is accepted by
the browser.

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

The script enables the required Google APIs (including Vertex AI), creates a
dedicated `ps1-api-runtime` service account with `roles/aiplatform.user`, and
deploys `ps1-api` with Vertex Gemini configured through Application Default
Credentials. It then discovers the Cloud Run URL and deploys `ps1-web` with
that URL as the internal rewrite target. Both services use
`asia-southeast1` by default, scale to zero, and allow unauthenticated judging
access. Override `GCP_REGION`, `API_SERVICE`, `WEB_SERVICE`, or
`API_SERVICE_ACCOUNT` only when the target project requires different names.

No provider key is deployed. Gemini uses the Cloud Run service identity. The
temporary `.env.production` generated during the web build contains only the
public API service URL and is deleted when the script exits.

Verified Google Cloud deployment (19 September 2026, current revision):

- Judge web app: `https://ps1-web-243124675970.asia-southeast1.run.app`
- API: `https://ps1-api-243124675970.asia-southeast1.run.app`
- Revisions: API `ps1-api-00004-fcb`; web `ps1-web-00007-46v`; each serves
  100 percent of traffic.
- Public smoke evidence: `/health` returned `{"ok":true}`; multipart `/validate`
  passed with evidence `SCHEMA-77e3579d6038a895`; Scenario A `/solve` passed the
  independent validator with zero hard violations and returned exactly 192
  access rows, 928 occupancy rows, 14 result rows, and all three CSV files. Its
  score was 1712.2 with 43 remaining soft warnings under the stricter
  cross-contract closure rule.
- Public `POST /plan-days` returned `tao-dayplan/1` suggestions across 29 weeks
  for that generated schedule while preserving a fixed user pick. Installed
  Chrome completed the public 8/8-file solve, results, recovery/explainer and
  consent-gated conversion journey. The root judge URL redirects to `/mockup`.
- The current judge-facing flow requires the user to select all eight CSVs
  directly; it does not preload or fetch a sample dataset.

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

- When a PS1 requirement is unclear, inspect the official organiser repository
  (`aochinwen/NebulaX-Hackathon-ProblemStatement`) first: current README, eight
  input CSVs, and supplied output sample. If those official sources conflict,
  document the exact conflict and leave it unresolved pending the reference
  validator or organiser ruling instead of inventing a rule.
- Greedy constructor ordered by constraint tightness (predecessor depth,
  deadline slack, buffer footprint, hotspot scarcity, workload, tier weight),
  then bounded deterministic repair + improvement (lexicographic: hard
  violations, buffer warnings, score). Fixed seed. Never crashes on congestion:
  unplaceable work is forced and honestly reported.
- Validator is independent (reads only plain schedule dicts + inputs).
- A supplied job duration is all-in: setup, preparation, execution, close-out,
  and paperwork are already included. Compare it directly with an explicit
  slot duration; equality is feasible, and no generic padding is added or
  deducted. The current official eight CSVs contain no per-job minute field,
  so this guard applies only when later canonical intake explicitly supplies
  both values. AI has no authority to reinterpret it. Cross-possession buffer
  semantics remain a separate spatial rule and never reduce an individual
  job's stated slot time.
- Mix limits apply **per possession** (location, week, co-share group). Capacity counts distinct
  possession groups vs `LOCATION_SUPPLY` (A: zero tolerance, C: +1 soft,
  B: soft only). `access_night` is local per contract+type+week.
- Sector expansion is unchanged. For non-Live work, deterministic concurrency
  exists only for the official local key (contract_number, activity_type, week,
  access_night): different local nights within that key are not concurrent, and
  equal numeric access_night across different contract/type keys is not a global
  night. Exact same (location_id, week, co_share_group) is one co-shared
  possession and exempt at that shared footprint. Concurrent actual footprint
  overlap between distinct possessions is hard `closure`; concurrent actual
  footprint entering another possession's exclusion-only buffer is hard `buffer`.
  Different contracts have no comparable local access-night axis, so any
  same-week actual-footprint overlap between them is a hard `closure` unless
  the exact shared location/week/co-share tuple is exempt. Buffer-vs-buffer and
  buffer-only cross-contract ambiguity stay `buffer_note` warnings. Live
  opposite-bound and H01/H02 interchange mirrors stay hard. The supplied sample
  contains 50 cross-contract closures under this stricter rule and is therefore
  no longer treated as validator ground truth. Solver `State.test` agrees with
  the independent validator and minimizes remaining warning count as a hedge.
- Open organiser questions: official validator + `trackaccess` helper absent;
  submission says GitHub here vs GitLab in PS1 README; buffer semantics pending
  official confirmation.

## Status

Scenario A/B/C all feasible on the public pack with 0 hard violations under the
stricter cross-contract closure rule (A 1712.2 / B 30 / C 1712.2 in the local
10-second verification run). The sample's 192/928/14 row counts are reproduced,
but its 50 cross-contract closure conflicts are now reported rather than
downgraded to warnings.
The disruption-replan panel was removed from the product UI to avoid operator
confusion; the backend endpoint is retained. There is no generative AI
  in the feasibility or CSV path. The backend now includes a deterministic schema
  gate and an optional Vertex Gemini evidence explainer. The workspace shows a
  day view (one focused week, weekday planning with user picks plus
  engine-suggested workdays and reasons, sidecar CSV export) beside the
  30-week overview, ECLO half-dot markers, overlap badges (sole use vs
  shareable), and a reason panel instead of empty grids when a policy is
  infeasible. Manual filename mapping, the consent-gated mixed-text-format
  repair adapter, and the Settings UI are implemented. Google Cloud Run hosts
  the current revision (see below); the qwiklabs project hosting it expires
  with the lab.
