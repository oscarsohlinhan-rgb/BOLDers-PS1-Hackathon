"use client";
import "./globals.css";
import { useState } from "react";

const EXPECTED = [
  "01_LINES.csv", "02_STATIONS.csv", "03_SECTORS.csv",
  "04_LOCATION_SUPPLY.csv", "05_BUFFER_LOCATION.csv",
  "06_PARAMETERS.csv", "07_PROJECT_DETAILS.csv", "08_ACTIVITY_DETAILS.csv",
];
const RAW =
  "https://raw.githubusercontent.com/aochinwen/NebulaX-Hackathon-ProblemStatement/main/PS1/01_data/";

type Report = {
  scenario: string;
  feasible: boolean;
  hard_violations: { rule: string; severity: string; detail: string }[];
  soft_scores: Record<string, unknown>;
  detail: { capacity_hotspots: string[]; nights_scheduled: number; eclo_nights: number };
};

type ReplanResult = {
  status: string;
  explanation: string;
  locked_activity_count: number;
  affected_activity_ids?: string[];
  changes: { activity_id: string; before_weeks: number[]; after_weeks: number[] }[];
  validator_gate: {
    passed: boolean;
    hard_violations: { rule: string; detail: string }[];
    soft_warnings: { rule: string; detail: string }[];
  };
  after_report: Report | null;
};

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Page() {
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [scenario, setScenario] = useState("A");
  const [budget, setBudget] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [out, setOut] = useState<Record<string, string> | null>(null);
  const [lastGood, setLastGood] = useState<{ report: Report; out: Record<string, string> } | null>(null);
  const [disruption, setDisruption] = useState("delay A001 by 1 week");
  const [replanResult, setReplanResult] = useState<ReplanResult | null>(null);
  const [replanFiles, setReplanFiles] = useState<Record<string, string> | null>(null);

  function pick(list: FileList | null) {
    if (!list) return;
    const m = new Map(files);
    for (const f of Array.from(list)) if (EXPECTED.includes(f.name)) m.set(f.name, f);
    setFiles(m);
  }

  async function loadSample() {
    setBusy(true); setError("");
    try {
      const m = new Map<string, File>();
      for (const n of EXPECTED) {
        const r = await fetch(RAW + n);
        if (!r.ok) throw new Error("fetch " + n);
        m.set(n, new File([await r.blob()], n, { type: "text/csv" }));
      }
      setFiles(m);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function solve() {
    const missing = EXPECTED.filter((n) => !files.has(n));
    if (missing.length) { setError("missing: " + missing.join(", ")); return; }
    setBusy(true); setError(""); setReplanResult(null); setReplanFiles(null);
    try {
      const fd = new FormData();
      fd.append("scenario", scenario);
      fd.append("time_budget", String(budget));
      for (const n of EXPECTED) fd.append("files", files.get(n)!);
      const r = await fetch("/api/solve", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "solve failed");
      setReport(d.report); setOut(d.files);
      if (d.report.feasible) setLastGood({ report: d.report, out: d.files });
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function replan() {
    const missing = EXPECTED.filter((n) => !files.has(n));
    if (missing.length) { setError("missing: " + missing.join(", ")); return; }
    setBusy(true); setError(""); setReplanResult(null); setReplanFiles(null);
    try {
      const fd = new FormData();
      fd.append("scenario", scenario);
      fd.append("time_budget", String(budget));
      fd.append("disruption", disruption);
      for (const n of EXPECTED) fd.append("files", files.get(n)!);
      const r = await fetch("/api/replan", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "replan failed");
      setReplanResult(d.replan); setReplanFiles(d.files);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  const show = report && out ? { report, out } : lastGood;
  const stale = lastGood && report && out && !report.feasible;

  return (
    <>
      <h1>PS1 Track Access Optimiser</h1>
      <p>Upload the 8 instance CSVs, pick a scenario, solve, validate, export. Deterministic greedy + independent hard validator.</p>

      <div className="card">
        <h3>1. Instance files ({files.size}/8)</h3>
        <input type="file" accept=".csv" multiple onChange={(e) => pick(e.target.files)} />
        <div><button className="ghost" onClick={loadSample} disabled={busy}>Load public sample dataset</button></div>
        <div className="mono">{EXPECTED.map((n) => `${files.has(n) ? "✓" : "○"} ${n}`).join("  ")}</div>
      </div>

      <div className="card">
        <h3>2. Scenario</h3>
        <div className="tabs">
          {["A", "B", "C"].map((s) => (
            <button key={s} className={scenario === s ? "on" : "ghost"} onClick={() => setScenario(s)}>{s}</button>
          ))}
        </div>
        <p className="mono">A: fixed supply, minimise overrun · B: zero overrun, minimise extra nights + ECLO · C: balanced (+1 excess/location-week soft)</p>
        <label>Solve budget (s): <input type="number" value={budget} min={1} max={60} onChange={(e) => setBudget(Number(e.target.value))} /></label>
        <div style={{ marginTop: 8 }}><button onClick={solve} disabled={busy || files.size !== 8}>{busy ? "Solving…" : "Solve + validate"}</button></div>
        {error && <p className="badge-bad">{error}</p>}
      </div>

      {show && (
        <div className="card">
          <h3>3. Result {stale && "(last feasible kept — latest run infeasible)"}</h3>
          <p className={show.report.feasible ? "badge-ok" : "badge-bad"}>
            {show.report.feasible ? "FEASIBLE · 0 hard violations" : `INFEASIBLE · ${show.report.hard_violations.length} violations (export blocked)`}
          </p>
          <table><tbody>
            {Object.entries(show.report.soft_scores).filter(([, v]) => typeof v !== "object").map(([k, v]) => (
              <tr key={k}><td className="mono">{k}</td><td className="mono">{String(v)}</td></tr>
            ))}
          </tbody></table>
          {show.report.hard_violations.length > 0 && (
            <table><tbody>
              {show.report.hard_violations.slice(0, 20).map((v, i) => (
                <tr key={i}><td className="mono">{v.rule}</td><td>{v.detail}</td></tr>
              ))}
            </tbody></table>
          )}
          <div style={{ marginTop: 8 }}>
            {show.report.feasible ? (
              <>
                <button onClick={() => download(`SCHEDULE_ACCESS_${show.report.scenario}.csv`, show.out["SCHEDULE_ACCESS.csv"])}>ACCESS</button>
                <button onClick={() => download(`SCHEDULE_OCCUPANCY_${show.report.scenario}.csv`, show.out["SCHEDULE_OCCUPANCY.csv"])}>OCCUPANCY</button>
                <button onClick={() => download(`RESULTS_${show.report.scenario}.csv`, show.out["RESULTS.csv"])}>RESULTS</button>
              </>
            ) : <span className="mono">Debug export disabled in judge build — fix violations first.</span>}
          </div>
          {show.report.detail.capacity_hotspots.length > 0 && (
            <p className="mono">Hotspots: {show.report.detail.capacity_hotspots.slice(0, 8).join(", ")}</p>
          )}
        </div>
      )}

      <div className="card">
        <h3>4. Deterministic disruption replan</h3>
        <p>Accepted commands are deliberately narrow: <span className="mono">block A001 in week 12</span> or <span className="mono">delay A001 by 2 weeks</span>.</p>
        <div className="command-row">
          <input aria-label="Disruption command" value={disruption} onChange={(e) => setDisruption(e.target.value)} />
          <button onClick={replan} disabled={busy || files.size !== 8 || !disruption.trim()}>{busy ? "Working…" : "Replan + validate"}</button>
        </div>
        <p className="mono">Deterministic parser → minimal-churn repair → independent validator. No model decides feasibility.</p>
        {replanResult && (
          <div className="replan-result">
            <p className={replanResult.validator_gate.passed ? "badge-ok" : "badge-bad"}>
              {replanResult.validator_gate.passed ? "VALIDATOR GATE PASSED" : "VALIDATOR GATE FAILED · EXPORT BLOCKED"}
            </p>
            <p>{replanResult.explanation}</p>
            {replanResult.validator_gate.soft_warnings.length > 0 && (
              <p className="badge-warn">Reference-risk warning: {replanResult.validator_gate.soft_warnings.length} buffer overlaps remain under the disputed public rule wording.</p>
            )}
            {replanResult.changes.length > 0 && (
              <table><thead><tr><th>Activity</th><th>Before</th><th>After</th></tr></thead><tbody>
                {replanResult.changes.map((c) => (
                  <tr key={c.activity_id}><td className="mono">{c.activity_id}</td><td className="mono">{c.before_weeks.join(", ")}</td><td className="mono">{c.after_weeks.join(", ")}</td></tr>
                ))}
              </tbody></table>
            )}
            {replanResult.validator_gate.hard_violations.length > 0 && (
              <ul>{replanResult.validator_gate.hard_violations.slice(0, 8).map((v, i) => <li key={i}><span className="mono">{v.rule}</span>: {v.detail}</li>)}</ul>
            )}
            {replanResult.validator_gate.passed && replanFiles && (
              <div>
                <button onClick={() => download(`REPLAN_ACCESS_${scenario}.csv`, replanFiles["SCHEDULE_ACCESS.csv"])}>REPLAN ACCESS</button>
                <button onClick={() => download(`REPLAN_OCCUPANCY_${scenario}.csv`, replanFiles["SCHEDULE_OCCUPANCY.csv"])}>REPLAN OCCUPANCY</button>
                <button onClick={() => download(`REPLAN_RESULTS_${scenario}.csv`, replanFiles["RESULTS.csv"])}>REPLAN RESULTS</button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
