import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../shared/types';
import { ActivitySimulator } from './activitySimulator';
import { runWorkflowLive } from './liveRunner';
import { replayWorkflow } from './replayRunner';

const simulator = new ActivitySimulator([]);
const input = { orderId: 'order-determinism' };
const options = { startTimeMs: 1_700_000_000_000 };

describe('determinism guards', () => {
  it('rejects Math.random while executing workflow code on a live run', async () => {
    const workflow: WorkflowDefinition = {
      workflowType: 'guardedMathRandom',
      version: 'v1',
      handler: async () => Math.random(),
    };

    await expect(runWorkflowLive(workflow, input, options, simulator)).rejects.toThrow(
      /Math\.random/
    );
  });

  it('rejects Date.now and new Date while replaying workflow code', async () => {
    const safe: WorkflowDefinition = {
      workflowType: 'guardedDate',
      version: 'v1',
      handler: async (_input, ctx) => {
        await ctx.activity('start', null);
        return { ok: true };
      },
    };
    const unsafe: WorkflowDefinition = {
      ...safe,
      handler: async (_input, ctx) => {
        await ctx.activity('start', null);
        return Date.now();
      },
    };
    const { record } = await runWorkflowLive(safe, input, options, simulator);
    const replay = await replayWorkflow(record, unsafe);

    expect(replay.outcome).toBe('determinism-violation');
    expect(replay.determinismViolation?.message).toContain('Date.now');
  });

  it('also catches new Date after a timer during replay', async () => {
    const safe: WorkflowDefinition = {
      workflowType: 'guardedNewDate',
      version: 'v1',
      handler: async (_input, ctx) => {
        await ctx.timer(10);
        return { ok: true };
      },
    };
    const unsafe: WorkflowDefinition = {
      ...safe,
      handler: async (_input, ctx) => {
        await ctx.timer(10);
        return new Date().getTime();
      },
    };
    const { record } = await runWorkflowLive(safe, input, options, simulator);
    const replay = await replayWorkflow(record, unsafe);

    expect(replay.outcome).toBe('determinism-violation');
    expect(replay.determinismViolation?.message).toContain('new Date');
  });
});
