export type PipelinePolicy = 'A' | 'B' | 'C';

export interface PipelineEvent {
  kind: 'stage' | 'validation' | 'solve-start' | 'solve-done' | 'solve-error' | 'done';
  policy?: PipelinePolicy;
  message: string;
  validation?: unknown;
  result?: unknown;
}

export interface PipelineResult {
  validation: { passed: boolean; evidence_id?: string; errors?: Array<{ detail: string }> };
  results: Partial<Record<PipelinePolicy, unknown>>;
  errors: Partial<Record<PipelinePolicy, string>>;
}

export const PIPELINE_POLICIES: PipelinePolicy[];
export function apiError(payload: unknown, fallback: string): string;
export function requestBundle(files: Map<string, File>): FormData;
export function runPipeline(options: {
  files: Map<string, File>;
  budget: number;
  fetchImpl?: typeof fetch;
  onEvent?: (event: PipelineEvent) => void;
}): Promise<PipelineResult>;

export function runReplan(options: {
  files: Map<string, File>;
  policy: PipelinePolicy;
  budget: number;
  disruption: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown>;

export function explainEvidence(options: {
  evidence: Record<string, unknown>;
  consent?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ provider: string; evidence_id?: string; explanation: string }>;
