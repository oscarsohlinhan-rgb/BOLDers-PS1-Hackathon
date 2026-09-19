"""Contract tests for consent-gated AI source conversion."""

import json
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.ai_converter import convert_source_bundle
from api.main import app
from api.pipeline import CANONICAL_FILES


DATA = "/tmp/PS1-latest/01_data"


def canonical_bundle():
    bundle = {}
    for name in CANONICAL_FILES:
        with open(os.path.join(DATA, name), encoding="utf-8-sig") as handle:
            bundle[name] = handle.read()
    return bundle


class AiConverterTests(unittest.TestCase):
    def test_valid_model_draft_remains_untrusted_until_schema_gate_passes(self):
        expected = canonical_bundle()
        calls = []

        def transport(prompt):
            calls.append(prompt)
            return json.dumps({
                "tables": expected,
                "mappings": [{
                    "source_file": "combined.csv",
                    "source_ref": "rows 2-55",
                    "target_file": "08_ACTIVITY_DETAILS.csv",
                    "target_field": "activity_id",
                    "confidence": "high",
                    "note": "Mapped the activity identifier column.",
                }],
                "uncertainties": [],
            })

        result = convert_source_bundle(
            {"combined.csv": "activity,contract\nA001,C001\n"},
            transport=transport,
        )

        self.assertEqual(result["provider"], "gemini-vertex")
        self.assertTrue(result["untrusted_draft"])
        self.assertTrue(result["schema_gate"]["passed"])
        self.assertEqual(set(result["tables"]), set(CANONICAL_FILES))
        self.assertTrue(result["draft_id"].startswith("DRAFT-"))
        self.assertIn("untrusted data", calls[0])

    def test_missing_model_tables_fail_closed(self):
        def transport(_prompt):
            return json.dumps({
                "tables": {"01_LINES.csv": "line_code\nNSL\n"},
                "mappings": [],
                "uncertainties": [{
                    "source_file": "notes.txt",
                    "source_ref": "line 1",
                    "target_file": "02_STATIONS.csv",
                    "target_field": "station_id",
                    "reason": "No station identifier was supplied.",
                }],
            })

        result = convert_source_bundle(
            {"notes.txt": "The network uses the NSL."},
            transport=transport,
        )

        self.assertFalse(result["schema_gate"]["passed"])
        self.assertTrue(result["untrusted_draft"])
        self.assertIn(
            "missing_required_file",
            [error["code"] for error in result["schema_gate"]["errors"]],
        )
        self.assertTrue(result["uncertainties"])

    def test_gemini_transport_needs_no_user_api_key(self):
        result = convert_source_bundle(
            {"notes.txt": "source"},
            transport=lambda _prompt: json.dumps({"tables": {}, "mappings": [], "uncertainties": []}),
        )
        self.assertEqual(result["provider"], "gemini-vertex")


class AiConvertRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_route_requires_explicit_consent(self):
        response = self.client.post(
            "/ai/convert",
            data={"provider": "gemini-vertex", "consent": "false"},
            files=[("files", ("notes.txt", "source data", "text/plain"))],
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("consent", response.json()["error"].lower())

    @patch("api.main.convert_source_bundle")
    def test_route_uses_gemini_without_a_user_key(self, convert):
        convert.return_value = {"provider": "gemini-vertex", "tables": {}}
        response = self.client.post(
            "/ai/convert",
            data={"provider": "gemini-vertex", "consent": "true"},
            files=[("files", ("notes.txt", "source data", "text/plain"))],
        )
        self.assertEqual(response.status_code, 200)
        convert.assert_called_once()
        self.assertNotIn("api_key", convert.call_args.kwargs)

    def test_route_rejects_opaque_binary_files(self):
        response = self.client.post(
            "/ai/convert",
            data={"provider": "gemini-vertex", "consent": "true"},
            files=[(
                "files",
                ("workbook.xlsx", b"not really a workbook", "application/octet-stream"),
            )],
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("supported", response.json()["error"].lower())

    def test_unknown_provider_is_rejected_before_transport(self):
        calls = []

        def transport(prompt):
            calls.append(prompt)
            return "{}"

        with self.assertRaisesRegex(ValueError, "unsupported AI provider"):
            convert_source_bundle(
                {"notes.txt": "source"},
                provider="arbitrary-url", transport=transport)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
