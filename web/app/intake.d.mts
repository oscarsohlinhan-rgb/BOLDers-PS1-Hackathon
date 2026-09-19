export const EXPECTED: readonly [
  "01_LINES.csv",
  "02_STATIONS.csv",
  "03_SECTORS.csv",
  "04_LOCATION_SUPPLY.csv",
  "05_BUFFER_LOCATION.csv",
  "06_PARAMETERS.csv",
  "07_PROJECT_DETAILS.csv",
  "08_ACTIVITY_DETAILS.csv",
];

export function classifyDroppedFiles<T extends { name: string }>(incoming: T[]): {
  canonical: T[];
  conversion: T[];
};

export function buildConversionSources<T extends { name: string }>(
  canonical: T[],
  conversion: T[],
  incoming: T[],
): T[];

export function canAcceptDraft(
  schemaPassed: boolean,
  userReviewed: boolean,
): boolean;

export function assignFileToCanonicalSlot<T extends { name: string; type?: string; lastModified?: number }>(
  files: Map<string, T>,
  unmatched: T[],
  sourceName: string,
  targetName: string,
): { files: Map<string, T>; unmatched: T[]; mapping: { source: string; target: string } };
