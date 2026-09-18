"""PS1 FastAPI service: upload 8 CSVs -> solve -> validate -> export."""
from __future__ import annotations

import csv
import io
import os
import tempfile

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

from api import exporter as E
from api import replanner as R
from api import solver as S
from api import validator as V
from api.model import load_instance

app = FastAPI(title="PS1 Track Access Optimiser")

EXPECTED = ["01_LINES.csv", "02_STATIONS.csv", "03_SECTORS.csv",
            "04_LOCATION_SUPPLY.csv", "05_BUFFER_LOCATION.csv",
            "06_PARAMETERS.csv", "07_PROJECT_DETAILS.csv",
            "08_ACTIVITY_DETAILS.csv"]


def _csv_text(rows) -> str:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/solve")
async def solve(scenario: str = Form("A"),
                time_budget: float = Form(8.0),
                files: list[UploadFile] = File(...)):
    if scenario not in ("A", "B", "C"):
        return JSONResponse({"error": "scenario must be A, B or C"},
                            status_code=400)
    got = {f.filename: (await f.read()).decode("utf-8-sig") for f in files}
    missing = [n for n in EXPECTED if n not in got]
    if missing:
        return JSONResponse({"error": f"missing files: {missing}"},
                            status_code=400)
    with tempfile.TemporaryDirectory() as tmp:
        for name, text in got.items():
            with open(os.path.join(tmp, os.path.basename(name)), "w",
                      encoding="utf-8") as fh:
                fh.write(text)
        try:
            inst = load_instance(tmp)
        except ValueError as exc:
            return JSONResponse({"error": f"parse: {exc}"}, status_code=400)
        accesses, groups = S.solve(inst, scenario,
                                   time_budget=max(1.0, min(60.0, time_budget)))
        violations = V.validate(inst, accesses, groups, scenario)
        a_rows, o_rows, r_rows, _scores = E.build_outputs(
            inst, accesses, groups, scenario)
        report = E.build_report(inst, accesses, groups, scenario, violations)
        return {"report": report,
                "files": {"SCHEDULE_ACCESS.csv": _csv_text(a_rows),
                          "SCHEDULE_OCCUPANCY.csv": _csv_text(o_rows),
                          "RESULTS.csv": _csv_text(r_rows)}}


@app.post("/replan")
async def replan(disruption: str = Form(...),
                 scenario: str = Form("A"),
                 time_budget: float = Form(8.0),
                 files: list[UploadFile] = File(...)):
    """Solve a baseline, apply one narrow disruption, validate, then export."""
    if scenario not in ("A", "B", "C"):
        return JSONResponse({"error": "scenario must be A, B or C"},
                            status_code=400)
    got = {f.filename: (await f.read()).decode("utf-8-sig") for f in files}
    missing = [n for n in EXPECTED if n not in got]
    if missing:
        return JSONResponse({"error": f"missing files: {missing}"},
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

        payload = {"replan": result, "files": None}
        if result["validator_gate"]["passed"]:
            a_rows, o_rows, r_rows, _scores = E.build_outputs(
                inst, accesses, groups, scenario)
            payload["files"] = {
                "SCHEDULE_ACCESS.csv": _csv_text(a_rows),
                "SCHEDULE_OCCUPANCY.csv": _csv_text(o_rows),
                "RESULTS.csv": _csv_text(r_rows),
            }
        return payload
