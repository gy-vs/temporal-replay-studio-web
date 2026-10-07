import type {
  Json,
  ReplayResult,
  RunOptions,
  RunRecord,
  WorkflowDefinitionMeta,
} from '../shared/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `request failed: ${response.status}`);
  return body;
}

export const api = {
  workflows(): Promise<{ workflows: WorkflowDefinitionMeta[] }> {
    return request('/api/workflows');
  },
  runs(): Promise<{
    runs: Array<{
      runId: string;
      workflowType: string;
      version: string;
      status: string;
      createdAt: string;
      eventCount: number;
      input: Json;
    }>;
  }> {
    return request('/api/runs');
  },
  run(runId: string): Promise<{ run: RunRecord }> {
    return request(`/api/runs/${encodeURIComponent(runId)}`);
  },
  createRun(payload: {
    workflowType: string;
    version: string;
    input?: Json;
    options?: RunOptions;
  }): Promise<{ run: RunRecord }> {
    return request('/api/runs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  replay(runId: string, version: string): Promise<{ replay: ReplayResult }> {
    return request(`/api/runs/${encodeURIComponent(runId)}/replay`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    });
  },
};
