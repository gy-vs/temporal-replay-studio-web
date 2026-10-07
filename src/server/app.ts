import express from 'express';
import type { RunOptions, Json } from '../shared/types';
import { ActivitySimulator } from './activitySimulator';
import { WorkflowRegistry } from './registry';
import { replayWorkflow } from './replayRunner';
import { InMemoryRunStore, type RunStore } from './store';
import {
  allWorkflowDefinitions,
  createDefaultSimulator,
} from './workflows';
import { runWorkflowLive } from './liveRunner';

export interface AppContext {
  registry: WorkflowRegistry;
  store: RunStore;
  simulator: ActivitySimulator;
}

export function createContext(): AppContext {
  const registry = new WorkflowRegistry();
  allWorkflowDefinitions.forEach((definition) => registry.register(definition));
  return {
    registry,
    store: new InMemoryRunStore(),
    simulator: createDefaultSimulator(),
  };
}

function asyncHandler(
  handler: (
    request: express.Request,
    response: express.Response
  ) => Promise<unknown>
): express.RequestHandler {
  return (request, response) => {
    handler(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    });
  };
}

export function createApp(context: AppContext = createContext()): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/workflows', (_request, response) => {
    response.json({ workflows: context.registry.list() });
  });

  app.get('/api/runs', asyncHandler(async (_request, response) => {
    const runs = await context.store.list();
    response.json({
      runs: runs.map((run) => ({
        runId: run.runId,
        workflowType: run.workflowType,
        version: run.version,
        status: run.status,
        createdAt: run.createdAt,
        eventCount: run.events.length,
        input: run.input,
      })),
    });
  }));

  app.get('/api/runs/:runId', asyncHandler(async (request, response) => {
    const run = await context.store.get(request.params.runId);
    if (!run) {
      response.status(404).json({ error: 'run not found' });
      return;
    }
    response.json({ run });
  }));

  app.post('/api/runs', asyncHandler(async (request, response) => {
    const body = request.body as {
      workflowType?: string;
      version?: string;
      input?: Json;
      options?: RunOptions;
    };
    if (!body.workflowType || !body.version) {
      response.status(400).json({ error: 'workflowType and version are required' });
      return;
    }
    const definition = context.registry.get(body.workflowType, body.version);
    if (!definition) {
      response.status(404).json({ error: 'workflow version not registered' });
      return;
    }
    const { record } = await runWorkflowLive(
      definition,
      body.input ?? { orderId: 'order-demo', amount: 4200 },
      body.options ?? {},
      context.simulator
    );
    await context.store.save(record);
    response.status(201).json({ run: record });
  }));

  app.post('/api/runs/:runId/replay', asyncHandler(async (request, response) => {
    const source = await context.store.get(request.params.runId);
    if (!source) {
      response.status(404).json({ error: 'source run not found' });
      return;
    }
    const body = request.body as { version?: string; workflowType?: string };
    const definition = context.registry.get(
      body.workflowType ?? source.workflowType,
      body.version ?? source.version
    );
    if (!definition) {
      response.status(404).json({ error: 'replay workflow version not registered' });
      return;
    }
    const result = await replayWorkflow(source, definition);
    response.json({ replay: result });
  }));

  return app;
}
