"""Mutation and AI-boundary checks for the deterministic pipeline."""
import csv
import io
import os


DATA = "/tmp/PS1-latest/01_data"
FILES = [
    "01_LINES.csv", "02_STATIONS.csv", "03_SECTORS.csv",
    "04_LOCATION_SUPPLY.csv", "05_BUFFER_LOCATION.csv",
    "06_PARAMETERS.csv", "07_PROJECT_DETAILS.csv",
    "08_ACTIVITY_DETAILS.csv",
]


def _bundle():
    out = {}
    for name in FILES:
        with open(os.path.join(DATA, name), encoding="utf-8-sig") as handle:
            out[name] = handle.read()
    return out


def _rewrite(text, edit):
    rows = list(csv.reader(io.StringIO(text)))
    edit(rows)
    output = io.StringIO()
    csv.writer(output).writerows(rows)
    return output.getvalue()


def run(check):
    from api.pipeline import validate_csv_bundle

    base = _bundle()

    def drop_activity_id(rows):
        index = rows[0].index("activity_id")
        for row in rows:
            row.pop(index)

    result = validate_csv_bundle(dict(
        base,
        **{"08_ACTIVITY_DETAILS.csv": _rewrite(
            base["08_ACTIVITY_DETAILS.csv"], drop_activity_id)}))
    codes = [error["code"] for error in result["errors"]]
    check("pipe-missing-column-no-cascade",
          "missing_required_column" in codes and len(result["errors"]) <= 3,
          str(codes))

    result = validate_csv_bundle(dict(
        base, **{"08_ACTIVITY_DETAILS.csv": ""}))
    check("pipe-empty-table",
          "empty_table" in [e["code"] for e in result["errors"]],
          str(result["errors"][:3]))

    result = validate_csv_bundle(dict(
        base, **{"08_ACTIVITY_DETAILS.csv": '"unclosed'}))
    check("pipe-malformed-csv",
          "malformed_csv" in [e["code"] for e in result["errors"]],
          str(result["errors"][:3]))

    def drop_nature(rows):
        index = rows[0].index("nature_of_activity")
        for row in rows:
            row.pop(index)

    result = validate_csv_bundle(dict(
        base, **{"07_PROJECT_DETAILS.csv": _rewrite(
            base["07_PROJECT_DETAILS.csv"], drop_nature)}))
    check("pipe-required-model-column",
          "missing_required_column" in [e["code"] for e in result["errors"]],
          str(result["errors"][:3]))

    def remove_horizon(rows):
        rows[:] = [rows[0]] + [row for row in rows[1:]
                                  if row[0] != "horizon_weeks"]

    result = validate_csv_bundle(dict(
        base, **{"06_PARAMETERS.csv": _rewrite(
            base["06_PARAMETERS.csv"], remove_horizon)}))
    check("pipe-required-horizon-parameter",
          "missing_required_parameter" in
          [e["code"] for e in result["errors"]],
          str(result["errors"][:3]))

    def unknown_location(rows):
        rows[1][rows[0].index("start_location_id")] = "SEC:BAD:S00_S01:EB"

    result = validate_csv_bundle(dict(
        base, **{"08_ACTIVITY_DETAILS.csv": _rewrite(
            base["08_ACTIVITY_DETAILS.csv"], unknown_location)}))
    check("pipe-unknown-location-fk",
          "unknown_location_fk" in [e["code"] for e in result["errors"]],
          str(result["errors"][:3]))

    def unknown_predecessor(rows):
        rows[1][rows[0].index("predecessor_activity_id")] = "A999"

    result = validate_csv_bundle(dict(
        base, **{"08_ACTIVITY_DETAILS.csv": _rewrite(
            base["08_ACTIVITY_DETAILS.csv"], unknown_predecessor)}))
    check("pipe-unknown-predecessor-fk",
          "unknown_predecessor_fk" in
          [e["code"] for e in result["errors"]],
          str(result["errors"][:3]))

    def blank_activity_id(rows):
        rows[1][rows[0].index("activity_id")] = ""

    result = validate_csv_bundle(dict(
        base, **{"08_ACTIVITY_DETAILS.csv": _rewrite(
            base["08_ACTIVITY_DETAILS.csv"], blank_activity_id)}))
    check("pipe-empty-required-value",
          "empty_required_value" in [e["code"] for e in result["errors"]],
          str(result["errors"][:3]))

    try:
        from api.pipeline import run_solve_pipeline
    except ImportError:
        check("pipe-solve-import", False,
              "run_solve_pipeline is not implemented")
    else:
        for scenario in ("A", "B", "C"):
            solved = run_solve_pipeline(base, scenario, time_budget=1.0)
            check("pipe-solve-valid-%s" % scenario,
                  solved["status"] == "feasible" and
                  solved["schema_gate"]["passed"] and
                  solved["validator_gate"]["passed"] and
                  len(solved.get("files") or {}) == 3,
                  solved["status"])

        rejected = run_solve_pipeline(base, "X", time_budget=1.0)
        check("pipe-solve-invalid-scenario",
              rejected["status"] == "rejected_input" and
              not rejected.get("files"), rejected["status"])

        invalid = run_solve_pipeline(
            dict(base, **{"08_ACTIVITY_DETAILS.csv": ""}),
            "A", time_budget=1.0)
        check("pipe-solve-schema-rejected",
              invalid["status"] == "rejected_input" and
              not invalid.get("files"), invalid["status"])

        def impossible_workload(rows):
            header = rows[0]
            aid = header.index("activity_id")
            total = header.index("total_accesses")
            for row in rows[1:]:
                if row[aid] == "A001":
                    row[total] = "31"

        impossible = run_solve_pipeline(
            dict(base, **{"08_ACTIVITY_DETAILS.csv": _rewrite(
                base["08_ACTIVITY_DETAILS.csv"], impossible_workload)}),
            "A", time_budget=1.0)
        check("pipe-solve-infeasible-release-gate",
              impossible["status"] == "infeasible" and
              not impossible["validator_gate"]["passed"] and
              not impossible.get("files"), impossible["status"])

    try:
        from api.ai_explainer import explain_evidence
    except ImportError:
        check("pipe-explainer-import", False,
              "api.ai_explainer is not implemented")
    else:
        calls = []

        def transport(prompt):
            calls.append(prompt)
            return "The rule blocks this activity."

        evidence = {"evidence_id": "VALIDATE-test", "errors": [
            {"code": "workload", "activity_id": "A001",
             "detail": "31 accesses cannot fit in 30 weeks"}]}
        disabled = explain_evidence(
            evidence, api_key=None, transport=transport)
        check("pipe-explain-no-key",
              disabled["provider"] == "disabled" and not calls,
              str(disabled))

        explained = explain_evidence(
            evidence, api_key="unit-test-key", transport=transport)
        check("pipe-explain-key-boundary",
              explained["provider"] == "deepseek" and
              calls and "unit-test-key" not in calls[-1] and
              "validator" in explained["explanation"].lower(),
              str(explained))

        def broken_transport(_prompt):
            raise ConnectionError("offline")

        fallback = explain_evidence(
            evidence, api_key="unit-test-key", transport=broken_transport)
        check("pipe-explain-provider-failure",
              fallback["provider"] == "fallback" and
              bool(fallback["explanation"]), str(fallback))

    from api.main import ai_explain, app
    routes = {route.path for route in app.routes}
    check("pipe-api-validate-route", "/validate" in routes, str(routes))
    check("pipe-api-explain-route", "/ai/explain" in routes, str(routes))

    os.environ["DEEPSEEK_API_KEY"] = "test-server-key-must-be-ignored"
    try:
        no_shared_key = ai_explain(
            {"evidence_id": "VALIDATE-env-boundary", "errors": []},
            x_deepseek_api_key=None)
        check("pipe-api-ignores-shared-server-key",
              no_shared_key["provider"] == "disabled", str(no_shared_key))
    finally:
        os.environ.pop("DEEPSEEK_API_KEY", None)

    try:
        from fastapi.testclient import TestClient
        with TestClient(app) as client:
            uploads = [
                ("files", (name, base[name], "text/csv")) for name in FILES
            ]
            response = client.post("/validate", files=uploads)
            body = response.json()
            check("pipe-api-validate-live-upload",
                  response.status_code == 200 and body.get("passed") is True,
                  "%s %s" % (response.status_code, body))
    except Exception as exc:
        check("pipe-api-validate-live-upload", False, repr(exc))
