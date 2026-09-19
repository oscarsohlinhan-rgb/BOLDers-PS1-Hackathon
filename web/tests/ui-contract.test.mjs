import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");

test("the product is named Project TAO in the document and interface", () => {
  assert.match(layout, /title: "Project TAO"/);
  assert.match(page, />Project TAO</);
  assert.match(page, /Track Access Optimiser/);
});

test("a short welcome sequence yields to the Project TAO workspace", () => {
  assert.match(page, /className="tao-intro"/);
  assert.match(page, /\{introVisible && \(/);
  assert.match(page, /className="intro-word intro-welcome">Welcome/);
  assert.match(page, /className="intro-word intro-brand">/);
  assert.match(page, /Skip intro/);
  assert.match(page, /setIntroVisible\(false\)/);
  assert.match(page, /intro-pending/);
  assert.match(page, /aria-hidden=\{introVisible\}/);
});

test("the primary intake is a drop field with selected-file removal", () => {
  assert.match(page, /Drop your dataset here/);
  assert.match(page, /or browse files/);
  assert.match(page, /removeSelectedFile/);
  assert.match(page, /aria-label=\{`Remove \$\{file\.name\}`\}/);
});

test("intake recommends canonical names but routes inaccurate names to reviewed AI identification", () => {
  assert.match(page, /Upload all eight PS1 source tables together/);
  assert.match(page, /Exact filenames are recommended, not required/);
  assert.match(page, /AI-assisted identification/);
  assert.match(page, /review the proposed table mapping/);
});

test("processing starts only after all eight files are uploaded", () => {
  assert.match(page, /"Process dataset"/);
  assert.match(page, /disabled=\{busy \|\| conversionBusy \|\| files\.size !== EXPECTED\.length\}/);
});

test("there is no pre-run A B C scenario selector", () => {
  assert.doesNotMatch(page, /<h3>2\. Scenario<\/h3>/);
  assert.doesNotMatch(page, /setScenario/);
  assert.doesNotMatch(page, /className="tabs"/);
});

test("one process action runs every official policy", () => {
  assert.match(page, /const PROCESS_POLICIES = \["A", "B", "C"\] as const/);
  assert.match(page, /for \(const policy of PROCESS_POLICIES\)/);
});

test("the page exposes a live pipeline terminal", () => {
  assert.match(page, /Pipeline terminal/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /className="terminal"/);
  assert.match(page, /appendLog/);
});

test("dataset and replan controls lock while a run is active", () => {
  assert.match(page, /id="dataset-files"[\s\S]{0,240}disabled=\{busy \|\| conversionBusy\}/);
  assert.match(page, /aria-label="Optimisation time per policy"[\s\S]{0,240}disabled=\{busy \|\| conversionBusy\}/);
  assert.match(page, /className="text-button"[\s\S]{0,140}disabled=\{busy \|\| conversionBusy\}/);
  assert.match(page, /aria-label="Disruption command"[\s\S]{0,200}disabled=\{busy \|\| conversionBusy\}/);
});

test("file intake supports multiple selection batches", () => {
  assert.match(page, /const next = new Map\(files\)/);
});

test("each policy settles independently instead of leaving pending cards", () => {
  assert.match(page, /policyErrors/);
  assert.match(page, /setPolicyErrors/);
  assert.match(page, /results\[policy\] \|\| policyErrors\[policy\]/);
});

test("replan output retains changes warnings and hard violations", () => {
  assert.match(page, /replanResult\.changes\.map/);
  assert.match(page, /soft_warnings\.map/);
  assert.match(page, /hard_violations\.map/);
});

test("dynamic status and repeated downloads are accessible", () => {
  assert.match(page, /role="status"/);
  assert.match(page, /role="alert"/);
  assert.match(page, /aria-label=\{`Download Policy \$\{policy\}/);
});

test("processing budget is clamped to the API range", () => {
  assert.match(page, /Math\.max\(1, Math\.min\(60,/);
});

test("non-canonical files open a consent-gated AI conversion flow", () => {
  assert.match(page, /AI-assisted conversion/);
  assert.match(page, /DeepSeek/);
  assert.match(page, /exact files and fields/);
  assert.match(page, /type="checkbox"/);
  assert.match(page, /Create conversion draft/);
});

test("AI conversion sends a temporary key without persisting it", () => {
  assert.match(page, /type="password"/);
  assert.match(page, /X-DeepSeek-API-Key/);
  assert.doesNotMatch(page, /localStorage/);
  assert.doesNotMatch(page, /sessionStorage/);
});

test("converted tables remain editable until review and deterministic validation", () => {
  assert.match(page, /Review AI conversion draft/);
  assert.match(page, /<textarea/);
  assert.match(page, /Validate edited draft/);
  assert.match(page, /Accept checked draft/);
  assert.match(page, /canAcceptDraft/);
});

test("the adapter supports each declared text format and keeps manual exit available", () => {
  assert.match(page, /accept="\.csv,\.tsv,\.txt,\.json,\.md"/);
  assert.match(page, /CSV, TSV, JSON, TXT and Markdown/);
  assert.match(page, /Continue without AI/);
});

test("review exposes all eight canonical tables even when AI omits one", () => {
  assert.match(page, /\{EXPECTED\.map\(\(tableName\) => \(/);
});

test("the main journey uses exclusive intake processing and results screens", () => {
  assert.match(page, /type Screen = "intake" \| "processing" \| "results"/);
  assert.match(page, /screen === "intake"/);
  assert.match(page, /screen === "processing"/);
  assert.match(page, /screen === "results"/);
  assert.match(page, /setScreen\("processing"\)/);
  assert.match(page, /setScreen\("results"\)/);
});

test("intake starts empty then reveals recognition progress and a guarded Next action", () => {
  assert.match(page, /Analysing dataset/);
  assert.match(page, /recognisedCount/);
  assert.match(page, /identified tables/);
  assert.match(page, />Next</);
});

test("processing exposes truthful configuration telemetry before results", () => {
  assert.match(page, /file_count=/);
  assert.match(page, /time_budget=/);
  assert.match(page, /horizon_start=/);
  assert.match(page, /objective_score=/);
  assert.match(page, /See results/);
});

test("results provide linked Gantt and railway schematic planning views", () => {
  assert.match(page, /PlanningWorkspace/);
  assert.match(page, /Night detail/);
  assert.match(page, /Month window/);
  assert.match(page, /Full horizon/);
  assert.match(page, /Railway schematic/);
  assert.match(page, /selectedActivity/);
});
