import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED,
  buildConversionSources,
  canAcceptDraft,
  classifyDroppedFiles,
  assignFileToCanonicalSlot,
} from "../app/intake.mjs";

test("canonical files fill manifest slots while non-canonical files enter conversion", () => {
  const incoming = [
    { name: EXPECTED[0] },
    { name: "combined-export.csv" },
    { name: EXPECTED[1] },
  ];
  const result = classifyDroppedFiles(incoming);

  assert.deepEqual(result.canonical.map((file) => file.name), EXPECTED.slice(0, 2));
  assert.deepEqual(result.conversion.map((file) => file.name), ["combined-export.csv"]);
});

test("a user can explicitly assign a misnamed file to one available canonical slot", () => {
  const files = new Map([[EXPECTED[0], { name: EXPECTED[0] }]]);
  const unmatched = [{ name: "stations final.csv", type: "text/csv", lastModified: 7 }];
  const result = assignFileToCanonicalSlot(files, unmatched, "stations final.csv", EXPECTED[1]);

  assert.equal(result.files.get(EXPECTED[1]).name, EXPECTED[1]);
  assert.deepEqual(result.unmatched, []);
  assert.deepEqual(result.mapping, { source: "stations final.csv", target: EXPECTED[1] });
});

test("manual assignment refuses to overwrite an occupied canonical slot", () => {
  const files = new Map([[EXPECTED[0], { name: EXPECTED[0] }]]);
  assert.throws(
    () => assignFileToCanonicalSlot(files, [{ name: "other.csv" }], "other.csv", EXPECTED[0]),
    /already filled/,
  );
});

test("a draft cannot be accepted without deterministic pass and user review", () => {
  assert.equal(canAcceptDraft(false, false), false);
  assert.equal(canAcceptDraft(true, false), false);
  assert.equal(canAcceptDraft(false, true), false);
  assert.equal(canAcceptDraft(true, true), true);
});

test("AI identification receives the complete selected bundle when one filename is inaccurate", () => {
  const alreadySelected = [{ name: EXPECTED[0] }];
  const incoming = [{ name: EXPECTED[1] }, { name: "stations-renamed.csv" }];

  const sources = buildConversionSources(alreadySelected, [], incoming);

  assert.deepEqual(sources.map((file) => file.name), [
    EXPECTED[0],
    EXPECTED[1],
    "stations-renamed.csv",
  ]);
});

test("canonical-only intake never opens the AI identification path", () => {
  const sources = buildConversionSources([], [], [
    { name: EXPECTED[0] },
    { name: EXPECTED[1] },
  ]);

  assert.deepEqual(sources, []);
});
