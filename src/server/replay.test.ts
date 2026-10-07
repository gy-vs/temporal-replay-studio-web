import { describe, expect, it } from 'vitest';
import type { RunRecord, WorkflowDefinition } from '../shared/types';
import { ActivitySimulator } from './activitySimulator';
import { runWorkflowLive } from './liveRunner';
import { replayWorkflow } from './replayRunner';
import { orderFulfillmentV1, orderFulfillmentV2 } from './workflows';

const simulator = new ActivitySimulator([]);

async function runV1(overrides: NonNullable<Parameters<typeof runWorkflowLive>[2]['options']> = {}) {
  return runWorkflowLive(
    orderFulfillmentV1,
    { orderId: 'order-test', amount: 4200 },
    { startTimeMs: 1_700_000_000_000, seed: 42, ...overrides },
    simulator
  );
}

describe('workflow live run and replay', () => {
  it('records commands/events and replays with the same version', async () => {
    const { record } = await runV1();
    const replay = await replayWorkflow(record, orderFulfillmentV1);

    expect(record.events[0].type).toBe('WorkflowStarted');
    expect(record.events.some((event) => event.type === 'TimerFired')).toBe(true);
    expect(replay.outcome).toBe('matched');
    expect(replay.consumedThroughSeq).toBe(record.events.length);
    expect(replay.actualCommands.length).toBeGreaterThan(4);
  });

  it('allows new code to follow an old version marker branch without divergence', async () => {
    const { record } = await runV1();
    const replay = await replayWorkflow(record, orderFulfillmentV2);

    expect(replay.outcome).toBe('matched');
    expect(replay.finalState?.versionMarkers['order-fulfillment-parallel-carrier']).toBe(1);
  });

  it('reports the first divergent command with history context', async () => {
    const { record } = await runV1();
    const changed: WorkflowDefinition = {
      ...orderFulfillmentV2,
      version: 'changed',
      handler: async (input, ctx) => {
        await ctx.getVersion('order-fulfillment-parallel-carrier', 1, 2);
        await ctx.activity('reserveInventory', input);
        await ctx.activity('auditPaymentFirst', input);
      },
    };

    const replay = await replayWorkflow(record, changed);

    expect(replay.outcome).toBe('diverged');
    expect(replay.divergence).toMatchObject({
      expected: { type: 'activity', payload: { activityName: 'chargePayment' } },
      actual: { type: 'activity', payload: { activityName: 'auditPaymentFirst' } },
    });
    expect(replay.divergence?.before.length).toBeGreaterThan(0);
    expect(replay.divergence?.after.length).toBeGreaterThan(0);
  });

  it('records race terminal disposition and reaches the same replay decision', async () => {
    const { record } = await runV1({
      activityOverrides: {
        shipOrder: { behavior: 'success', delayMs: 300, race: 'lateCancel' },
      },
    });
    const discard = record.events.find((event) => event.type === 'ActivityTerminalDiscarded');

    expect(discard).toBeDefined();
    expect(discard?.payload.kind).toBe('cancelled');
    expect(record.status).toBe('completed');
    expect(record.events.some((event) => event.type === 'ActivityCompleted')).toBe(true);

    const replay = await replayWorkflow(record, orderFulfillmentV2);
    expect(replay.outcome).toBe('matched');
  });

  it('uses a pre-arriving cancellation when cancellation wins the race', async () => {
    const { record } = await runV1({
      activityOverrides: {
        shipOrder: { behavior: 'success', delayMs: 300, race: 'lateTerminal' },
      },
    });

    expect(record.status).toBe('failed');
    expect(record.events.find((event) => event.type === 'ActivityCancelled')).toBeDefined();
    expect(record.events.find((event) => event.type === 'ActivityTerminalDiscarded')?.payload.kind)
      .toBe('completed');
    expect(record.events.some((event) => event.type === 'CompensationStarted')).toBe(true);

    const replay = await replayWorkflow(record, orderFulfillmentV2);
    expect(replay.outcome).toBe('matched');
  });

  it.each([
    {
      name: 'truncated',
      mutate: (record: RunRecord) => {
        record.events.splice(record.events.length - 2);
      },
      expected: 'truncated',
    },
    {
      name: 'sequence gap',
      mutate: (record: RunRecord) => {
        record.events = record.events.filter((event) => event.seq !== 5);
      },
      expected: 'gap',
    },
    {
      name: 'unknown activity reference',
      mutate: (record: RunRecord) => {
        const terminal = record.events.find((event) => event.type === 'ActivityCompleted');
        if (terminal) terminal.payload.activityId = 'does-not-exist';
      },
      expected: 'unknown activity',
    },
  ])('classifies $name history as corrupt without throwing', async ({ mutate, expected }) => {
    const { record } = await runV1();
    mutate(record);

    const replay = await replayWorkflow(record, orderFulfillmentV2);

    expect(replay.outcome).toBe('corrupt');
    expect(replay.corruption?.reason.toLowerCase()).toContain(expected);
  });

  it('replays deterministic time and random observations from the recorded values', async () => {
    const observed: Array<{ now: number; random: number }> = [];
    const workflow: WorkflowDefinition = {
      workflowType: 'observedRuntime',
      version: 'v1',
      handler: async (_input, ctx) => {
        await ctx.activity('start', null);
        observed.push({ now: ctx.now(), random: ctx.random() });
        return observed[0];
      },
    };
    const { record } = await runWorkflowLive(
      workflow,
      null,
      { startTimeMs: 1_700_000_000_000, seed: 7 },
      simulator
    );

    observed.length = 0;
    const replay = await replayWorkflow(record, workflow);

    expect(replay.outcome).toBe('matched');
    expect(observed[0]).toEqual({
      now: record.events.find((event) => event.payload.kind === 'now')?.payload.value,
      random: record.events.find((event) => event.payload.kind === 'random')?.payload.value,
    });
  });
});
