export const EXPECTED = [
  "01_LINES.csv",
  "02_STATIONS.csv",
  "03_SECTORS.csv",
  "04_LOCATION_SUPPLY.csv",
  "05_BUFFER_LOCATION.csv",
  "06_PARAMETERS.csv",
  "07_PROJECT_DETAILS.csv",
  "08_ACTIVITY_DETAILS.csv",
];

export function classifyDroppedFiles(incoming) {
  const canonical = [];
  const conversion = [];
  for (const file of incoming) {
    if (EXPECTED.includes(file.name)) canonical.push(file);
    else conversion.push(file);
  }
  return { canonical, conversion };
}

export function buildConversionSources(canonical, conversion, incoming) {
  const selected = new Map();
  for (const file of [...canonical, ...conversion, ...incoming]) {
    selected.set(file.name, file);
  }
  const files = Array.from(selected.values());
  return files.some((file) => !EXPECTED.includes(file.name)) ? files : [];
}

export function canAcceptDraft(schemaPassed, userReviewed) {
  return schemaPassed && userReviewed;
}

export function assignFileToCanonicalSlot(files, unmatched, sourceName, targetName) {
  if (!EXPECTED.includes(targetName)) throw new Error(`Unknown canonical slot: ${targetName}`);
  if (files.has(targetName)) throw new Error(`${targetName} is already filled`);
  const source = unmatched.find((file) => file.name === sourceName);
  if (!source) throw new Error(`Unmatched file not found: ${sourceName}`);
  const renamed = typeof File === 'undefined'
    ? { ...source, name: targetName }
    : new File([source], targetName, { type: 'text/csv', lastModified: source.lastModified });
  const nextFiles = new Map(files);
  nextFiles.set(targetName, renamed);
  return {
    files: nextFiles,
    unmatched: unmatched.filter((file) => file.name !== sourceName),
    mapping: { source: sourceName, target: targetName },
  };
}
