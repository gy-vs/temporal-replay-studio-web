import { commandsEqual } from '../shared/commands';
import {
  CorruptHistoryError,
  failureInfo,
  isDeterminismViolation,
} from '../shared/errors';
import {
  applyEvent,
  reduceEvents,
  toStateView,
  type WorkflowReductionState,
} from '../shared/reducer';
import type {
  ActivityFailureInfo,
  Command,
  Corruption,
  Divergence,
  Json,
  ReplayResult,
  RunRecord,
  WorkflowDefinition,
  WorkflowEvent,
} from '../shared/types';
import { installDeterminismGuards, runInDeterminismScope } from './determinism';
import { commandForEvent, isImperativeEvent } from './eventCommands';
import { runtimeId } from './events';
import { NativeDate } from './nativeGlobals';
import { DeterministicRuntime, type ActivityTerminal, type RuntimeHost } from './runtime';

installDeterminismGuards();

class ReplayDivergenceError extends Error {
  constructor(readonly divergence: Divergence) {
    super(divergence.reason);
    this.name = 'ReplayDivergenceError';
  }
}

interface PendingActivityReplay {
  resolve: (terminal: ActivityTerminal) => void;
}

interface PendingTimerReplay {
  resolve: (value: { cancelled: boolean; reason?: string }) => void;
}

export function windowAround(events: WorkflowEvent[], seq: number | null, radius = 2) {
  const index = seq === null ? -1 : events.findIndex((event) => event.seq === seq);
  if (index < 0) {
    return {
      before: events.slice(Math.max(0, events.length - radius), events.length),
      event: null,
      after: [],
    };
  }
  return {
    before: events.slice(Math.max(0, index - radius), index),
    event: events[index] ?? null,
    after: events.slice(index + 1, index + 1 + radius),
  };
}

function makeDivergence(
  events: WorkflowEvent[],
  seq: number,
  expected: Command | null,
  actual: Command | null,
  reason: string
): ReplayDivergenceError {
  const context = windowAround(events, seq);
  return new ReplayDivergenceError({
    seq,
    expected,
    actual,
    reason,
    before: context.before,
    event: context.event,
    after: context.after,
  });
}

function corrupt(events: WorkflowEvent[], seq: number | null, reason: string): CorruptHistoryError {
  return new CorruptHistoryError(reason, seq);
}

function corruptionFromError(events: WorkflowEvent[], error: CorruptHistoryError): Corruption {
  const context = windowAround(events, error.seq);
  return {
    seq: error.seq,
    reason: error.message,
    before: context.before,
    event: context.event,
    after: context.after,
  };
}

function requireObject(event: WorkflowEvent, key: string): Record<string, Json> {
  const value = event.payload[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw corrupt([event], event.seq, `event ${event.seq} missing object field ${key}`);
  }
  return value as Record<string, Json>;
}

function failureFromEvent(event: WorkflowEvent): ActivityFailureInfo {
  return requireObject(event, 'error') as unknown as ActivityFailureInfo;
}

function validateHistory(events: WorkflowEvent[]): void {
  if (events.length === 0 || events[0].type !== 'WorkflowStarted') {
    throw corrupt(events, events[0]?.seq ?? null, 'history must begin with WorkflowStarted');
  }

  const pendingActivities = new Set<string>();
  const pendingTimers = new Set<string>();
  const compensations = new Set<string>();
  const usedChangeIds = new Set<string>();
  let terminal: WorkflowEvent | undefined;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedSeq = index + 1;
    if (!event || event.seq !== expectedSeq) {
      throw corrupt(events, expectedSeq, `history has gap or out-of-order sequence at ${expectedSeq}`);
    }
    if (terminal) throw corrupt(events, event.seq, `event appears after terminal ${terminal.type}`);
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      throw corrupt(events, event.seq, `event ${event.seq} payload must be an object`);
    }

    const p = event.payload;
    const activityId = p.activityId === undefined ? undefined : String(p.activityId);
    const timerId = p.timerId === undefined ? undefined : String(p.timerId);
    const compensationId =
      p.compensationId === undefined ? undefined : String(p.compensationId);

    switch (event.type) {
      case 'WorkflowStarted':
        if (index !== 0) throw corrupt(events, event.seq, 'duplicate WorkflowStarted');
        break;
      case 'ActivityScheduled':
        if (!activityId) throw corrupt(events, event.seq, 'ActivityScheduled missing activityId');
        if (pendingActivities.has(activityId)) {
          throw corrupt(events, event.seq, `duplicate pending activity ${activityId}`);
        }
        pendingActivities.add(activityId);
        if (event.commandSeq !== event.seq) {
          throw corrupt(events, event.seq, 'ActivityScheduled did not consume its own history position');
        }
        break;
      case 'ActivityStarted':
      case 'ActivityRetryScheduled':
        if (activityId && !pendingActivities.has(activityId)) {
          throw corrupt(events, event.seq, `event references unknown activity ${activityId}`);
        }
        break;
      case 'ActivityCompleted':
      case 'ActivityFailed':
      case 'ActivityTimedOut':
        if (!activityId || !pendingActivities.has(activityId)) {
          throw corrupt(events, event.seq, `event references unknown activity ${activityId ?? '<missing>'}`);
        }
        if (event.type !== 'ActivityCompleted') failureFromEvent(event);
        pendingActivities.delete(activityId);
        break;
      case 'ActivityCancelRequested':
        if (!activityId) throw corrupt(events, event.seq, 'cancel request missing activityId');
        if (!pendingActivities.has(activityId)) {
          const previouslyTerminal = events.some(
            (previous) =>
              previous.seq < event.seq &&
              String(previous.payload.activityId ?? '') === activityId &&
              [
                'ActivityCompleted',
                'ActivityFailed',
                'ActivityTimedOut',
                'ActivityCancelled',
              ].includes(previous.type)
          );
          if (!previouslyTerminal) {
            throw corrupt(events, event.seq, `cancellation references unknown activity ${activityId}`);
          }
        }
        break;
      case 'ActivityCancelled':
        if (!activityId || !pendingActivities.has(activityId)) {
          throw corrupt(events, event.seq, `cancellation terminal references unknown activity ${activityId ?? '<missing>'}`);
        }
        pendingActivities.delete(activityId);
        break;
      case 'ActivityTerminalDiscarded':
        if (!activityId) throw corrupt(events, event.seq, 'discarded terminal missing activityId');
        break;
      case 'TimerStarted':
        if (!timerId) throw corrupt(events, event.seq, 'TimerStarted missing timerId');
        if (pendingTimers.has(timerId)) throw corrupt(events, event.seq, `duplicate timer ${timerId}`);
        pendingTimers.add(timerId);
        break;
      case 'TimerFired':
        if (!timerId || !pendingTimers.has(timerId)) {
          throw corrupt(events, event.seq, `timer fire references unknown timer ${timerId ?? '<missing>'}`);
        }
        pendingTimers.delete(timerId);
        break;
      case 'TimerCancelRequested':
        if (!timerId) throw corrupt(events, event.seq, 'timer cancellation missing timerId');
        break;
      case 'TimerCancelled':
        if (!timerId || !pendingTimers.has(timerId)) {
          throw corrupt(events, event.seq, `timer cancellation references unknown timer ${timerId ?? '<missing>'}`);
        }
        pendingTimers.delete(timerId);
        break;
      case 'TimerCancelIgnored':
      case 'TimerFireDiscarded':
        if (!timerId) throw corrupt(events, event.seq, `${event.type} missing timerId`);
        break;
      case 'CompensationRegistered':
        if (!compensationId) throw corrupt(events, event.seq, 'missing compensationId');
        if (compensations.has(compensationId)) {
          throw corrupt(events, event.seq, `duplicate compensation ${compensationId}`);
        }
        compensations.add(compensationId);
        break;
      case 'CompensationStarted':
      case 'CompensationCompleted':
      case 'CompensationFailed':
        if (!compensationId || !compensations.has(compensationId)) {
          throw corrupt(events, event.seq, `event references unknown compensation ${compensationId ?? '<missing>'}`);
        }
        break;
      case 'WorkflowVersionMarked': {
        const changeId = String(p.changeId ?? '');
        if (!changeId) throw corrupt(events, event.seq, 'version marker missing changeId');
        if (usedChangeIds.has(changeId)) throw corrupt(events, event.seq, `duplicate version marker ${changeId}`);
        usedChangeIds.add(changeId);
        break;
      }
      case 'RuntimeObserved':
        if (p.value === undefined) throw corrupt(events, event.seq, 'RuntimeObserved missing value');
        break;
      case 'WorkflowCompleted':
      case 'WorkflowFailed': {
        if (pendingActivities.size !== 0 || pendingTimers.size !== 0) {
          throw corrupt(events, event.seq, 'workflow terminal reached with pending operations');
        }
        if (event.type === 'WorkflowFailed') failureFromEvent(event);
        terminal = event;
        break;
      }
    }
  }

  if (!terminal) throw corrupt(events, null, 'history is truncated before a workflow terminal');
}

function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const iterate = (): void => {
      count += 1;
      if (count > 10) {
        queueMicrotask(() => resolve());
        return;
      }
      queueMicrotask(iterate);
    };
    queueMicrotask(iterate);
  });
}

export async function replayWorkflow(
  source: RunRecord,
  definition: WorkflowDefinition
): Promise<ReplayResult> {
  const events = source.events;
  const actualCommands: Array<{ seq: number; command: Command }> = [];
  let consumedThroughSeq = 1;
  let finalState: WorkflowReductionState | null = null;
  const evaluatedAt = new NativeDate().toISOString();
  const replayId = runtimeId('replay');

  const makeResult = (
    outcome: ReplayResult['outcome'],
    extras: Partial<ReplayResult> = {}
  ): ReplayResult => ({
    id: replayId,
    sourceRunId: source.runId,
    workflowType: source.workflowType,
    requestedVersion: definition.version,
    outcome,
    consumedThroughSeq,
    divergence: null,
    corruption: null,
    determinismViolation: null,
    actualCommands,
    finalState: finalState ? toStateView(finalState) : null,
    replayedAt: evaluatedAt,
    ...extras,
  });

  try {
    validateHistory(events);
  } catch (error) {
    if (error instanceof CorruptHistoryError) {
      finalState = reduceEvents(events);
      return makeResult('corrupt', { corruption: corruptionFromError(events, error) });
    }
    throw error;
  }

  return runInDeterminismScope(`replay:${definition.workflowType}:${definition.version}`, async () => {
    let pointer = 1;
    const pendingActivities = new Map<string, PendingActivityReplay>();
    const pendingTimers = new Map<string, PendingTimerReplay>();
    const runtime = new DeterministicRuntime(buildHost());
    let state = applyEvent(reduceEvents([]), events[0]);

    let mainSettled = false;
    let mainFailed = false;
    let mainError: unknown;
    let mainResult: Json | undefined;
    let cleanupStarted = false;
    let compensationIndex = -1;
    let activeCompensation:
      | { id: string; name: string; settled: boolean; failed: boolean; error?: unknown }
      | undefined;

    const handlerPromise = Promise.resolve()
      .then(() => definition.handler(source.input, runtime))
      .then(
        (result) => {
          mainSettled = true;
          mainResult = (result ?? undefined) as Json | undefined;
        },
        (error) => {
          mainSettled = true;
          mainFailed = true;
          mainError = error;
        }
      );
    handlerPromise.catch(() => undefined);

    try {
      while (true) {
        await drainMicrotasks();

        if (
          mainSettled &&
          mainFailed &&
          (mainError instanceof ReplayDivergenceError || mainError instanceof CorruptHistoryError)
        ) {
          throw mainError;
        }

        if (mainSettled && mainFailed && isDeterminismViolation(mainError)) {
          throw mainError;
        }

        if (mainSettled && mainFailed && !cleanupStarted) {
          cleanupStarted = true;
          await drainMicrotasks();
          for (const timerId of [...pendingTimers.keys()]) {
            runtime.cancelTimer(timerId, 'timer cancelled by workflow failure');
          }
          for (const activityId of [...pendingActivities.keys()]) {
            runtime.cancelActivity(activityId, 'cancelled by workflow failure');
          }
          await drainMicrotasks();
        }

        if (
          mainSettled &&
          !mainFailed &&
          pendingActivities.size === 0 &&
          pendingTimers.size === 0
        ) {
          const expected = requireNextEvent();
          if (expected.type !== 'WorkflowCompleted') {
            throw makeDivergence(
              events,
              expected.seq,
              commandForEvent(expected),
              null,
              'new code completed without issuing the next historical command'
            );
          }
          const historicalResult = (expected.payload.result ?? undefined) as Json | undefined;
          if (JSON.stringify(historicalResult ?? null) !== JSON.stringify(mainResult ?? null)) {
            throw makeDivergence(
              events,
              expected.seq,
              { type: 'workflow-result', payload: { result: historicalResult ?? null } },
              { type: 'workflow-result', payload: { result: mainResult ?? null } },
              'workflow result differs'
            );
          }
          consumeExpected(expected);
          consumedThroughSeq = pointer;
          break;
        }

        if (
          mainFailed &&
          cleanupStarted &&
          pendingActivities.size === 0 &&
          pendingTimers.size === 0
        ) {
          if (!activeCompensation) {
            if (compensationIndex === -1) compensationIndex = runtime.compensations.length - 1;
            if (compensationIndex < 0) {
              finishFailure();
              break;
            }
            startCompensation(runtime.compensations[compensationIndex]);
          }

          if (activeCompensation) {
            advanceEffectsUntilCompensationTerminal();
            await drainMicrotasks();
            if (!activeCompensation.settled) {
              throw corrupt(events, pointerEvent()?.seq ?? null, 'compensation terminal arrived but compensation code did not settle');
            }

            const terminalEventItem = events[pointer - 1];
            const expectedFailure =
              terminalEventItem?.type === 'CompensationFailed'
                ? failureFromEvent(terminalEventItem)
                : null;
            const actualFailure = activeCompensation.failed
              ? failureInfo(activeCompensation.error)
              : null;
            if (Boolean(expectedFailure) !== Boolean(actualFailure)) {
              throw makeDivergence(
                events,
                terminalEventItem?.seq ?? pointer,
                commandForEvent(terminalEventItem),
                null,
                'compensation terminal differs'
              );
            }
            if (
              expectedFailure &&
              actualFailure &&
              (expectedFailure.name !== actualFailure.name ||
                expectedFailure.message !== actualFailure.message)
            ) {
              throw makeDivergence(
                events,
                terminalEventItem!.seq,
                { type: 'compensation-failure', payload: expectedFailure as unknown as Json },
                { type: 'compensation-failure', payload: actualFailure as unknown as Json },
                'compensation failure differs'
              );
            }

            activeCompensation = undefined;
            compensationIndex -= 1;
          }
          continue;
        }

        advanceEffectsUntilCommand();
        await drainMicrotasks();
      }

      finalState = reduceEvents(events.slice(0, consumedThroughSeq));
      return makeResult('matched');
    } catch (error) {
      consumedThroughSeq = Math.max(consumedThroughSeq, pointer);
      finalState = reduceEvents(events.slice(0, consumedThroughSeq));
      if (error instanceof ReplayDivergenceError) {
        return makeResult('diverged', { divergence: error.divergence });
      }
      if (isDeterminismViolation(error)) {
        return makeResult('determinism-violation', {
          determinismViolation: {
            seq: events[pointer]?.seq ?? consumedThroughSeq,
            message: error.message,
            source: error.source,
          },
        });
      }
      if (error instanceof CorruptHistoryError) {
        return makeResult('corrupt', { corruption: corruptionFromError(events, error) });
      }
      throw error;
    }

    function pointerEvent(): WorkflowEvent | undefined {
      return events[pointer];
    }

    function requireNextEvent(): WorkflowEvent {
      const event = events[pointer];
      if (!event) throw corrupt(events, null, 'history is truncated');
      return event;
    }

    function consumeExpected(event: WorkflowEvent): void {
      state = applyEvent(state, event);
      pointer += 1;
      consumedThroughSeq = pointer;
    }

    function finishFailure(): void {
      const expected = requireNextEvent();
      if (expected.type !== 'WorkflowFailed') {
        throw makeDivergence(
          events,
          expected.seq,
          commandForEvent(expected),
          null,
          'new code failed but history did not terminate there'
        );
      }
      consumeExpected(expected);
    }

    function startCompensation(registration: {
      compensationId: string;
      name: string;
      fn: (context: never) => Promise<void> | void;
    }): void {
      const started = requireNextEvent();
      if (
        started.type !== 'CompensationStarted' ||
        String(started.payload.compensationId) !== registration.compensationId
      ) {
        throw makeDivergence(
          events,
          started.seq,
          commandForEvent(started),
          null,
          `expected compensation ${registration.compensationId} to start`
        );
      }
      consumeExpected(started);
      const status: NonNullable<typeof activeCompensation> = {
        id: registration.compensationId,
        name: registration.name,
        settled: false,
        failed: false,
        error: undefined,
      };
      activeCompensation = status;
      Promise.resolve()
        .then(() =>
          registration.fn({
            activity: runtime.activity.bind(runtime),
            now: runtime.now.bind(runtime),
            random: runtime.random.bind(runtime),
          } as never)
        )
        .then(
          () => {
            status.settled = true;
          },
          (error) => {
            status.settled = true;
            status.failed = true;
            status.error = error;
          }
        );
    }

    function applyEffect(event: WorkflowEvent): void {
      state = applyEvent(state, event);
      const p = event.payload;
      const activityId = p.activityId === undefined ? undefined : String(p.activityId);
      const timerId = p.timerId === undefined ? undefined : String(p.timerId);

      switch (event.type) {
        case 'ActivityStarted':
        case 'ActivityRetryScheduled':
        case 'ActivityTerminalDiscarded':
        case 'TimerCancelRequested':
        case 'TimerCancelIgnored':
        case 'TimerFireDiscarded':
          break;
        case 'ActivityCompleted':
          pendingActivities.get(activityId!)?.resolve({ kind: 'completed', result: p.result });
          pendingActivities.delete(activityId!);
          break;
        case 'ActivityFailed':
          pendingActivities.get(activityId!)?.resolve({
            kind: 'failed',
            error: failureFromEvent(event),
          });
          pendingActivities.delete(activityId!);
          break;
        case 'ActivityTimedOut':
          pendingActivities.get(activityId!)?.resolve({
            kind: 'timedOut',
            error: failureFromEvent(event),
          });
          pendingActivities.delete(activityId!);
          break;
        case 'ActivityCancelled':
          pendingActivities.get(activityId!)?.resolve({
            kind: 'cancelled',
            reason: String(p.reason ?? 'activity cancelled'),
          });
          pendingActivities.delete(activityId!);
          break;
        case 'TimerFired':
        case 'TimerCancelled':
          pendingTimers.get(timerId!)?.resolve(
            event.type === 'TimerFired'
              ? { cancelled: false }
              : { cancelled: true, reason: String(p.reason ?? 'timer cancelled') }
          );
          pendingTimers.delete(timerId!);
          break;
        default:
          throw corrupt(events, event.seq, `unexpected effect event: ${event.type}`);
      }
    }

    function advanceEffects(stop: (event: WorkflowEvent) => boolean): void {
      while (pointer < events.length) {
        const event = events[pointer];
        if (isImperativeEvent(event) || stop(event)) return;
        applyEffect(event);
        consumeExpected(event);
        // Resolving a pending workflow promise may settle the handler; return to
        // the outer phase loop so completion/failure checks run before consuming
        // the workflow terminal event.
        if (
          event.type === 'ActivityCompleted' ||
          event.type === 'ActivityFailed' ||
          event.type === 'ActivityTimedOut' ||
          event.type === 'ActivityCancelled' ||
          event.type === 'TimerFired' ||
          event.type === 'TimerCancelled'
        ) {
          return;
        }
      }
    }

    function advanceEffectsUntilCommand(): void {
      advanceEffects((event) => isImperativeEvent(event));
      if (pointer >= events.length) {
        throw corrupt(events, null, 'history ended while workflow was still waiting');
      }
    }

    function advanceEffectsUntilCompensationTerminal(): void {
      advanceEffects((event) =>
        event.type === 'CompensationCompleted' || event.type === 'CompensationFailed'
      );
      if (pointer >= events.length) {
        throw corrupt(events, null, 'history is truncated before compensation terminal');
      }
      const terminalEventItem = events[pointer];
      if (String(terminalEventItem.payload.compensationId) !== activeCompensation?.id) {
        throw corrupt(
          events,
          terminalEventItem.seq,
          `compensation terminal belongs to ${String(
            terminalEventItem.payload.compensationId
          )}, expected ${activeCompensation?.id}`
        );
      }
      applyEffect(terminalEventItem);
      consumeExpected(terminalEventItem);
    }

    function buildHost(): RuntimeHost {
      return {
        emit(command) {
          let expectedEvent = events[pointer];
          if (!expectedEvent) {
            throw corrupt(events, null, 'history is truncated before the command emitted by new code');
          }
          if (!isImperativeEvent(expectedEvent)) {
            if (activeCompensation) advanceEffectsUntilCompensationTerminal();
            else advanceEffectsUntilCommand();
            expectedEvent = events[pointer];
            if (!expectedEvent) {
              throw corrupt(events, null, 'history is truncated before command');
            }
          }

          const commandSeq = expectedEvent.seq;
          const expectedCommand = commandForEvent(expectedEvent);
          if (!expectedCommand) {
            throw corrupt(events, commandSeq, `event ${expectedEvent.type} is not a command`);
          }
          if (!commandsEqual(expectedCommand, command)) {
            throw makeDivergence(
              events,
              commandSeq,
              expectedCommand,
              command,
              `command mismatch at event ${commandSeq}: expected ${expectedCommand.type}, actual ${command.type}`
            );
          }
          actualCommands.push({ seq: commandSeq, command });
          consumeExpected(expectedEvent);
          return commandSeq;
        },

        resolveVersion(commandSeq) {
          const event = events.find((item) => item.seq === commandSeq);
          if (!event || event.type !== 'WorkflowVersionMarked') {
            throw corrupt(events, commandSeq, 'missing version marker event');
          }
          const version = Number(event.payload.version);
          const min = Number(event.payload.minSupported);
          const max = Number(event.payload.maxSupported);
          if (!Number.isInteger(version) || version < min || version > max) {
            throw makeDivergence(
              events,
              commandSeq,
              commandForEvent(event),
              commandForEvent(event),
              `historical version ${version} is outside supported range ${min}..${max}`
            );
          }
          return version;
        },

        observeValue(commandSeq) {
          const event = events.find((item) => item.seq === commandSeq);
          if (!event || event.type !== 'RuntimeObserved') {
            throw corrupt(events, commandSeq, 'missing RuntimeObserved event');
          }
          const value = Number(event.payload.value);
          if (!Number.isFinite(value)) {
            throw corrupt(events, commandSeq, 'RuntimeObserved value is not a number');
          }
          return value;
        },

        activity(command) {
          const p = command.payload as Record<string, Json>;
          const activityId = String(p.activityId);
          return new Promise<ActivityTerminal>((resolve) => {
            pendingActivities.set(activityId, { resolve });
          });
        },

        timer(command) {
          const p = command.payload as Record<string, Json>;
          const timerId = String(p.timerId);
          return new Promise((resolve) => {
            pendingTimers.set(timerId, { resolve });
          });
        },

        cancelActivity(command) {
          const p = command.payload as Record<string, Json>;
          const activityId = String(p.activityId);
          return pendingActivities.has(activityId);
        },

        cancelTimer(command) {
          const p = command.payload as Record<string, Json>;
          const timerId = String(p.timerId);
          return pendingTimers.has(timerId);
        },
      };
    }
  });
}
