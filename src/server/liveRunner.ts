import { NativeDate } from './nativeGlobals';
import { failureInfo, isDeterminismViolation } from '../shared/errors';
import type {
  ActivityFailureInfo,
  ActivityOptions,
  Command,
  Json,
  RunOptions,
  RunRecord,
  WorkflowDefinition,
  WorkflowEvent,
} from '../shared/types';
import { ActivitySimulator, type PlannedActivityOutcome } from './activitySimulator';
import { installDeterminismGuards, runInDeterminismScope } from './determinism';
import { activityOptions, makeEvent, runtimeId } from './events';
import { createRandom32, hashSeed } from './prng';
import { DeterministicRuntime, type ActivityTerminal, type RuntimeHost } from './runtime';

installDeterminismGuards();

interface PendingOperation {
  resolve: (terminal: ActivityTerminal) => void;
}

interface PendingTimerOperation {
  resolve: (value: { cancelled: boolean; reason?: string }) => void;
}

interface HeapEntry {
  at: number;
  ordinal: number;
  run: () => void;
}

class MinHeap {
  private readonly entries: HeapEntry[] = [];

  push(entry: HeapEntry): void {
    this.entries.push(entry);
    this.bubbleUp(this.entries.length - 1);
  }

  size(): number {
    return this.entries.length;
  }

  peek(): HeapEntry | undefined {
    return this.entries[0];
  }

  pop(): HeapEntry {
    const first = this.entries[0];
    const last = this.entries.pop()!;
    if (this.entries.length > 0) {
      this.entries[0] = last;
      this.sinkDown(0);
    }
    return first;
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if (this.less(current, parent)) {
        this.swap(current, parent);
        current = parent;
      } else return;
    }
  }

  private sinkDown(index: number): void {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;
      if (left < this.entries.length && this.less(left, smallest)) smallest = left;
      if (right < this.entries.length && this.less(right, smallest)) smallest = right;
      if (smallest === current) return;
      this.swap(current, smallest);
      current = smallest;
    }
  }

  private less(a: number, b: number): boolean {
    const x = this.entries[a];
    const y = this.entries[b];
    return x.at < y.at || (x.at === y.at && x.ordinal < y.ordinal);
  }

  private swap(a: number, b: number): void {
    const tmp = this.entries[a];
    this.entries[a] = this.entries[b];
    this.entries[b] = tmp;
  }
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

function failureFromPlan(
  plan: PlannedActivityOutcome,
  activityId: string,
  activityName: string,
  attempt: number,
  timeout = false
): ActivityFailureInfo {
  return {
    name: timeout ? 'TimeoutError' : 'ActivityExecutionError',
    message: timeout
      ? `activity ${activityName} timed out after attempt ${attempt}`
      : plan.failureMessage,
    activityId,
    activityName,
    attempt,
    timeout,
  };
}

export interface LiveRunResult {
  record: RunRecord;
  commands: Array<{ seq: number; command: Command }>;
}

export async function runWorkflowLive(
  definition: WorkflowDefinition,
  input: Json,
  options: RunOptions = {},
  simulator: ActivitySimulator,
  previousRunId?: string
): Promise<LiveRunResult> {
    const runId = previousRunId ?? runtimeId('run');
    return runInDeterminismScope(`workflow:${definition.workflowType}:${definition.version}`, async () => {
    const startedAtMs = options.startTimeMs ?? 1_700_000_000_000;
    let now = startedAtMs;
    let seq = 0;
    let ordinal = 0;
    const events: WorkflowEvent[] = [];
    const commands: Array<{ seq: number; command: Command }> = [];
    const heap = new MinHeap();
    const pendingActivities = new Map<string, PendingOperation>();
    const activityTerminal = new Map<string, string>();
    const pendingTimers = new Map<string, PendingTimerOperation>();
    const timerTerminal = new Map<string, string>();
    const random = createRandom32(options.seed ?? hashSeed(runId));

    const append = (
      type: WorkflowEvent['type'],
      payload: Record<string, Json> = {},
      commandSeq?: number
    ): WorkflowEvent => {
      seq += 1;
      const event = makeEvent(seq, type, now, payload, commandSeq);
      events.push(event);
      return event;
    };

    append('WorkflowStarted', {
      workflowType: definition.workflowType,
      version: definition.version,
      input,
    });

    const runtime = new DeterministicRuntime({
      emit(command) {
        const commandSeq = seq + 1;
        commands.push({ seq: commandSeq, command });
        const p = command.payload as Record<string, Json>;
        switch (command.type) {
          case 'activity':
            append(
              'ActivityScheduled',
              {
                activityId: p.activityId,
                activityName: p.activityName,
                input: p.input,
                options: p.options,
                attempt: 1,
              },
              commandSeq
            );
            break;
          case 'start-timer':
            append(
              'TimerStarted',
              {
                timerId: p.timerId,
                durationMs: p.durationMs,
                scheduledForMs: now + Number(p.durationMs),
              },
              commandSeq
            );
            break;
          case 'cancel-activity':
            append(
              'ActivityCancelRequested',
              { activityId: p.activityId, reason: p.reason ?? null },
              commandSeq
            );
            break;
          case 'cancel-timer':
            append(
              'TimerCancelRequested',
              { timerId: p.timerId, reason: p.reason ?? null },
              commandSeq
            );
            break;
          case 'register-compensation':
            append(
              'CompensationRegistered',
              { compensationId: p.compensationId, name: p.name },
              commandSeq
            );
            break;
          case 'mark-version':
            append(
              'WorkflowVersionMarked',
              {
                changeId: p.changeId,
                minSupported: p.minSupported,
                maxSupported: p.maxSupported,
                version: p.version,
              },
              commandSeq
            );
            break;
          case 'observe-runtime':
            append('RuntimeObserved', { ...p }, commandSeq);
            break;
        }
        return commandSeq;
      },

      resolveVersion(commandSeq) {
        return Number(events.find((event) => event.seq === commandSeq)!.payload.version);
      },

      observeValue(commandSeq) {
        const event = events.find((item) => item.seq === commandSeq)!;
        let value: number;
        if (event.payload.kind === 'now') value = now;
        else value = random();
        event.payload.value = value;
        return value;
      },

      activity(command, commandSeq) {
        const p = command.payload as Record<string, Json>;
        const activityId = String(p.activityId);
        const activityName = String(p.activityName);
        const resolvedOptions: Required<ActivityOptions> = activityOptions(
          p.options as never
        ) as Required<ActivityOptions>;
        return new Promise<ActivityTerminal>((resolve) => {
          pendingActivities.set(activityId, { resolve });
          let currentAttempt = 1;
          scheduleAttempt(1);

          function scheduleAttempt(attempt: number): void {
            const plan = simulator.plan(
              activityName,
              attempt,
              options.activityOverrides
            );
            append('ActivityStarted', {
            activityId,
            activityName,
            attempt,
            timeoutMs: resolvedOptions.startToCloseTimeoutMs,
          });

          let terminalAt = now + plan.delayMs;
          if (plan.behavior === 'timeout') {
            terminalAt = now + resolvedOptions.startToCloseTimeoutMs;
          }
          if (attempt === 1 && plan.race !== 'none') {
            const planReference = plan;
            heap.push({
              at: terminalAt,
              ordinal:
                planReference.race === 'lateCancel'
                  ? Number.MAX_SAFE_INTEGER
                  : Number.MIN_SAFE_INTEGER,
              run: () => {
                deliverTerminal(
                  attempt,
                  {
                    kind: 'cancelled',
                    reason: `simulated ${planReference.race} cancellation`,
                  },
                  'cancelled',
                  planReference,
                  Number.MAX_SAFE_INTEGER
                );
              },
            });
          }
          const attemptOrdinal = ordinal++;
          heap.push({
            at: terminalAt,
            ordinal: attemptOrdinal,
            run: () => {
              if (currentAttempt !== attempt) return;
              completeAttempt(attempt, plan, attemptOrdinal);
            },
          });

          heap.push({
            at: now + resolvedOptions.startToCloseTimeoutMs,
            ordinal: ordinal++,
            run: () => {
              if (currentAttempt !== attempt || activityTerminal.has(activityId)) return;
              if (plan.behavior === 'timeout' || terminalAt >= now + resolvedOptions.startToCloseTimeoutMs) {
                deliverTerminal(
                  attempt,
                  {
                    kind: 'timedOut',
                    error: failureFromPlan(plan, activityId, activityName, attempt, true),
                  },
                  'timedOut',
                  plan,
                  attemptOrdinal
                );
              }
            },
          });
        }

        function completeAttempt(
          attempt: number,
          plan: PlannedActivityOutcome,
          completionOrdinal: number
        ): void {
          if (plan.behavior === 'success') {
            deliverTerminal(
              attempt,
              { kind: 'completed', result: plan.result },
              'completed',
              plan,
              completionOrdinal
            );
            return;
          }
          deliverTerminal(
            attempt,
            {
              kind: 'failed',
              error: failureFromPlan(plan, activityId, activityName, attempt),
            },
            'failed',
            plan,
            completionOrdinal
          );
        }

        function deliverTerminal(
          attempt: number,
          terminal: ActivityTerminal,
          kind: string,
          plan: PlannedActivityOutcome,
          completionOrdinal: number
        ): void {
          if (activityTerminal.has(activityId)) {
            append('ActivityTerminalDiscarded', {
              activityId,
              activityName,
              attempt,
              kind,
              reason: `terminal arrived after ${activityTerminal.get(activityId)}`,
            });
            return;
          }

          const retryable =
            kind === 'failed' || kind === 'timedOut'
              ? attempt < resolvedOptions.maxAttempts
              : false;
          if (retryable) {
            append('ActivityRetryScheduled', {
              activityId,
              activityName,
              attempt,
              nextAttempt: attempt + 1,
            });
            const backoff = Math.min(
              resolvedOptions.maxIntervalMs,
              resolvedOptions.initialIntervalMs *
                resolvedOptions.backoffCoefficient ** (attempt - 1)
            );
            heap.push({
              at: now + backoff,
              ordinal: ordinal++,
              run: () => {
                currentAttempt = attempt + 1;
                scheduleAttempt(attempt + 1);
              },
            });
            return;
          }

          activityTerminal.set(activityId, kind);
          if (terminal.kind === 'completed') {
            append(
              'ActivityCompleted',
              {
                activityId,
                activityName,
                attempt,
                result: terminal.result,
              },
              undefined
            );
          } else if (terminal.kind === 'timedOut') {
            append('ActivityTimedOut', {
              activityId,
              activityName,
              attempt,
              error: terminal.error as unknown as Json,
            });
          } else if (terminal.kind === 'cancelled') {
            append('ActivityCancelled', {
              activityId,
              activityName,
              attempt,
              reason: terminal.reason,
            });
          } else {
            append('ActivityFailed', {
              activityId,
              activityName,
              attempt,
              error: terminal.error as unknown as Json,
            });
          }
          pendingActivities.get(activityId)?.resolve(terminal);
          pendingActivities.delete(activityId);
          void completionOrdinal;
          void plan;
        }
        });
      },

      timer(command) {
        const p = command.payload as Record<string, Json>;
        const timerId = String(p.timerId);
        return new Promise((resolve) => {
          pendingTimers.set(timerId, { resolve });
          heap.push({
            at: now + Number(p.durationMs),
            ordinal: ordinal++,
            run: () => {
              if (timerTerminal.has(timerId)) {
                append('TimerFireDiscarded', {
                  timerId,
                  reason: 'timer fired after cancellation',
                });
                return;
              }
              timerTerminal.set(timerId, 'fired');
              append('TimerFired', { timerId });
              pendingTimers.get(timerId)?.resolve({ cancelled: false });
              pendingTimers.delete(timerId);
            },
          });
        });
      },

      cancelActivity(command) {
        const p = command.payload as Record<string, Json>;
        const activityId = String(p.activityId);
        const reason = String(p.reason ?? 'cancelled by workflow');
        if (activityTerminal.has(activityId) || !pendingActivities.has(activityId)) {
          append('ActivityTerminalDiscarded', {
            activityId,
            kind: 'cancelled',
            reason: 'cancellation arrived after terminal state',
          });
          return;
        }
        heap.push({
          at: now,
          ordinal: ordinal++,
          run: () => {
            if (activityTerminal.has(activityId)) {
              append('ActivityTerminalDiscarded', {
                activityId,
                kind: 'cancelled',
                reason: 'cancellation arrived after terminal state',
              });
              return;
            }
            activityTerminal.set(activityId, 'cancelled');
            append('ActivityCancelled', {
              activityId,
              reason,
            });
            const terminal: ActivityTerminal = { kind: 'cancelled', reason };
            pendingActivities.get(activityId)?.resolve(terminal);
            pendingActivities.delete(activityId);
          },
        });
      },

      cancelTimer(command) {
        const p = command.payload as Record<string, Json>;
        const timerId = String(p.timerId);
        const reason = String(p.reason ?? 'timer cancelled by workflow');
        if (timerTerminal.has(timerId) || !pendingTimers.has(timerId)) {
          append('TimerCancelIgnored', { timerId, reason });
          return false;
        }
        timerTerminal.set(timerId, 'cancelled');
        append('TimerCancelled', { timerId, reason });
        pendingTimers.get(timerId)?.resolve({ cancelled: true, reason });
        pendingTimers.delete(timerId);
        return true;
      },
    });

    let mainResult: Json | undefined;
    let mainError: unknown;
    let mainSettled = false;
    let mainFailed = false;
    let cleanupStarted = false;

    const handlerPromise = Promise.resolve()
      .then(() => definition.handler(input, runtime))
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

    while (true) {
      await drainMicrotasks();

      if (mainSettled && mainFailed && isDeterminismViolation(mainError)) {
        throw mainError;
      }

      if (mainSettled && mainFailed && !cleanupStarted) {
        cleanupStarted = true;
        // Give a rejection handler one more microtask to issue explicit cancellations.
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
        pendingTimers.size === 0 &&
        heap.size() === 0
      ) {
        append('WorkflowCompleted', { result: mainResult ?? null });
        break;
      }

      if (
        mainSettled &&
        !mainFailed &&
        pendingActivities.size === 0 &&
        pendingTimers.size === 0 &&
        heap.size() > 0
      ) {
        // External completion/cancellation races can already be known at the same
        // timestamp. Drain their discarded terminals before sealing workflow
        // history, but do not advance logical time into unrelated future work.
        const settleAt = heap.peek()!.at;
        while (heap.size() > 0 && heap.peek()?.at === settleAt) {
          heap.pop().run();
          await drainMicrotasks();
        }
        continue;
      }

      if (
        mainFailed &&
        cleanupStarted &&
        pendingActivities.size === 0 &&
        pendingTimers.size === 0
      ) {
        const compensationFailures: ActivityFailureInfo[] = [];
        for (const compensation of [...runtime.compensations].reverse()) {
          append('CompensationStarted', {
            compensationId: compensation.compensationId,
            name: compensation.name,
          });
          try {
            await compensation.fn({
              activity: runtime.activity.bind(runtime),
              now: runtime.now.bind(runtime),
              random: runtime.random.bind(runtime),
            });
            append('CompensationCompleted', {
              compensationId: compensation.compensationId,
              name: compensation.name,
            });
          } catch (error) {
            const info = failureInfo(error);
            compensationFailures.push({ ...info, compensation: compensation.name });
            append('CompensationFailed', {
              compensationId: compensation.compensationId,
              name: compensation.name,
              error: info as unknown as Json,
            });
          }
          await drainMicrotasks();
        }

        const info = failureInfo(mainError);
        append('WorkflowFailed', {
          error: {
            ...info,
            compensationFailures,
          } as unknown as Json,
        });
        break;
      }

      const nextEntry = heap.peek();
      if (!nextEntry) {
        // A live simulation always schedules pending work. Keep the process safe
        // rather than spinning if a future implementation adds an endless promise.
        throw new Error('Workflow is waiting but has no scheduled event');
      }
      if (nextEntry.at > now) now = nextEntry.at;
      const dueAt = nextEntry.at;
      while (heap.size() > 0 && heap.peek()?.at === dueAt) {
        heap.pop().run();
        await drainMicrotasks();
      }
    }

    const terminalEvents = events.filter(
      (event) => event.type === 'WorkflowFailed' || event.type === 'WorkflowCompleted'
    );
    const terminalEventItem = terminalEvents[terminalEvents.length - 1];
    const failedEvent = terminalEventItem?.type === 'WorkflowFailed' ? terminalEventItem : undefined;
    const completedEvent =
      terminalEventItem?.type === 'WorkflowCompleted' ? terminalEventItem : undefined;
    const endMs = events[events.length - 1]?.atMs ?? startedAtMs;
    const record: RunRecord = {
      runId,
      workflowType: definition.workflowType,
      version: definition.version,
      status: failedEvent ? 'failed' : 'completed',
      startedAtMs,
      endedAtMs: endMs,
      input,
      options,
      events,
      result: completedEvent
        ? (completedEvent.payload.result as Json)
        : undefined,
      error: failedEvent
        ? (failedEvent.payload.error as ActivityFailureInfo)
        : undefined,
      createdAt: new NativeDate(endMs).toISOString(),
    };

    return { record, commands };
  });
}
