# PS1 App — Wireframe Blueprint (all screens)

Source of truth: Notion brain hub `NEBULA X Hackathon 2026` + handover
`NEBULA X PS1 - Verified Deterministic Backend and Boundary Test Handover -
19 Sep 2026` + SMRT interview record. Targets the team repo
(`BOLDers-PS1-Hackathon`) state: schema gate, A/B/C solver, validator,
exporter, disruption replan, evidence-only DeepSeek explainer.

Design language: dark ops console (bg `#0b0e14`, card `#151a24`,
accent `#2f6feb`, ok `#3fb950`, bad `#f85149`, mono evidence IDs).
Readable at 2am by a works controller. Every AI string labelled;
validator badge is the only feasibility authority.

Execution note: build in Pencil (pen.dev) with MCP in the restarted client.
Order: S01 → S02 → S03 → S08 (judge path first), then S04 → S05 → S06,
then S07 → S09 → S01-tab-B. Reuse one `Badge`, `ScoreTable`, `ViolationsList`,
`FileDrop`, `CostDelta` component set everywhere.

---

## S01 — Upload & schema gate (first judge screen)

Purpose: get the hidden 8-file instance in cleanly or fail loudly.
Layout: header (app name + scenario clock) / left: 8 file slots with
✓/○ + `Load public sample dataset` button / right: gate results panel.
States: empty → partial (missing list) → parsed (54 acts / 14 contracts /
192 units summary) → schema errors (table: file, row, evidence ID, message).
Bindings: `POST /solve` doubles as validator (malformed → 400 + evidence);
sample button fetches the 8 GitHub raw CSVs.
Tab B (pending build): mixed-format AI intake — paste text/ticket dump →
untrusted canonical draft preview → `Ask when uncertain` chips → `Send
through schema gate` (never bypasses it). Draft visibly stamped UNTRUSTED
until gate passes.

## S02 — Scenario + solve

Purpose: one controlled release per run (most-recent-upload-is-final rule).
Layout: A/B/C tabs with one-line trade-off captions (A: overrun only;
B: zero overrun, pay nights+ECLO; C: both, +1 excess soft) / budget stepper
(default 8s) / big `Solve + validate` / run history (last-good preserved).
States: idle → solving (progress, no long-held-connection spinner hack:
poll) → done. Failed run never overwrites last-good (banner:
"kept last feasible").
Bindings: `POST /solve {scenario, time_budget, files}`.

## S03 — Results dashboard (the 3-minute video hero)

Purpose: feasibility + score at a glance, then drill down.
Layout top: giant badge `FEASIBLE · 0 hard violations` (or red
`INFEASIBLE · n` + export blocked) / score cards row (objective score,
overrun days, excess nights, ECLO nights, contracts overrunning) /
per-contract table (contract, tier, completion, overrun, weighted cost) /
buffer-warning count (amber, expandable) / capacity hotspots chips.
Bindings: `report.soft_scores`, `report.detail`, `report.hard_violations`.
Copy rule: AI explainer text (DeepSeek, evidence-only) appears in a
labelled box below the deterministic numbers, never above them.

## S04 — Timeline / heatmap

Purpose: see congestion (answers "where does it hurt").
Layout: grid locations (rows, hotspot H01_H02 pinned top) × weeks 1–30
(columns); cell shade = possessions/supply; click cell → occupant list
(activity, group, possession mix). Toggle: per scenario A/B/C overlay.
ECLO nights hatched. Predecessor chains drawn A004→A003 style on selection.
Bindings: derived client-side from the 3 CSVs (no new endpoint).

## S05 — Activity inspector (drawer, not a page)

Purpose: answer "why was this moved / what breaks if it slips".
Triggered from S03/S04 row/cell click. Contents: activity facts
(contract, tier, workload, window, predecessor), its weeks, downstream
dependents, `what-if slip 1 week` cost delta (deterministic recompute),
validator evidence IDs. No edits here — edits live in S06.

## S06 — Disruption replan (the differentiator demo)

Purpose: the operator's exact ask — tonight's plan is set, a morning
defect/alert lands, replan the mess with minimal churn.
Layout: disruption form (location, week, new capacity / urgent job) /
affected-chain preview (locked vs movable list) / `Replan` → replacement
plan + EXACT move log (A012 wk4→wk6, cost +7 P3…) + before/after score /
validator proof badge / big `Approve (human)` + `Reject`.
Rules enforced in UI: unaffected locked, only affected chain moves,
same validator release gate, human approval required, AI text labelled.
Bindings: replan endpoint (validator-gated) + explain endpoint (evidence-only).

## S07 — Work records: Cancelled / Interrupted / Deferred (pending build)

Purpose: persistent operator truth the solver must respect.
Layout: three lists with reason field (user-entered, required), timestamp,
author, status; each record needs human confirmation toggle before the
solver treats it as input. Deferred shows the risk-forced deadline
(PM-cycle logic from the interview). Bindings: new CRUD endpoints; solver
reads confirmed records as constraints.

## S08 — Export & submission freeze (judge-critical)

Purpose: controlled release under the 5-uploads-per-scenario rule.
Layout: per-scenario bundle cards (3 CSVs + validator JSON, evidence IDs,
hash) / `Freeze 9-file ZIP` (re-validates everything first) / upload
budget tracker `used n/5 per scenario` with warning at 4/5 / red banner:
"Most recent upload is FINAL — this freeze needs explicit team approval"
+ approver name field / frozen-submission ledger.
Invalid candidates release no CSVs (backend already enforces; UI shows
blocked state, never a download).

## S09 — Settings

Purpose: keys and providers without touching the server.
Contents: DeepSeek API key field (ephemeral: kept in browser session only,
sent per-request as `X-DeepSeek-API-Key`, never stored/committed) /
`Test handshake` (pending live key) / deterministic-text fallback toggle /
deployment target readout (Google Cloud primary, Railway fallback).
No shared server-wide key, ever.

---

## Pencil build checklist

Frames: `S01-Upload`, `S02-Solve`, `S03-Dashboard`, `S04-Timeline`,
`S05-Inspector(drawer)`, `S06-Replan`, `S07-Records`, `S08-Freeze`,
`S09-Settings`. Variables: bg/card/accent/ok/bad/amber + mono.
Components first (`Badge`, `ScoreTable`, `ViolationsList`, `FileDrop`,
`CostDelta`, `ApprovalBar`), then screens, then a click-through
`Judge demo` flow: S01 → S02 → S03 → S06 → S08.
