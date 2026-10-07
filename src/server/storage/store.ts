import type {
  DeterminismViolationEvent,
  ErrorPayload,
  HistoryEvent,
  JSONValue,
} from '../../shared/types.js';

export interface RunRecord {
  runId: string;
  createdAt: string;
  workflowType: string;
  version: string;
  input: JSONValue;
  status: 'completed' | 'failed';
  result?: JSONValue;
  error?: ErrorPayload;
  seed: number;
  history: HistoryEvent[];
  determinismViolations: DeterminismViolationEvent[];
}

/** Replaceable history store. The default implementation lives in-process. */
export interface HistoryStore {
  save(record: RunRecord): void;
  get(runId: string): RunRecord | undefined;
  list(): RunRecord[];
  delete(runId: string): boolean;
}

export class InMemoryHistoryStore implements HistoryStore {
  private runs = new Map<string, RunRecord>();

  save(record: RunRecord): void {
    this.runs.set(record.runId, record);
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  delete(runId: string): boolean {
    return this.runs.delete(runId);
  }
}
