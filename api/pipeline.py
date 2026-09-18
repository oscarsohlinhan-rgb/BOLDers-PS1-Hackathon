"""Pipeline pre-checks: validate a CSV bundle before loading + solve."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import tempfile
from datetime import date
from typing import Any, Dict, List, Optional

CANONICAL_FILES = [
    "01_LINES.csv",
    "02_STATIONS.csv",
    "03_SECTORS.csv",
    "04_LOCATION_SUPPLY.csv",
    "05_BUFFER_LOCATION.csv",
    "06_PARAMETERS.csv",
    "07_PROJECT_DETAILS.csv",
    "08_ACTIVITY_DETAILS.csv",
]

REQUIRED_COLUMNS: Dict[str, List[str]] = {
    "01_LINES.csv": ["line_code"],
    "02_STATIONS.csv": ["station_id", "line_code", "seq", "is_interchange"],
    "03_SECTORS.csv": [
        "sector_id", "line_code", "from_station_id", "to_station_id", "seq",
    ],
    "04_LOCATION_SUPPLY.csv": ["location_id", "supply_capacity"],
    "05_BUFFER_LOCATION.csv": [
        "nature_of_works", "up_to_buffer_sectors", "opposite_bound_required",
    ],
    "06_PARAMETERS.csv": ["key", "value"],
    "07_PROJECT_DETAILS.csv": [
        "contract_number", "activity_type", "nature_of_activity",
        "contract_priority",
        "contract_completion_date", "planned_completion_date",
        "number_of_workfronts", "access_type", "number_of_maximum_access_per_week",
    ],
    "08_ACTIVITY_DETAILS.csv": [
        "activity_id", "contract_number", "activity_type",
        "start_location_id", "end_location_id", "total_accesses",
        "planned_start_date", "predecessor_activity_id", "activity_priority",
    ],
}

INTEGER_FIELDS: Dict[str, List[str]] = {
    "02_STATIONS.csv": ["seq"],
    "03_SECTORS.csv": ["seq"],
    "04_LOCATION_SUPPLY.csv": ["supply_capacity"],
    "05_BUFFER_LOCATION.csv": ["up_to_buffer_sectors", "opposite_bound_required"],
    "07_PROJECT_DETAILS.csv": [
        "contract_priority", "number_of_workfronts",
        "number_of_maximum_access_per_week",
    ],
    "08_ACTIVITY_DETAILS.csv": ["total_accesses", "activity_priority"],
}

DATE_FIELDS: Dict[str, List[str]] = {
    "07_PROJECT_DETAILS.csv": [
        "contract_completion_date", "planned_completion_date",
    ],
    "08_ACTIVITY_DETAILS.csv": ["planned_start_date"],
}

ALLOWED_ACTIVITY_TYPES = {"Renewal", "Construction"}
REQUIRED_PARAMETERS = {"horizon_start", "horizon_weeks"}
OPTIONAL_EMPTY_FIELDS = {("08_ACTIVITY_DETAILS.csv",
                          "predecessor_activity_id")}


def _evidence_id(bundle: Dict[str, str]) -> str:
    h = hashlib.sha256()
    for fname in sorted(bundle):
        h.update(fname.encode("utf-8"))
        h.update(bundle[fname].encode("utf-8"))
    return "SCHEMA-" + h.hexdigest()[:16]


def _is_valid_date(s: str) -> bool:
    try:
        date.fromisoformat(s.strip())
        return True
    except (ValueError, TypeError):
        return False


def _parse_rows(csv_text: str, fname: str,
                errors: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    try:
        reader = csv.DictReader(io.StringIO(csv_text), strict=True)
        rows = list(reader)
    except csv.Error as e:
        errors.append({
            "code": "malformed_csv",
            "file": fname,
            "detail": f"malformed CSV: {e}",
        })
        return []
    if reader.fieldnames is None or not rows:
        errors.append({
            "code": "empty_table",
            "file": fname,
            "detail": "no header or zero data rows",
        })
        return []
    return rows


def _rows_to_csv(rows: list) -> str:
    if not rows:
        return ""
    output = io.StringIO()
    if isinstance(rows[0], dict):
        writer = csv.DictWriter(output, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    else:
        writer = csv.writer(output)
        writer.writerows(rows)
    return output.getvalue()


def validate_csv_bundle(bundle: Dict[str, str]) -> Dict[str, Any]:
    errors: List[Dict[str, Any]] = []

    # --- missing required files ---
    for fname in CANONICAL_FILES:
        if fname not in bundle:
            errors.append({
                "code": "missing_required_file",
                "file": fname,
                "detail": f"required file not supplied",
            })

    # --- structural checks: columns, integer, date, activity_type ---
    for fname in CANONICAL_FILES:
        if fname not in bundle:
            continue
        csv_text = bundle[fname]

        # Empty text is handled here; header-only input is handled by parser.
        if not csv_text.strip():
            errors.append({
                "code": "empty_table",
                "file": fname,
                "detail": "no header or zero data rows",
            })
            continue

        rows = _parse_rows(csv_text, fname, errors)
        if not rows:
            continue

        header = rows[0].keys()

        # required columns — skip row/relationship validation when columns missing
        missing_cols = [col for col in REQUIRED_COLUMNS[fname]
                        if col not in header]
        for col in missing_cols:
            errors.append({
                "code": "missing_required_column",
                "file": fname,
                "field": col,
                "detail": f"column '{col}' missing from {fname}",
            })
        if missing_cols:
            continue

        int_fields = INTEGER_FIELDS.get(fname, [])
        date_fields = DATE_FIELDS.get(fname, [])

        for row_num, row in enumerate(rows, start=2):
            for field in REQUIRED_COLUMNS[fname]:
                if ((fname, field) not in OPTIONAL_EMPTY_FIELDS and
                        not (row.get(field) or "").strip()):
                    errors.append({
                        "code": "empty_required_value",
                        "file": fname,
                        "row": row_num,
                        "field": field,
                        "detail": f"required value '{field}' is empty",
                    })
            # activity_type allowed values
            if "activity_type" in row:
                at = row["activity_type"]
                if at not in ALLOWED_ACTIVITY_TYPES:
                    errors.append({
                        "code": "invalid_activity_type",
                        "file": fname,
                        "row": row_num,
                        "field": "activity_type",
                        "detail": f"'{at}' not in {sorted(ALLOWED_ACTIVITY_TYPES)}",
                    })
            # integer fields
            for field in int_fields:
                val = row.get(field)
                if val is None:
                    continue
                try:
                    int(val)
                except (ValueError, TypeError):
                    errors.append({
                        "code": "invalid_integer",
                        "file": fname,
                        "row": row_num,
                        "field": field,
                        "detail": f"cannot parse '{val}' as int",
                    })
            # date fields
            for field in date_fields:
                val = row.get(field)
                if val is None:
                    continue
                val = val.strip()
                if val and not _is_valid_date(val):
                    errors.append({
                        "code": "malformed_date",
                        "file": fname,
                        "row": row_num,
                        "field": field,
                        "detail": f"'{val}' is not a valid ISO date",
                    })

    structurally_invalid = {
        error["file"] for error in errors
        if error["code"] in {
            "missing_required_file", "missing_required_column",
            "malformed_csv", "empty_table",
        }
    }

    # --- canonical parameters ---
    if "06_PARAMETERS.csv" not in structurally_invalid:
        parameter_rows = _parse_rows(bundle["06_PARAMETERS.csv"],
                                     "06_PARAMETERS.csv", errors)
        parameters = {row.get("key", ""): row.get("value", "")
                      for row in parameter_rows}
        for key in sorted(REQUIRED_PARAMETERS - set(parameters)):
            errors.append({
                "code": "missing_required_parameter",
                "file": "06_PARAMETERS.csv",
                "field": key,
                "detail": f"required parameter '{key}' is missing",
            })
        if "horizon_start" in parameters and not _is_valid_date(
                parameters["horizon_start"]):
            errors.append({
                "code": "malformed_date",
                "file": "06_PARAMETERS.csv",
                "field": "horizon_start",
                "detail": "horizon_start is not a valid ISO date",
            })
        if "horizon_weeks" in parameters:
            try:
                horizon_weeks = int(parameters["horizon_weeks"])
                if horizon_weeks < 1:
                    raise ValueError
            except (TypeError, ValueError):
                errors.append({
                    "code": "invalid_integer",
                    "file": "06_PARAMETERS.csv",
                    "field": "horizon_weeks",
                    "detail": "horizon_weeks must be a positive integer",
                })

    # --- network foreign keys ---
    lines = set()
    if "01_LINES.csv" not in structurally_invalid:
        lines = {row.get("line_code", "") for row in _parse_rows(
            bundle["01_LINES.csv"], "01_LINES.csv", errors)}
    stations = set()
    if "02_STATIONS.csv" not in structurally_invalid:
        station_rows = _parse_rows(bundle["02_STATIONS.csv"],
                                   "02_STATIONS.csv", errors)
        stations = {row.get("station_id", "") for row in station_rows}
        for row_num, row in enumerate(station_rows, start=2):
            if ("01_LINES.csv" not in structurally_invalid and
                    row.get("line_code", "") not in lines):
                errors.append({
                    "code": "unknown_line_fk", "file": "02_STATIONS.csv",
                    "row": row_num, "field": "line_code",
                    "detail": f"line '{row.get('line_code', '')}' not found",
                })
    if "03_SECTORS.csv" not in structurally_invalid:
        for row_num, row in enumerate(_parse_rows(
                bundle["03_SECTORS.csv"], "03_SECTORS.csv", errors), start=2):
            if ("01_LINES.csv" not in structurally_invalid and
                    row.get("line_code", "") not in lines):
                errors.append({
                    "code": "unknown_line_fk", "file": "03_SECTORS.csv",
                    "row": row_num, "field": "line_code",
                    "detail": f"line '{row.get('line_code', '')}' not found",
                })
            for field in ("from_station_id", "to_station_id"):
                if ("02_STATIONS.csv" not in structurally_invalid and
                        row.get(field, "") not in stations):
                    errors.append({
                        "code": "unknown_station_fk",
                        "file": "03_SECTORS.csv", "row": row_num,
                        "field": field,
                        "detail": f"station '{row.get(field, '')}' not found",
                    })

    locations = set()
    if "04_LOCATION_SUPPLY.csv" not in structurally_invalid:
        locations = {row.get("location_id", "") for row in _parse_rows(
            bundle["04_LOCATION_SUPPLY.csv"],
            "04_LOCATION_SUPPLY.csv", errors)}

    # --- contract FK validation (08 -> 07) ---
    contracts: set = set()
    if "07_PROJECT_DETAILS.csv" not in structurally_invalid:
        for row in _parse_rows(bundle["07_PROJECT_DETAILS.csv"],
                               "07_PROJECT_DETAILS.csv", errors):
            if "contract_number" in row:
                contracts.add(row["contract_number"])

    # --- activity-level checks ---
    activities: Dict[str, Dict[str, Any]] = {}
    if "08_ACTIVITY_DETAILS.csv" not in structurally_invalid:
        rows = _parse_rows(bundle["08_ACTIVITY_DETAILS.csv"],
                           "08_ACTIVITY_DETAILS.csv", errors)
        if rows:
            header_08 = rows[0].keys()
            has_activity_id = "activity_id" in header_08
            has_contract_number = "contract_number" in header_08
            has_predecessor = "predecessor_activity_id" in header_08

            for row_num, row in enumerate(rows, start=2):
                aid = row.get("activity_id", "") if has_activity_id else ""
                if has_activity_id and aid in activities:
                    errors.append({
                        "code": "duplicate_activity_id",
                        "file": "08_ACTIVITY_DETAILS.csv",
                        "row": row_num,
                        "field": "activity_id",
                        "detail": f"duplicate activity_id '{aid}'",
                    })
                activities[aid] = row

                # contract FK
                if (has_contract_number and
                        "07_PROJECT_DETAILS.csv" not in structurally_invalid):
                    cnum = row.get("contract_number", "")
                    if cnum and cnum not in contracts:
                        errors.append({
                            "code": "unknown_contract_fk",
                            "file": "08_ACTIVITY_DETAILS.csv",
                            "row": row_num,
                            "field": "contract_number",
                            "detail": f"contract '{cnum}' not found in 07_PROJECT_DETAILS.csv",
                        })

                for field in ("start_location_id", "end_location_id"):
                    location = row.get(field, "")
                    if ("04_LOCATION_SUPPLY.csv" not in structurally_invalid and
                            location and location not in locations):
                        errors.append({
                            "code": "unknown_location_fk",
                            "file": "08_ACTIVITY_DETAILS.csv",
                            "row": row_num, "field": field,
                            "detail": f"location '{location}' not found",
                        })

                predecessor = row.get("predecessor_activity_id", "").strip()
                if predecessor and predecessor == aid:
                    errors.append({
                        "code": "self_predecessor",
                        "file": "08_ACTIVITY_DETAILS.csv", "row": row_num,
                        "field": "predecessor_activity_id",
                        "detail": f"activity '{aid}' cannot precede itself",
                    })

    # --- predecessor cycle detection ---
    pred_map: Dict[str, Optional[str]] = {}
    for aid, row in activities.items():
        p = row.get("predecessor_activity_id", "").strip() or None
        pred_map[aid] = p
        if p and p not in activities:
            errors.append({
                "code": "unknown_predecessor_fk",
                "file": "08_ACTIVITY_DETAILS.csv",
                "field": "predecessor_activity_id",
                "detail": f"predecessor activity '{p}' not found",
            })
    if _has_cycle(pred_map):
        errors.append({
            "code": "predecessor_cycle",
            "file": "08_ACTIVITY_DETAILS.csv",
            "detail": "predecessor links contain a cycle",
        })

    if errors:
        return {"passed": False, "evidence_id": _evidence_id(bundle), "errors": errors}
    return {"passed": True, "evidence_id": _evidence_id(bundle), "errors": []}


def _has_cycle(pred_map: Dict[str, Optional[str]]) -> bool:
    WHITE, GRAY, BLACK = 0, 1, 2
    color: Dict[str, int] = {k: WHITE for k in pred_map}

    def visit(u: str) -> bool:
        color[u] = GRAY
        p = pred_map[u]
        if p:
            if p not in color:
                pass
            elif color[p] == GRAY:
                return True
            elif color[p] == WHITE and visit(p):
                return True
        color[u] = BLACK
        return False

    return any(color[k] == WHITE and visit(k) for k in pred_map)


# ---------------------------------------------------------------- solve

def run_solve_pipeline(bundle: Dict[str, str], scenario: str,
                       time_budget: float) -> Dict[str, Any]:
    """Validate, solve, validate independently, and return structured result."""
    from . import exporter as E
    from . import solver as S
    from . import validator as V
    from .model import load_instance

    # --- input validation ---
    if scenario not in ("A", "B", "C"):
        return {
            "status": "rejected_input",
            "schema_gate": {"passed": False,
                            "evidence_id": _evidence_id(bundle),
                            "errors": [{"code": "invalid_scenario",
                                        "detail": "scenario must be A, B or C"}]},
            "validator_gate": {"passed": False, "hard_violations": []},
            "report": {},
            "files": {},
        }

    time_budget = max(1, min(60, time_budget))

    # --- schema gate ---
    schema = validate_csv_bundle(bundle)
    if not schema["passed"]:
        return {
            "status": "rejected_input",
            "schema_gate": schema,
            "validator_gate": {"passed": False, "hard_violations": []},
            "report": {},
            "files": {},
        }

    # --- materialize canonical files in a temporary directory ---
    with tempfile.TemporaryDirectory() as tmp:
        for fname in CANONICAL_FILES:
            with open(os.path.join(tmp, fname), "w", newline="") as f:
                f.write(bundle[fname])

        try:
            inst = load_instance(tmp)
        except (KeyError, ValueError) as exc:
            return {
                "status": "rejected_input",
                "schema_gate": schema,
                "validator_gate": {"passed": False, "hard_violations": []},
                "report": {"error": {"code": "model_load_error",
                                      "detail": str(exc)}},
                "files": {},
            }

        # --- solve ---
        acc, grp = S.solve(inst, scenario, time_budget=time_budget)

        # --- independent validation ---
        violations = V.validate(inst, acc, grp, scenario)
        hard = [dict(violation) for violation in violations]
        warnings = V.warnings(inst, acc, grp, scenario)
        validation_payload = json.dumps(
            {"input": schema["evidence_id"], "scenario": scenario,
             "violations": hard, "warnings": warnings},
            sort_keys=True, separators=(",", ":"))
        validation_id = "VALIDATE-" + hashlib.sha256(
            validation_payload.encode("utf-8")).hexdigest()[:16]
        report = E.build_report(inst, acc, grp, scenario, violations)

        result: Dict[str, Any] = {
            "status": "feasible" if not hard else "infeasible",
            "schema_gate": schema,
            "validator_gate": {
                "passed": not hard,
                "hard_violations": hard,
                "soft_warnings": warnings,
                "evidence_id": validation_id,
            },
            "report": report,
            "files": {},
        }

        # --- release CSV strings only when no hard violations ---
        if not hard:
            access_rows, occ_rows, res_rows, _scores = E.build_outputs(
                inst, acc, grp, scenario)
            result["files"] = {
                "SCHEDULE_ACCESS.csv": _rows_to_csv(access_rows),
                "SCHEDULE_OCCUPANCY.csv": _rows_to_csv(occ_rows),
                "RESULTS.csv": _rows_to_csv(res_rows),
            }

        return result
