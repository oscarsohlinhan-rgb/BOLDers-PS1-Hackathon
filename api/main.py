"""PS1 FastAPI service: upload 8 CSVs -> solve -> validate -> export."""
from __future__ import annotations

import csv
import io
import json
import os
import tempfile
from typing import Any, Dict

from fastapi import Body, FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

from api import exporter as E
from api import replanner as R
from api import solver as S
from api import validator as V
from api.ai_converter import convert_source_bundle
from api.ai_explainer import explain_evidence
from api.model import load_instance
from api.pipeline import run_solve_pipeline, validate_csv_bundle

app = FastAPI(title="PS1 Track Access Optimiser")

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024
MAX_CONVERSION_FILE_BYTES = 512 * 1024
MAX_CONVERSION_TOTAL_BYTES = 1024 * 1024
MAX_CONVERSION_FILES = 16
CONVERSION_EXTENSIONS = {".csv", ".tsv", ".txt", ".json", ".md"}


def _csv_text(rows) -> str:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue()


async def _read_bundle(files: list[UploadFile]) -> Dict[str, str]:
    bundle: Dict[str, str] = {}
    total = 0
    for upload in files:
        name = os.path.basename(upload.filename or "")
        if name in bundle:
            raise ValueError("duplicate file: %s" % name)
        raw = await upload.read()
        total += len(raw)
        if len(raw) > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
            raise ValueError("uploaded CSV bundle is too large")
        try:
            bundle[name] = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError("%s is not valid UTF-8 CSV" % name) from exc
    return bundle


async def _read_conversion_sources(files: list[UploadFile]) -> Dict[str, str]:
    if not files:
        raise ValueError("at least one source file is required")
    if len(files) > MAX_CONVERSION_FILES:
        raise ValueError("too many source files for one AI conversion")
    sources: Dict[str, str] = {}
    total = 0
    for upload in files:
        name = os.path.basename(upload.filename or "")
        extension = os.path.splitext(name)[1].lower()
        if not name or extension not in CONVERSION_EXTENSIONS:
            allowed = ", ".join(sorted(CONVERSION_EXTENSIONS))
            raise ValueError(
                f"{name or 'unnamed file'} is not a supported text source; "
                f"use {allowed}")
        if name in sources:
            raise ValueError(f"duplicate source file: {name}")
        raw = await upload.read()
        total += len(raw)
        if (len(raw) > MAX_CONVERSION_FILE_BYTES or
                total > MAX_CONVERSION_TOTAL_BYTES):
            raise ValueError("source files are too large for AI conversion")
        if b"\x00" in raw:
            raise ValueError(f"{name} appears to be binary and is not supported")
        try:
            sources[name] = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError(
                f"{name} must be UTF-8 text for AI conversion") from exc
    return sources


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/validate")
async def validate_files(files: list[UploadFile] = File(...)):
    """Run only the deterministic schema gate. No solver or AI is called."""
    try:
        bundle = await _read_bundle(files)
    except ValueError as exc:
        return JSONResponse({"passed": False, "errors": [
            {"code": "upload_error", "detail": str(exc)}]}, status_code=400)
    result = validate_csv_bundle(bundle)
    return JSONResponse(result, status_code=200 if result["passed"] else 400)


@app.post("/solve")
async def solve(scenario: str = Form("A"),
                time_budget: float = Form(8.0),
                files: list[UploadFile] = File(...)):
    try:
        bundle = await _read_bundle(files)
    except ValueError as exc:
        return JSONResponse({"status": "rejected_input", "files": {},
                             "error": {"code": "upload_error",
                                       "detail": str(exc)}}, status_code=400)
    result = run_solve_pipeline(bundle, scenario, time_budget)
    return JSONResponse(
        result, status_code=400 if result["status"] == "rejected_input" else 200)


@app.post("/ai/explain")
def ai_explain(payload: Dict[str, Any] = Body(...)):
    """Explain checked evidence locally or with consented Vertex Gemini."""
    allowed = {"evidence_id", "errors", "hard_violations", "soft_warnings",
               "status", "scenario"}
    evidence = {key: payload[key] for key in allowed if key in payload}
    if len(json.dumps(evidence, default=str)) > 20000:
        return JSONResponse({"error": "evidence payload is too large"},
                            status_code=413)
    return explain_evidence(evidence, use_ai=payload.get("consent") is True)


@app.post("/ai/convert")
async def ai_convert(
    files: list[UploadFile] = File(...),
    provider: str = Form("gemini-vertex"),
    consent: bool = Form(False),
):
    """Create an untrusted canonical draft from consented text sources."""
    if not consent:
        return JSONResponse(
            {"error": "explicit consent is required before sending source data"},
            status_code=400,
        )
    try:
        sources = await _read_conversion_sources(files)
        result = convert_source_bundle(
            sources,
            provider=provider,
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except ConnectionError as exc:
        return JSONResponse(
            {"error": "AI provider unavailable", "detail": str(exc)},
            status_code=502,
        )
    return result


@app.post("/replan")
async def replan(disruption: str = Form(...),
                 scenario: str = Form("A"),
                 time_budget: float = Form(8.0),
                 files: list[UploadFile] = File(...)):
    """Solve a baseline, apply one narrow disruption, validate, then export."""
    if scenario not in ("A", "B", "C"):
        return JSONResponse({"error": "scenario must be A, B or C"},
                            status_code=400)
    try:
        got = await _read_bundle(files)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    schema = validate_csv_bundle(got)
    if not schema["passed"]:
        return JSONResponse({"status": "rejected_input",
                             "schema_gate": schema, "files": None},
                            status_code=400)
    with tempfile.TemporaryDirectory() as tmp:
        for name, text in got.items():
            with open(os.path.join(tmp, os.path.basename(name)), "w",
                      encoding="utf-8") as fh:
                fh.write(text)
        try:
            inst = load_instance(tmp)
            baseline_accesses, baseline_groups = S.solve(
                inst, scenario,
                time_budget=max(1.0, min(60.0, time_budget)))
            result, accesses, groups = R.replan(
                inst, scenario, baseline_accesses, baseline_groups,
                disruption)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        payload = {"schema_gate": schema, "replan": result, "files": None}
        if result["validator_gate"]["passed"]:
            a_rows, o_rows, r_rows, _scores = E.build_outputs(
                inst, accesses, groups, scenario)
            payload["files"] = {
                "SCHEDULE_ACCESS.csv": _csv_text(a_rows),
                "SCHEDULE_OCCUPANCY.csv": _csv_text(o_rows),
                "RESULTS.csv": _csv_text(r_rows),
            }
        return payload


@app.post("/plan-days")
async def plan_days(strategy: str = Form("spread"),
                    fixed: str = Form("{}"),
                    files: list[UploadFile] = File(...)):
    """Suggest weekdays per scheduled night in the solver's own engine.

    Advisory only: preferred weekdays are a planning overlay. They are
    never validated, never scored, and never written into canonical or
    submission files. User fixed picks are always preserved.
    """
    from api import dayplan as D
    try:
        bundle = await _read_bundle(files)
    except ValueError as exc:
        return JSONResponse({"status": "rejected_input",
                             "error": {"code": "upload_error",
                                       "detail": str(exc)}},
                            status_code=400)
    try:
        fixed_map = json.loads(fixed or "{}")
    except (json.JSONDecodeError, TypeError, AttributeError):
        return JSONResponse({"status": "rejected_input",
                             "error": {"code": "bad_fixed",
                                       "detail": "fixed must be JSON"}},
                            status_code=400)
    result = D.plan_weekdays(bundle, fixed_map, strategy)
    return JSONResponse(
        result, status_code=200 if result["status"] == "ok" else 400)
