import type { RunRecord } from '../shared/types';

export interface RunStore {
  save(record: RunRecord): Promise<void>;
  get(runId: string): Promise<RunRecord | null>;
  list(): Promise<RunRecord[]>;
}

export class InMemoryRunStore implements RunStore {
  private readonly records = new Map<string, RunRecord>();

  async save(record: RunRecord): Promise<void> {
    this.records.set(record.runId, structuredClone(record));
  }

  async get(runId: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    return record ? structuredClone(record) : null;
  }

  async list(): Promise<RunRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}
