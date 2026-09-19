# OpenCode handover — Project TAO

You are continuing Project TAO, the BOLDers PS1 Track Access Optimiser for NEBULA X Hackathon 2026.

## Operating instructions

1. Work in `/Users/sohlinhan/Desktop/ps1-app`, not the Codex worktree.
2. Read `/Users/sohlinhan/Documents/Obsidian Vault/Lin Han's Brain/README.md` and `AGENT_RULES.md`, then run:
   `python3 /Users/sohlinhan/.local/share/brain-tools/brain_retrieve.py "Project TAO PS1 current implementation and next work"`
3. Read the Brain hub `NEBULA X Hackathon 2026` and its active PS1 decisions before changing code.
4. Preserve all existing working-tree changes. Do not reset, discard, deploy, commit, push, or submit anything unless Lin Han explicitly asks.
5. The official organiser GitHub pack at `/tmp/PS1-latest` is the primary requirements authority. If its README, sample and data conflict, document the conflict rather than guessing.
6. Work locally first. Keep the current Cloud Run revision unchanged until Lin reviews and approves deployment.

## Current product state

- The active UI is `http://127.0.0.1:3000/mockup`; `/` redirects there.
- FastAPI runs at `http://127.0.0.1:8000`.
- The UI starts empty. Users upload all eight PS1 CSV concepts and press one Process dataset button. There is no preset sample or pre-run A/B/C selector.
- All three official policies run automatically through one deterministic schema gate and an independent validator release gate.
- Results include policy comparison, a real schedule Gantt, the uploaded railway topology including interchange stations, validated CSV downloads, and a narrow disruption replan.
- Optimisation seconds are in the top-right Settings page. Bounds are 1–60 seconds per policy. Settings also control replan effort, terminal detail and which validated policy opens first.
- Filename mismatches use explicit local manual mapping: the user selects an unmatched file and assigns it to an available `01`–`08` canonical CSV slot. No AI is used for filename correction.
- Gemini on Google Cloud Vertex AI is offered only after a complete eight-file bundle fails deterministic content validation. Consent is required. Output is an editable untrusted draft; ambiguities require user confirmation and deterministic validation before acceptance.
- The browser accepts no AI API key. The backend uses `google-genai` in Vertex AI mode with Application Default Credentials. `scripts/deploy_google_cloud.sh` enables Vertex AI, creates `ps1-api-runtime`, grants `roles/aiplatform.user`, and configures `gemini-2.5-flash`.
- Local Google Gen AI SDK import succeeds, but this Mac currently has no active Google Cloud ADC login or selected project. A live local Gemini call requires user-authorised Google authentication. Do not invent or expose credentials.

## Confirmed PS1 time semantics

- The official schedule is week-indexed. `06_PARAMETERS.csv` supplies `horizon_start=2027-01-04` and `horizon_weeks=30`.
- Input start/deadline fields are ISO calendar dates; deterministic code maps them into schedule weeks relative to `horizon_start`.
- `SCHEDULE_ACCESS.csv` schedules each access with `week`, `eclo`, and `access_night`.
- `total_accesses` is required access-night/work-unit workload, not a continuous number of weeks.
- `access_night` is a local ordinal within `(contract_number, activity_type, week)`, not a weekday or exact calendar date.
- The live results screen correctly uses a weekly axis. However, its pale continuous shading from first to last access can imply continuous occupation during gap weeks. Individual access markers are authoritative. If Lin asks for the display refinement, make discrete scheduled weeks dominant and label the longer span only as an activity delivery window. Do not fabricate Tue/Thu/Sat dates.

## Deterministic rules that must not regress

- A job's stated duration is all-in occupation time. Exact equality fits: 120 minutes fits 120 minutes; four hours fits four hours. Reject only when duration exceeds the slot or another explicit rule fails. Never add generic setup/paperwork/safety padding or shrink the slot.
- `access_night` concurrency is local per contract + activity type + week.
- Cross-contract closure rule: different contracts have no comparable local access-night axis, so a same-week actual-footprint overlap is a hard closure unless the exact location/week/co-share tuple is exempt. Same-key concurrent actual-vs-actual remains hard closure, concurrent actual-vs-exclusion-only remains hard buffer, pure buffer-vs-buffer and buffer-only ambiguity remain warnings, and Live mirrors remain hard. The supplied sample contains 50 such cross-contract closures and is no longer treated as validator ground truth.
- AI never decides feasibility, scheduling, approval or export. Deterministic code remains authoritative.

## Verification completed locally

- `cd web && npm test` — 79 tests passed.
- `cd web && npx tsc --noEmit` — passed.
- `cd web && npm run build` — passed.
- `python3 -m unittest api.tests.test_ai_converter` — 7 tests passed.
- `python3 -m api.tests.run_checks` — complete regression, mutation, validator and duration-boundary suite passed.
- `cd web && npm run test:e2e` — installed Google Chrome solve, replan, manual filename mapping, recovery, deterministic explainer and Gemini-consent screen passed.
- `bash -n scripts/deploy_google_cloud.sh` — passed.
- Brain consistency check passed with 1,762 notes at completion time.

## Repository and deployment state

- Shared remote: `https://github.com/oscarsohlinhan-rgb/BOLDers-PS1-Hackathon.git`, branch `main`.
- The public Cloud Run deployment includes the Python weekday-planning engine,
  `POST /plan-days`, the day/week planning UI, and the stricter cross-contract
  closure validator. API `ps1-api-00004-fcb` and web `ps1-web-00007-46v` each
  serve 100 percent of traffic.
- Public verification covered `/health`, eight-file schema validation, Scenario
  A solve/export, the `tao-dayplan/1` endpoint and the installed-Chrome product
  journey.

## First action in OpenCode

Read the files and verify the status above before changing code. Then tell Lin:

1. you have loaded the handover;
2. the exact repository and local URLs you are using;
3. the current Cloud Run revisions and Git commit; and
4. the next requested change you are ready to perform.

Do not independently start the optional Gantt refinement; it was identified as a recommendation, not yet ordered.
