import type {
  ReplayReport,
  RunSummary,
  WorkflowInfo,
} from '../shared/types.js';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `请求失败：${res.status}`);
  }
  return body as T;
}

export const api = {
  listWorkflows: () => jsonFetch<WorkflowInfo[]>('/api/workflows'),
  listRuns: () => jsonFetch<RunSummary[]>('/api/runs'),
  getRun: (id: string) => jsonFetch<RunSummary>(`/api/runs/${id}`),
  replay: (id: string, version: string) =>
    jsonFetch<ReplayReport>(`/api/runs/${id}/replay`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),
  createRun: (body: unknown) =>
    jsonFetch<RunSummary>('/api/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export type { ReplayReport, RunSummary, WorkflowInfo };
