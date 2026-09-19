"use client";

import "./globals.css";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  EXPECTED,
  buildConversionSources,
  canAcceptDraft,
  classifyDroppedFiles,
} from "./intake.mjs";
import { buildPlanningModel, selectBestPolicy, formatWeekStart } from "./planning.mjs";

const PROCESS_POLICIES = ["A", "B", "C"] as const;
type Policy = (typeof PROCESS_POLICIES)[number];

const POLICY_LABELS: Record<Policy, string> = {
  A: "Fixed supply",
  B: "Zero overrun",
  C: "Balanced capacity",
};

type Report = {
  scenario: Policy;
  feasible: boolean;
  hard_violations: { rule: string; severity: string; detail: string }[];
  soft_scores: Record<string, unknown>;
  detail: {
    capacity_hotspots: string[];
    nights_scheduled: number;
    eclo_nights: number;
  };
};

type SolveResult = {
  status: string;
  report: Report;
  files: Record<string, string>;
};

type ReplanResult = {
  status: string;
  explanation: string;
  changes: { activity_id: string; before_weeks: number[]; after_weeks: number[] }[];
  validator_gate: {
    passed: boolean;
    hard_violations: { rule: string; detail: string }[];
    soft_warnings: { rule: string; detail: string }[];
  };
};

type SchemaError = {
  code: string;
  file?: string;
  row?: number;
  field?: string;
  detail: string;
};

type SchemaGate = {
  passed: boolean;
  evidence_id?: string;
  errors: SchemaError[];
};

type ConversionMapping = {
  source_file?: string;
  source_ref?: string;
  target_file?: string;
  target_field?: string;
  confidence?: string;
  note?: string;
};

type ConversionUncertainty = {
  source_file?: string;
  source_ref?: string;
  target_file?: string;
  target_field?: string;
  reason?: string;
};

type ConversionDraft = {
  provider: string;
  model: string;
  draft_id: string;
  untrusted_draft: true;
  tables: Record<string, string>;
  mappings: ConversionMapping[];
  uncertainties: ConversionUncertainty[];
  schema_gate: SchemaGate;
};

type Screen = "intake" | "processing" | "results";

function download(name: string, text: string) {
  if (!text) return;
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(anchor.href);
}

function requestBundle(files: Map<string, File>) {
  const body = new FormData();
  for (const name of EXPECTED) body.append("files", files.get(name)!);
  return body;
}

function requestDraft(tables: Record<string, string>) {
  const body = new FormData();
  for (const name of EXPECTED) {
    body.append("files", new File([tables[name] || ""], name, { type: "text/csv" }));
  }
  return body;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function apiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as Record<string, unknown>;
  if (typeof value.error === "string") return value.error;
  if (value.error && typeof value.error === "object") {
    const detail = (value.error as Record<string, unknown>).detail;
    if (typeof detail === "string") return detail;
  }
  if (Array.isArray(value.errors) && value.errors.length) {
    const first = value.errors[0] as Record<string, unknown>;
    if (typeof first.detail === "string") return first.detail;
  }
  return fallback;
}

function getFileExtension(name: string): string {
  return name.split(".").pop()?.toUpperCase() || "FILE";
}

export default function Page() {
  const [screen, setScreen] = useState<Screen>("intake");
  const [introVisible, setIntroVisible] = useState(true);
  const [introPhase, setIntroPhase] = useState<"welcome" | "brand" | "exit">("welcome");
  const [dragActive, setDragActive] = useState(false);
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [budget, setBudget] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Partial<Record<Policy, SolveResult>>>({});
  const [policyErrors, setPolicyErrors] = useState<Partial<Record<Policy, string>>>({});
  const [logs, setLogs] = useState<string[]>([
    "[standby] Waiting for the eight official PS1 CSV files.",
  ]);
  const [replanPolicy, setReplanPolicy] = useState<Policy | null>(null);
  const [disruption, setDisruption] = useState("delay A001 by 1 week");
  const [replanResult, setReplanResult] = useState<ReplanResult | null>(null);
  const [replanFiles, setReplanFiles] = useState<Record<string, string> | null>(null);
  const [conversionSources, setConversionSources] = useState<File[]>([]);
  const [conversionConsent, setConversionConsent] = useState(false);
  const [conversionKey, setConversionKey] = useState("");
  const [conversionBusy, setConversionBusy] = useState(false);
  const [conversionError, setConversionError] = useState("");
  const [conversionDraft, setConversionDraft] = useState<ConversionDraft | null>(null);
  const [draftGate, setDraftGate] = useState<SchemaGate | null>(null);
  const [selectedDraftFile, setSelectedDraftFile] = useState<string>(EXPECTED[0]);
  const [draftReviewed, setDraftReviewed] = useState(false);
  const [recognisedCount, setRecognisedCount] = useState(0);
  const [countAnimating, setCountAnimating] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<string | null>(null);
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [viewMode, setViewMode] = useState<"night" | "month" | "full">("night");

  const fileTextsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) {
      setIntroVisible(false);
      return;
    }
    const brandTimer = window.setTimeout(() => setIntroPhase("brand"), 850);
    const exitTimer = window.setTimeout(() => setIntroPhase("exit"), 1850);
    const hideTimer = window.setTimeout(() => setIntroVisible(false), 2350);
    const handlePreference = (event: MediaQueryListEvent) => {
      if (event.matches) setIntroVisible(false);
    };
    preference.addEventListener("change", handlePreference);
    return () => {
      window.clearTimeout(brandTimer);
      window.clearTimeout(exitTimer);
      window.clearTimeout(hideTimer);
      preference.removeEventListener("change", handlePreference);
    };
  }, []);

  useEffect(() => {
    if (files.size === 0 || screen !== "intake") {
      if (files.size === 0) {
        setRecognisedCount(0);
        setCountAnimating(false);
      }
      return;
    }
    const canonicalCount = Array.from(files.values()).filter((f) =>
      EXPECTED.some((name) => name === f.name)
    ).length;
    const target = Math.max(canonicalCount, files.size);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRecognisedCount(target);
      setCountAnimating(false);
      return;
    }
    let cancelled = false;
    let frame = 0;
    setCountAnimating(true);
    setRecognisedCount(0);
    const duration = 1200;
    const startTime = Date.now();
    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setRecognisedCount(Math.round(eased * target));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        setRecognisedCount(target);
        setCountAnimating(false);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [files, screen]);

  function appendLog(message: string) {
    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    setLogs((current) => [...current, `[${time}] ${message}`]);
  }

  function pick(list: FileList | null) {
    if (!list) return;
    const incoming = Array.from(list);
    const next = new Map(files);
    const classified = classifyDroppedFiles(incoming);
    for (const file of classified.canonical) {
      next.set(file.name, file);
    }
    const sources = buildConversionSources(
      Array.from(next.values()),
      conversionSources,
      incoming,
    );
    setConversionSources(sources);
    if (sources.length) {
      setConversionConsent(false);
      setConversionDraft(null);
      setDraftGate(null);
      setDraftReviewed(false);
      setConversionError("");
    }
    setFiles(next);
    setResults({});
    setPolicyErrors({});
    setSelectedPolicy(null);
    setReplanPolicy(null);
    setReplanResult(null);
    setReplanFiles(null);
    setError("");
    setLogs([
      `[intake] Recognised ${next.size}/8 required files.`,
      ...(classified.conversion.length
        ? [`[adapter] ${classified.conversion.length} non-canonical source file(s) ready for optional AI identification.`]
        : []),
      next.size === EXPECTED.length
        ? "[ready] Dataset complete. Press Process dataset to begin."
        : `[hold] Missing ${EXPECTED.length - next.size} required file(s).`,
    ]);
  }

  function removeSelectedFile(fileName: string) {
    if (EXPECTED.some((name) => name === fileName)) {
      const next = new Map(files);
      next.delete(fileName);
      setFiles(next);
      setConversionSources((previous) => buildConversionSources(
        Array.from(next.values()),
        previous.filter((file) => file.name !== fileName),
        [],
      ));
    } else {
      setConversionSources((previous) => buildConversionSources(
        Array.from(files.values()),
        previous.filter((file) => file.name !== fileName),
        [],
      ));
    }
    setResults({});
    setPolicyErrors({});
    setSelectedPolicy(null);
    setReplanPolicy(null);
    setReplanResult(null);
    setReplanFiles(null);
    setError("");
    appendLog(`[intake] Removed ${fileName}.`);
  }

  async function readAllFiles(fileMap: Map<string, File>): Promise<Record<string, string>> {
    const texts: Record<string, string> = {};
    for (const [name, file] of fileMap) {
      texts[name] = await file.text();
    }
    return texts;
  }

  function parseParameters(csvText: string): { horizonStart: string; horizonWeeks: number } {
    let horizonStart = "2027-01-04";
    let horizonWeeks = 30;
    const lines = csvText.trim().split("\n");
    const headers = lines[0]?.split(",").map((h) => h.trim()) || [];
    const keyIdx = headers.indexOf("key");
    const valIdx = headers.indexOf("value");
    if (keyIdx < 0 || valIdx < 0) return { horizonStart, horizonWeeks };
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const key = cols[keyIdx]?.trim();
      const val = cols[valIdx]?.trim();
      if (key === "horizon_start") horizonStart = val || horizonStart;
      if (key === "horizon_weeks") horizonWeeks = parseInt(val, 10) || 30;
    }
    return { horizonStart, horizonWeeks };
  }

  async function processDataset(snapshotFiles: Map<string, File> = files, snapshotBudget: number = budget) {
    const missing = EXPECTED.filter((name) => !snapshotFiles.has(name));
    if (missing.length) {
      setError(`Missing: ${missing.join(", ")}`);
      return;
    }

    setBusy(true);
    setError("");
    setResults({});
    setPolicyErrors({});
    setSelectedPolicy(null);
    setReplanPolicy(null);
    setReplanResult(null);
    setReplanFiles(null);
    setLogs(["[boot] Deterministic PS1 pipeline started."]);

    try {
      appendLog("INTAKE  Reading 8 CSV files in canonical order.");
      appendLog("SCHEMA  Checking names, headers, types and relationships.");
      const fileTexts = await readAllFiles(snapshotFiles);
      fileTextsRef.current = fileTexts;

      const { horizonStart, horizonWeeks } = parseParameters(fileTexts["06_PARAMETERS.csv"] || "");
      const canonicalCount = snapshotFiles.size;

      appendLog(`TELEMETRY  file_count=${canonicalCount}, time_budget=${snapshotBudget}, horizon_start=${horizonStart}, horizon_weeks=${horizonWeeks}`);

      const validationResponse = await fetch("/api/validate", {
        method: "POST",
        body: requestBundle(snapshotFiles),
      });
      const validation = await validationResponse.json();
      if (!validationResponse.ok || !validation.passed) {
        throw new Error(apiError(validation, "Schema validation failed"));
      }
      appendLog(`SCHEMA  Passed · evidence ${validation.evidence_id || "recorded"}.`);

      for (const policy of PROCESS_POLICIES) {
        appendLog(
          `SOLVE   Policy ${policy} · server indexing, sorting and optimisation started.`,
        );
        try {
          const body = requestBundle(snapshotFiles);
          body.append("scenario", policy);
          body.append("time_budget", String(snapshotBudget));
          const response = await fetch("/api/solve", {
            method: "POST",
            body,
          });
          const result = await response.json();
          if (!response.ok || !result.report) {
            throw new Error(apiError(result, `Policy ${policy} failed`));
          }
          setResults((current) => ({ ...current, [policy]: result }));
          const score = result.report.soft_scores?.objective_score;
          if (typeof score === "number") {
            appendLog(`TELEMETRY  objective_score=${score}`);
          }
          const hard = result.report.hard_violations.length;
          appendLog(
            `CHECK   Policy ${policy} · hard_violations=${hard}, nights_scheduled=${result.report.detail.nights_scheduled}, eclo_nights=${result.report.detail.eclo_nights}.`,
          );
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setPolicyErrors((current) => ({ ...current, [policy]: message }));
          appendLog(`FAIL    Policy ${policy} · ${message}`);
        }
      }
      appendLog(`DONE    All official policies settled. Feasible exports are ready below.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      appendLog(`STOP    ${message}`);
    } finally {
      setBusy(false);
    }
  }

  function handleNext() {
    const snapshotFiles = new Map(files);
    const snapshotBudget = budget;
    setScreen("processing");
    void processDataset(snapshotFiles, snapshotBudget);
  }

  function clearConversion() {
    setConversionSources([]);
    setConversionConsent(false);
    setConversionKey("");
    setConversionError("");
    setConversionDraft(null);
    setDraftGate(null);
    setDraftReviewed(false);
  }

  async function createConversionDraft() {
    if (!conversionSources.length || !conversionConsent || !conversionKey.trim()) return;
    setConversionBusy(true);
    setConversionError("");
    setConversionDraft(null);
    setDraftGate(null);
    setDraftReviewed(false);
    appendLog(`ADAPTER Sending ${conversionSources.length} consented text source(s) to DeepSeek.`);
    try {
      const body = new FormData();
      for (const file of conversionSources) body.append("files", file);
      body.append("provider", "deepseek");
      body.append("consent", "true");
      const response = await fetch("/api/ai/convert", {
        method: "POST",
        headers: { "X-DeepSeek-API-Key": conversionKey.trim() },
        body,
      });
      const payload = await response.json();
      if (!response.ok || !payload.tables) {
        throw new Error(apiError(payload, "AI conversion failed"));
      }
      const draft = payload as ConversionDraft;
      setConversionDraft(draft);
      setDraftGate(draft.schema_gate);
      setSelectedDraftFile(EXPECTED.find((name) => name in draft.tables) || EXPECTED[0]);
      appendLog(
        `ADAPTER Draft ${draft.draft_id} created · deterministic schema gate ${draft.schema_gate.passed ? "passed" : "needs review"}.`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setConversionError(message);
      appendLog(`STOP    AI conversion · ${message}`);
    } finally {
      setConversionBusy(false);
    }
  }

  function updateDraftTable(name: string, value: string) {
    if (!conversionDraft) return;
    setConversionDraft({
      ...conversionDraft,
      tables: { ...conversionDraft.tables, [name]: value },
    });
    setDraftGate(null);
    setDraftReviewed(false);
  }

  async function validateDraft() {
    if (!conversionDraft) return;
    setConversionBusy(true);
    setConversionError("");
    appendLog(`SCHEMA  Rechecking edited draft ${conversionDraft.draft_id}.`);
    try {
      const response = await fetch("/api/validate", {
        method: "POST",
        body: requestDraft(conversionDraft.tables),
      });
      const payload = await response.json();
      setDraftGate(payload as SchemaGate);
      setDraftReviewed(false);
      appendLog(
        `SCHEMA  Edited draft ${payload.passed ? "passed" : `returned ${payload.errors?.length || 0} error(s)`}.`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setConversionError(message);
      appendLog(`STOP    Draft validation · ${message}`);
    } finally {
      setConversionBusy(false);
    }
  }

  function acceptDraft() {
    if (!conversionDraft || !canAcceptDraft(Boolean(draftGate?.passed), draftReviewed)) return;
    const accepted = new Map<string, File>();
    for (const name of EXPECTED) {
      accepted.set(name, new File(
        [conversionDraft.tables[name] || ""], name, { type: "text/csv" },
      ));
    }
    setFiles(accepted);
    appendLog(`INTAKE  Accepted checked draft ${conversionDraft.draft_id} into the eight-file manifest.`);
    clearConversion();
    setResults({});
    setPolicyErrors({});
    setSelectedPolicy(null);
    setReplanPolicy(null);
    setReplanResult(null);
    setReplanFiles(null);
    setError("");
  }

  async function replan() {
    if (!replanPolicy || !disruption.trim()) return;
    setBusy(true);
    setError("");
    setReplanResult(null);
    setReplanFiles(null);
    appendLog(`REPLAN  Policy ${replanPolicy} · ${disruption.trim()}`);
    try {
      const body = requestBundle(files);
      body.append("scenario", replanPolicy);
      body.append("time_budget", String(budget));
      body.append("disruption", disruption.trim());
      const response = await fetch("/api/replan", { method: "POST", body });
      const payload = await response.json();
      if (!response.ok || !payload.replan) {
        throw new Error(apiError(payload, "Replan failed"));
      }
      setReplanResult(payload.replan);
      setReplanFiles(payload.files);
      appendLog(
        `REPLAN  Validator ${payload.replan.validator_gate.passed ? "passed" : "blocked export"}.`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      appendLog(`STOP    ${message}`);
    } finally {
      setBusy(false);
    }
  }

  const complete = files.size === EXPECTED.length;
  const finished = PROCESS_POLICIES.every((policy) => results[policy] || policyErrors[policy]);
  const selectedFiles = Array.from(new Map(
    [...files.values(), ...conversionSources].map((file) => [file.name, file]),
  ).values());
  const appClass = introVisible ? "tao-app intro-pending" : "tao-app intro-ready";
  const conversionSettled = !conversionSources.length || (conversionDraft && draftGate?.passed && draftReviewed);

  const planningModel = useMemo(() => {
    if (!selectedPolicy || !results[selectedPolicy]) return null;
    const result = results[selectedPolicy]!;
    const inputs = fileTextsRef.current;
    const outputs = result.files;
    if (!outputs || Object.keys(outputs).length === 0) return null;
    try {
      return buildPlanningModel(inputs, outputs);
    } catch {
      return null;
    }
  }, [results, selectedPolicy]);

  useEffect(() => {
    if (selectedPolicy && results[selectedPolicy]) return;
    const bestPolicy = selectBestPolicy(results) as Policy | null;
    if (bestPolicy) setSelectedPolicy(bestPolicy);
  }, [results, selectedPolicy]);

  return (
    <div className="shell">
      {introVisible && (
        <div className="tao-intro" role="dialog" aria-modal="true" aria-label="Welcome to Project TAO">
          <div className={`intro-screen phase-${introPhase}`}>
            <div className="intro-overlay">
              <div className="intro-content" aria-live="polite">
                {introPhase === "welcome" ? (
                  <span className="intro-word intro-welcome">Welcome</span>
                ) : (
                  <span className="intro-word intro-brand">Project TAO</span>
                )}
              </div>
              <button className="intro-skip" onClick={() => setIntroVisible(false)} aria-label="Skip intro">
                Skip intro
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={appClass} aria-hidden={introVisible}>
        <header className="masthead">
          <div>
            <p className="eyebrow">PROJECT TAO</p>
            <h1>Project TAO</h1>
            <p className="lede">Track Access Optimiser — Upload all eight PS1 source tables together. Exact filenames are recommended, not required.</p>
          </div>
          <div className={`system-light ${busy || conversionBusy ? "running" : complete ? "ready" : ""}`} role="status" aria-live="polite">
            <span />{conversionBusy ? "CONVERTING" : busy ? "PROCESSING" : complete ? "READY" : "AWAITING DATA"}
          </div>
        </header>

        <div className="rail" aria-label="Processing progress">
          <div className={complete ? "rail-step done" : "rail-step active"} aria-current={!complete ? "step" : undefined}>
            <span>01</span> Upload
          </div>
          <div className={busy ? "rail-step active" : finished ? "rail-step done" : "rail-step"} aria-current={complete && !finished ? "step" : undefined}>
            <span>02</span> Process
          </div>
          <div className={finished ? "rail-step active" : "rail-step"} aria-current={finished ? "step" : undefined}>
            <span>03</span> Export
          </div>
        </div>

        {screen === "intake" && (
          <section className="workspace">
            <div className="card intake-card">
              <div className="section-heading">
                <div>
                  <p className="section-kicker">DATA INTAKE</p>
                  <h2>Upload dataset</h2>
                </div>
                <strong className={complete ? "counter complete" : "counter"}>
                  {files.size}<small>/8 files</small>
                </strong>
              </div>

              <label
                className={dragActive ? "dropzone drag-active" : "dropzone"}
                htmlFor="dataset-files"
                onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragActive(false);
                  pick(event.dataTransfer.files);
                }}
              >
                <input
                  id="dataset-files"
                  className="file-input"
                  type="file"
                  accept=".csv,.tsv,.txt,.json,.md"
                  multiple
                  disabled={busy || conversionBusy}
                  onChange={(event) => pick(event.target.files)}
                />
                <span className="drop-icon" aria-hidden="true">↥</span>
                <span><b>Drop your dataset here</b><small>or browse files</small></span>
              </label>

              <p className="intake-copy">
                AI-assisted identification can determine which of the eight PS1 tables
                each inaccurately named file belongs to. You will review the proposed
                table mapping before any conversion.
              </p>

              {files.size > 0 && (
                <>
                  <div className="recognition-progress">
                    <h2>Analysing dataset</h2>
                    <div className="recognised-count-track">
                      <span className={`recognised-count ${countAnimating ? "animating" : ""}`} aria-live="polite" role="status">
                        {recognisedCount}
                      </span>
                    </div>
                    <p className="identified-tables-text">identified tables</p>
                    <div className="table-statuses" role="list" aria-label="Table recognition statuses">
                      {EXPECTED.map((name) => (
                        <div className={files.has(name) ? "manifest-row loaded" : "manifest-row"} key={name} role="listitem">
                          <span>{name}</span>
                          <b>{files.has(name) ? "RECOGNISED" : "PENDING"}</b>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="selected-files" role="list" aria-label="Selected files">
                    {selectedFiles.map((file) => {
                      const canonical = EXPECTED.some((name) => name === file.name);
                      return (
                      <div className={canonical ? "file-row" : "file-row conversion"} key={file.name} role="listitem">
                        <span className="file-name">{file.name}</span>
                        <span className="file-size">{formatBytes(file.size)}</span>
                        <span className="file-type-badge">{getFileExtension(file.name)}</span>
                        <span className={canonical ? "file-status ready" : "file-status ai"}>
                          {canonical ? "Ready" : "AI identification"}
                        </span>
                        <button
                          className="file-remove"
                          aria-label={`Remove ${file.name}`}
                          onClick={() => removeSelectedFile(file.name)}
                          disabled={busy || conversionBusy}
                        >
                          <span aria-hidden="true">×</span>
                        </button>
                      </div>
                      );
                    })}
                  </div>
                </>
              )}

              {complete && conversionSettled && (
                <>
                  <div className="processing-controls intake-budget">
                    <label>
                      Optimisation time per policy
                      <input
                        aria-label="Optimisation time per policy"
                        type="number"
                        value={budget}
                        min={1}
                        max={60}
                        disabled={busy || conversionBusy}
                        onChange={(event) => setBudget(Math.max(1, Math.min(60, Number(event.target.value) || 1)))}
                      />
                      <span>seconds</span>
                    </label>
                  </div>
                  <button
                    className="process-button next-button"
                    onClick={handleNext}
                    disabled={busy || conversionBusy || files.size !== EXPECTED.length}
                    data-process-label="Process dataset"
                  >
                    <span>Next</span>
                    <i>Switch to processing terminal</i>
                  </button>
                </>
              )}

              {error && <p className="notice bad" role="alert">{error}</p>}
            </div>

            {conversionSources.length > 0 && (
              <section className="conversion-section" aria-label="AI-assisted conversion">
                <div className="section-heading">
                  <div>
                    <p className="section-kicker">AI ASSISTANT</p>
                    <h2>AI-assisted conversion</h2>
                  </div>
                  <strong className="counter">{conversionSources.length}</strong>
                </div>

                <div className="conversion-disclosure">
                  <h3>Disclosure — what leaves your browser</h3>
                  <p>Provider: <span className="provider-badge">DeepSeek</span> <em>(fixed — cannot be changed)</em></p>
                  <p>The exact files and fields leaving the browser are listed here: {conversionSources.map((f) => f.name).join(", ")}</p>
                  <p>The complete text of each selected file is sent, including every header, field and row.</p>
                  <p>Supported text formats: CSV, TSV, JSON, TXT and Markdown. Opaque binary workbooks are not sent.</p>
                  <p>Your original files remain unchanged on disk. The AI produces only an untrusted draft that must be verified before it can replace any source.</p>
                  <p>You will review the proposed table mapping before accepting any conversion.</p>
                  <div className="conversion-files">
                    <h4>Source files to be sent</h4>
                    <ul className="conversion-file-list">
                      {conversionSources.map((file) => (
                        <li key={file.name}>
                          <span>{file.name}</span>
                          <span>{formatBytes(file.size)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {!conversionDraft && (
                  <div className="conversion-settings">
                    <label>
                      Temporary session-only provider key
                      <input
                        type="password"
                        value={conversionKey}
                        onChange={(event) => setConversionKey(event.target.value)}
                        placeholder="Enter session key — never stored"
                        disabled={conversionBusy}
                        aria-label="Temporary session-only provider key"
                      />
                    </label>
                    <div className="conversion-consent-row">
                      <input
                        type="checkbox"
                        id="conversion-consent"
                        checked={conversionConsent}
                        onChange={(event) => setConversionConsent(event.target.checked)}
                        disabled={conversionBusy}
                      />
                      <label htmlFor="conversion-consent" style={{ cursor: conversionBusy ? "not-allowed" : "pointer" }}>
                        I explicitly consent to sending the above files to DeepSeek for AI conversion
                      </label>
                    </div>
                    <button
                      className="conversion-button"
                      onClick={createConversionDraft}
                      disabled={conversionBusy || !conversionConsent || !conversionKey.trim() || !conversionSources.length}
                    >
                      {conversionBusy ? "Creating draft…" : "Create conversion draft"}
                    </button>
                    <button
                      className="conversion-secondary-button"
                      onClick={clearConversion}
                      disabled={conversionBusy}
                    >
                      Continue without AI
                    </button>
                  </div>
                )}

                {conversionError && (
                  <p className="notice bad" role="alert">{conversionError}</p>
                )}

                {conversionDraft && (
                  <div className="conversion-draft-review">
                    <h2>Review AI conversion draft</h2>
                    <div className="conversion-draft-meta">
                      <span><strong>Provider</strong>{conversionDraft.provider}</span>
                      <span><strong>Model</strong>{conversionDraft.model}</span>
                      <span><strong>Draft ID</strong>{conversionDraft.draft_id}</span>
                    </div>
                    <p>The draft is <em>untrusted</em> and must be reviewed, edited, and validated before acceptance.</p>

                    <div className="conversion-table-selector">
                      {EXPECTED.map((tableName) => (
                        <button
                          key={tableName}
                          className={selectedDraftFile === tableName ? "active" : ""}
                          onClick={() => setSelectedDraftFile(tableName)}
                        >
                          {tableName}
                        </button>
                      ))}
                    </div>

                    <textarea
                      className="conversion-textarea"
                      value={conversionDraft.tables[selectedDraftFile] || ""}
                      onChange={(event) => updateDraftTable(selectedDraftFile, event.target.value)}
                      disabled={conversionBusy}
                      aria-label={`Edit ${selectedDraftFile} CSV content`}
                    />

                    <div className="conversion-provenance">
                      <h3>Mapping provenance</h3>
                      {conversionDraft.mappings.length > 0 ? (
                        <table className="conversion-mapping-table">
                          <thead>
                            <tr>
                              <th>Source file</th>
                              <th>Source ref</th>
                              <th>Target file</th>
                              <th>Target field</th>
                              <th>Confidence</th>
                              <th>Note</th>
                            </tr>
                          </thead>
                          <tbody>
                            {conversionDraft.mappings.map((mapping, index) => (
                              <tr key={index}>
                                <td>{mapping.source_file || "—"}</td>
                                <td>{mapping.source_ref || "—"}</td>
                                <td>{mapping.target_file || "—"}</td>
                                <td>{mapping.target_field || "—"}</td>
                                <td>{mapping.confidence || "—"}</td>
                                <td>{mapping.note || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p>No mapping provenance available.</p>
                      )}
                    </div>

                    {conversionDraft.uncertainties.length > 0 && (
                      <div className="conversion-uncertainty-list">
                        <h3>Uncertainty list</h3>
                        <ul>
                          {conversionDraft.uncertainties.map((u, index) => (
                            <li key={index}>
                              {u.source_file && <code>{u.source_file}</code>} →{" "}
                              {u.target_file && <code>{u.target_file}</code>}: {u.reason || u.target_field || "Uncertain value"}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {draftGate && draftGate.errors.length > 0 && (
                      <div className="conversion-error-list">
                        <h3>Deterministic schema errors</h3>
                        <ul>
                          {draftGate.errors.map((err, index) => (
                            <li key={index}>
                              [{err.code}] {err.file ? `${err.file}: ` : ""}{err.field ? `${err.field}: ` : ""}{err.detail}
                            </li>
                          ))}
                        </ul>
                        <p className="notice bad conversion-error-notice" role="alert">
                          Deterministic gate failed · {draftGate.errors.length} error(s) · Process dataset remains disabled
                        </p>
                      </div>
                    )}

                    {draftGate?.passed && (
                      <p className="notice good" role="status">Deterministic schema gate passed.</p>
                    )}

                    <div className="conversion-review-controls">
                      <button
                        className="conversion-validation-button"
                        onClick={validateDraft}
                        disabled={conversionBusy}
                      >
                        Validate edited draft
                      </button>
                      <div className="conversion-consent-row">
                        <input
                          type="checkbox"
                          id="draft-reviewed"
                          checked={draftReviewed}
                          onChange={(event) => setDraftReviewed(event.target.checked)}
                          disabled={conversionBusy}
                        />
                        <label htmlFor="draft-reviewed" style={{ cursor: conversionBusy ? "not-allowed" : "pointer" }}>
                          I have reviewed the draft and its edits
                        </label>
                      </div>
                      <button
                        className="conversion-accept-button"
                        onClick={acceptDraft}
                        disabled={!canAcceptDraft(Boolean(draftGate?.passed), draftReviewed) || conversionBusy}
                      >
                        Accept checked draft
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </section>
        )}

        {screen === "processing" && (
          <section className="processing-screen">
            <div className="processing-controls">
              <label>
                Optimisation time per policy
                <input
                  aria-label="Optimisation time per policy"
                  type="number"
                  value={budget}
                  min={1}
                  max={60}
                  disabled={busy || conversionBusy}
                  onChange={(event) => setBudget(Math.max(1, Math.min(60, Number(event.target.value) || 1)))}
                />
                <span>seconds</span>
              </label>
            </div>
            <aside className="terminal-card">
              <div className="terminal-head">
                <div><span /><span /><span /></div>
                <b>Pipeline terminal</b>
                <em>{busy ? "LIVE" : "LOCAL"}</em>
              </div>
              <div className="terminal" role="log" aria-live="polite" aria-label="Pipeline terminal output">
                {logs.map((line, index) => (
                  <div key={`${index}-${line}`} className={line.includes("STOP") ? "terminal-error" : ""}>
                    <span>{String(index + 1).padStart(2, "0")}</span>{line}
                  </div>
                ))}
                {busy && <div className="cursor-line"><span>››</span><i /></div>}
              </div>
              <p>Visible execution trace only. The independent validator—not this display—decides feasibility.</p>
            </aside>
            {finished && !busy && (
              <button
                className="process-button see-results-button"
                onClick={() => setScreen("results")}
              >
                <span>See results</span>
                <i>View planning workspace and policy outputs</i>
              </button>
            )}
            {error && !busy && !finished && (
              <button className="text-button processing-back" onClick={() => setScreen("intake")}>
                Return to dataset intake
              </button>
            )}
          </section>
        )}

        {screen === "results" && (
          <section className="results-screen">
            <PlanningWorkspace
              model={planningModel}
              results={results}
              selectedPolicy={selectedPolicy}
              setSelectedPolicy={setSelectedPolicy}
              policyErrors={policyErrors}
              selectedActivity={selectedActivity}
              setSelectedActivity={setSelectedActivity}
              viewMode={viewMode}
              setViewMode={setViewMode}
            />
            <div className="result-grid">
              {PROCESS_POLICIES.map((policy) => {
                const result = results[policy];
                const policyError = policyErrors[policy];
                if (policyError) return (
                  <article className="result-card" key={policy}>
                    <div className="result-title">
                      <span>POLICY {policy}</span><b className="status fail">FAILED</b>
                    </div>
                    <h3>{POLICY_LABELS[policy]}</h3>
                    <p className="notice bad" role="alert">{policyError}</p>
                  </article>
                );
                if (!result) return (
                  <div className="result-card pending" key={policy}>
                    <span>POLICY {policy}</span><h3>Processing…</h3>
                  </div>
                );
                const { report } = result;
                return (
                  <article className="result-card" key={policy}>
                    <div className="result-title">
                      <span>POLICY {policy}</span>
                      <b className={report.feasible ? "status pass" : "status fail"}>
                        {report.feasible ? "VALID" : "BLOCKED"}
                      </b>
                    </div>
                    <h3>{POLICY_LABELS[policy]}</h3>
                    <p>{report.feasible
                      ? "Independent validator: 0 hard violations"
                      : `${report.hard_violations.length} hard violation(s)`}</p>
                    <dl>
                      {Object.entries(report.soft_scores)
                        .filter(([, value]) => typeof value !== "object")
                        .slice(0, 4)
                        .map(([key, value]) => (
                          <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{String(value)}</dd></div>
                        ))}
                    </dl>
                    {report.feasible ? (
                      <div className="export-row">
                        <button aria-label={`Download Policy ${policy} access CSV`} onClick={() => download(`SCHEDULE_ACCESS_${policy}.csv`, result.files["SCHEDULE_ACCESS.csv"])}>Access</button>
                        <button aria-label={`Download Policy ${policy} occupancy CSV`} onClick={() => download(`SCHEDULE_OCCUPANCY_${policy}.csv`, result.files["SCHEDULE_OCCUPANCY.csv"])}>Occupancy</button>
                        <button aria-label={`Download Policy ${policy} results CSV`} onClick={() => download(`RESULTS_${policy}.csv`, result.files["RESULTS.csv"])}>Results</button>
                      </div>
                    ) : (
                      <p className="notice bad">Export blocked by validator.</p>
                    )}
                    {report.feasible && (
                      <button className="text-button" disabled={busy || conversionBusy} onClick={() => {
                        setReplanPolicy(policy);
                        setReplanResult(null);
                        setReplanFiles(null);
                      }}>
                        Use this result for disruption replan →
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
            {replanPolicy && (
              <section className="replan-card">
                <div>
                  <p className="section-kicker">CONTROLLED REPLAN · POLICY {replanPolicy}</p>
                  <h2>Apply one deterministic disruption</h2>
                  <p>Accepted examples: <code>block A001 in week 12</code> or <code>delay A001 by 2 weeks</code>.</p>
                </div>
                <div className="command-row">
                  <input aria-label="Disruption command" value={disruption} disabled={busy || conversionBusy} onChange={(event) => setDisruption(event.target.value)} />
                  <button onClick={replan} disabled={busy || conversionBusy || !disruption.trim()}>{busy ? "Working…" : "Replan + validate"}</button>
                </div>
                {replanResult && (
                  <div className="replan-output">
                    <p className={replanResult.validator_gate.passed ? "notice good" : "notice bad"}>
                      {replanResult.validator_gate.passed ? "Validator gate passed" : "Validator gate failed · export blocked"}
                    </p>
                    <p>{replanResult.explanation}</p>
                    {replanResult.changes.length > 0 && (
                      <div className="replan-details">
                        <h3>Schedule changes</h3>
                        <ul>{replanResult.changes.map((change) => (
                          <li key={change.activity_id}><code>{change.activity_id}</code>: {change.before_weeks.join(", ")} → {change.after_weeks.join(", ")}</li>
                        ))}</ul>
                      </div>
                    )}
                    {replanResult.validator_gate.soft_warnings.length > 0 && (
                      <div className="replan-details warning-list">
                        <h3>Validator warnings</h3>
                        <ul>{replanResult.validator_gate.soft_warnings.map((warning, index) => (
                          <li key={`${warning.rule}-${index}`}><code>{warning.rule}</code>: {warning.detail}</li>
                        ))}</ul>
                      </div>
                    )}
                    {replanResult.validator_gate.hard_violations.length > 0 && (
                      <div className="replan-details violation-list">
                        <h3>Hard violations</h3>
                        <ul>{replanResult.validator_gate.hard_violations.map((violation, index) => (
                          <li key={`${violation.rule}-${index}`}><code>{violation.rule}</code>: {violation.detail}</li>
                        ))}</ul>
                      </div>
                    )}
                    {replanResult.validator_gate.passed && replanFiles && (
                      <div className="export-row">
                        <button aria-label={`Download Policy ${replanPolicy} replan access CSV`} onClick={() => download(`REPLAN_ACCESS_${replanPolicy}.csv`, replanFiles["SCHEDULE_ACCESS.csv"])}>Access</button>
                        <button aria-label={`Download Policy ${replanPolicy} replan occupancy CSV`} onClick={() => download(`REPLAN_OCCUPANCY_${replanPolicy}.csv`, replanFiles["SCHEDULE_OCCUPANCY.csv"])}>Occupancy</button>
                        <button aria-label={`Download Policy ${replanPolicy} replan results CSV`} onClick={() => download(`REPLAN_RESULTS_${replanPolicy}.csv`, replanFiles["RESULTS.csv"])}>Results</button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}
            <button className="text-button" onClick={() => setScreen("intake")}>
              Return to dataset intake
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

function PlanningWorkspace({
  model,
  results,
  selectedPolicy,
  setSelectedPolicy,
  policyErrors,
  selectedActivity,
  setSelectedActivity,
  viewMode,
  setViewMode,
}: {
  model: ReturnType<typeof buildPlanningModel> | null;
  results: Partial<Record<Policy, SolveResult>>;
  selectedPolicy: Policy | null;
  setSelectedPolicy: (policy: Policy) => void;
  policyErrors: Partial<Record<Policy, string>>;
  selectedActivity: string | null;
  setSelectedActivity: (a: string | null) => void;
  viewMode: "night" | "month" | "full";
  setViewMode: (v: "night" | "month" | "full") => void;
}) {
  const horizonStart = model?.horizonStart || "2027-01-04";
  const horizonWeeks = model?.horizonWeeks || 30;
  const bestPolicy = selectBestPolicy(results) as Policy | null;
  const selectedResult = selectedPolicy ? results[selectedPolicy] : null;
  const objectiveScore = selectedResult?.report?.soft_scores?.objective_score;
  const activities = model?.activities.filter((activity) => activity.accesses.length > 0) || [];
  const activeActivity = activities.find((activity) => activity.activity_id === selectedActivity) || null;
  const activeLocations = activeActivity?.occupiedLocations || [];
  const weekWidth = viewMode === "night" ? 66 : viewMode === "month" ? 40 : 25;
  const labelWidth = 210;
  const chartWidth = labelWidth + horizonWeeks * weekWidth + 24;
  const chartHeight = Math.max(260, 72 + activities.length * 34);
  const weekLabelStep = viewMode === "night" ? 1 : viewMode === "month" ? 2 : 4;

  function sectorIsActive(sectorId: string) {
    return activeLocations.some((location) =>
      location === sectorId || location.startsWith(`${sectorId}:`),
    );
  }

  function stationIsActive(lineCode: string, stationId: string) {
    const prefix = `PLAT:${lineCode}:${stationId}:`;
    return activeLocations.some((location) => location === prefix.slice(0, -1) || location.startsWith(prefix));
  }

  return (
    <div className="planning-workspace">
      <div className="planning-header">
        <div>
          <p className="section-kicker">PLANNING WORKSPACE</p>
          <h2>Planning Workspace</h2>
          <p className="topology-note">Railway topology is schematic, not geographic.</p>
        </div>
        <div className="view-controls">
          <button aria-pressed={viewMode === "night"} className={viewMode === "night" ? "active" : ""} onClick={() => setViewMode("night")}>Night detail</button>
          <button aria-pressed={viewMode === "month"} className={viewMode === "month" ? "active" : ""} onClick={() => setViewMode("month")}>Month window</button>
          <button aria-pressed={viewMode === "full"} className={viewMode === "full" ? "active" : ""} onClick={() => setViewMode("full")}>Full horizon</button>
        </div>
      </div>

      <div className="planning-policy-bar" aria-label="Planning policy">
        <div>
          <span>Schedule policy</span>
          <div className="policy-switcher">
            {PROCESS_POLICIES.map((policy) => (
              <button
                key={policy}
                className={selectedPolicy === policy ? "active" : ""}
                aria-pressed={selectedPolicy === policy}
                disabled={!results[policy] || Boolean(policyErrors[policy])}
                onClick={() => {
                  setSelectedPolicy(policy);
                  setSelectedActivity(null);
                }}
              >
                {policy}
                {bestPolicy === policy && <small>best</small>}
              </button>
            ))}
          </div>
        </div>
        <div className="planning-telemetry">
          <p>Viewing policy {selectedPolicy || "—"} · objective_score={objectiveScore === undefined ? "—" : String(objectiveScore)}</p>
          <p>{formatWeekStart(horizonStart, 1)} — {formatWeekStart(horizonStart, horizonWeeks)} · {horizonWeeks} weeks</p>
        </div>
      </div>

      <div className="gantt-section">
          <div className="planning-section-heading">
            <div>
              <h3>Schedule Gantt</h3>
              <p>Each dot is one day of scheduled work; only weeks containing accesses are highlighted.</p>
            </div>
            <span>{activities.length} scheduled activities</span>
          </div>
        <div className="gantt-container" role="region" aria-label="Scrollable activity Gantt chart" tabIndex={0}>
          <svg
            className="gantt-svg"
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            style={{ minWidth: `${chartWidth}px`, height: `${chartHeight}px` }}
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect width={chartWidth} height={chartHeight} rx="18" fill="#f7fbfa" />
            <g className="gantt-grid">
              {Array.from({ length: horizonWeeks }, (_, i) => {
                const x = labelWidth + i * weekWidth;
                const label = formatWeekStart(horizonStart, i + 1);
                return (
                  <g key={i} className="gantt-week">
                    <line x1={x} y1={54} x2={x} y2={chartHeight - 12} stroke="#dce9e6" strokeWidth="1" />
                    {i % weekLabelStep === 0 && (
                      <text x={x + 5} y={34} fontSize="10" fill="#55716d">
                        W{i + 1} · {label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
            <g className="gantt-activities">
              {activities.map((activity, index) => {
                const y = 66 + index * 34;
                const isSelected = selectedActivity === activity.activity_id;
                const workWeeks = new Set(activity.accesses.map((access) => access.week));
                return (
                  <g key={activity.activity_id} className="gantt-bar"
                    onClick={() => setSelectedActivity(activity.activity_id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedActivity(activity.activity_id); } }}
                    tabIndex={0}
                    role="button"
                    aria-label={`${activity.activity_id}, ${activity.accesses.length} scheduled accesses`}
                    style={{ cursor: "pointer" }}>
                    <text x="18" y={y + 15} fontSize="11" fill="#163b38" fontWeight="700">
                      {activity.activity_id} · {activity.activity_type}
                    </text>
                    {Array.from(workWeeks).map((week) => (
                      <rect
                        key={week}
                        x={labelWidth + (week - 1) * weekWidth + 4}
                        y={y}
                        width={Math.max(weekWidth - 8, 12)}
                        height="20"
                        rx="10"
                        fill={isSelected ? "#ffd76a" : "#d6eeea"}
                        stroke={isSelected ? "#d35f47" : "#79b8ae"}
                        strokeWidth={isSelected ? 2 : 1}
                      />
                    ))}
                    {activity.accesses.map((access) => {
                      const accessX = labelWidth + (access.week - 1) * weekWidth + weekWidth / 2;
                      const dotTitle = `Access ${access.access_seq} · W/C ${formatWeekStart(horizonStart, access.week)} · access night ${access.access_night}${access.eclo ? " · ECLO (1.5× yield)" : ""}`;
                      if (!access.eclo) {
                        return (
                          <circle key={access.access_seq} cx={accessX} cy={y + 10} r={4} fill="#08736d">
                            <title>{dotTitle}</title>
                          </circle>
                        );
                      }
                      const halfX = accessX + 7;
                      return (
                        <g key={access.access_seq}>
                          <circle cx={accessX} cy={y + 10} r={4} fill="#ec765e">
                            <title>{dotTitle}</title>
                          </circle>
                          <path
                            d={`M ${halfX} ${y + 6} A 4 4 0 0 0 ${halfX} ${y + 14} Z`}
                            fill="#ec765e"
                            stroke="#b83e2b"
                            strokeWidth={1}
                          >
                            <title>{dotTitle}</title>
                          </path>
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      </div>

      <div className="railway-schematic">
        <div className="planning-section-heading">
          <div>
            <h3>Railway schematic</h3>
            <p>Topology is schematic, not geographic. Selected occupancy is highlighted in coral.</p>
          </div>
          <span>{model?.lines.length || 0} lines</span>
        </div>
        <div className="railway-canvas" role="region" aria-label="Railway line and station topology" tabIndex={0}>
          <svg
            className="railway-svg"
            viewBox={`0 0 940 ${Math.max(220, (model?.lines.length || 1) * 150 + 40)}`}
            xmlns="http://www.w3.org/2000/svg"
          >
            {model?.lines.map((line, lineIndex) => {
              const y = 80 + lineIndex * 150;
              const span = 760;
              const stationGap = line.stations.length > 1 ? span / (line.stations.length - 1) : 0;
              const stationX = new Map(line.stations.map((station, index) => [station.station_id, 140 + index * stationGap]));
              return (
                <g key={line.line_code}>
                  <text x="24" y={y - 18} fontSize="12" fill="#163b38" fontWeight="700">
                    {line.line_code} · {line.line_name}
                  </text>
                  {line.sectors.map((sector) => {
                    const fromX = stationX.get(sector.from_station_id) || 140;
                    const toX = stationX.get(sector.to_station_id) || fromX;
                    const active = sectorIsActive(sector.sector_id);
                    return (
                      <line
                        key={sector.sector_id}
                        x1={fromX}
                        y1={y}
                        x2={toX}
                        y2={y}
                        stroke={active ? "#ec765e" : sector.is_shared ? "#efb81e" : "#78ada6"}
                        strokeWidth={active ? 10 : 6}
                        strokeLinecap="round"
                      >
                        <title>{sector.sector_id}{sector.is_shared ? " · shared sector" : ""}</title>
                      </line>
                    );
                  })}
                  {line.stations.map((station, stationIndex) => {
                    const x = 140 + stationIndex * stationGap;
                    const active = stationIsActive(line.line_code, station.station_id);
                    return (
                      <g key={station.station_id}>
                        <circle
                          cx={x}
                          cy={y}
                          r={station.is_interchange ? 10 : 7}
                          fill={active ? "#ec765e" : "#f7fbfa"}
                          stroke={active ? "#b83e2b" : "#08736d"}
                          strokeWidth={station.is_interchange ? 4 : 3}
                        />
                        <text x={x} y={y + 26} fontSize="10" fill="#365d58" textAnchor="middle">
                          {station.station_id}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
        <div className="railway-details">
          {activeActivity ? (
            <div className="sector-highlight">
              <p className="section-kicker">SELECTED ACTIVITY</p>
              <h4>{activeActivity.activity_id} · {activeActivity.activity_type}</h4>
              <p>Weeks {activeActivity.startWeek}–{activeActivity.endWeek} · {activeActivity.accesses.length} accesses</p>
              <div className="location-chips">
                {activeActivity.occupiedLocations.map((location) => <code key={location}>{location}</code>)}
              </div>
            </div>
          ) : (
            <p className="empty-selection">Select an activity in the Gantt to highlight its occupied sectors and platforms.</p>
          )}
          <p className="ordinal-note">Access night is an ordinal supplied by the schedule; Project TAO does not invent an exact calendar night.</p>
        </div>
      </div>
    </div>
  );
}
