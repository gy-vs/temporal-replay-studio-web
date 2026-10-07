import type { CorruptionIssue, HistoryEvent } from '../../shared/types.js';
import { COMMAND_EVENT_TYPES, RUNTIME_EVENT_TYPES } from '../../shared/types.js';

const COMMAND_TYPES = new Set<string>(COMMAND_EVENT_TYPES);
const RUNTIME_TYPES = new Set<string>(RUNTIME_EVENT_TYPES);

/** Known terminal-bearing runtime events per activity attempt. */
const ACTIVITY_RUNTIME = new Set([
  'ActivityAttemptFailed',
  'ActivityCompleted',
  'ActivityTimedOut',
  'ActivityCancelled',
  'ActivityTerminalIgnored',
]);

interface ActivityRec {
  seq: number;
  attempts: Map<number, { events: HistoryEvent[]; hasTerminal: boolean }>;
}

/**
 * Structural validation of a history, done before replay. A corrupt history
 * produces a list of issues instead of ever crashing the replay process.
 */
export function validateHistory(history: unknown): CorruptionIssue[] {
  const issues: CorruptionIssue[] = [];
  const issue = (
    seq: number | null,
    code: CorruptionIssue['code'],
    message: string,
  ) => issues.push({ seq, code, message });

  if (!Array.isArray(history)) {
    issue(null, 'MALFORMED_EVENT', '历史不是数组');
    return issues;
  }
  if (history.length === 0) {
    issue(null, 'EMPTY_HISTORY', '历史为空，无法重放');
    return issues;
  }

  // ---- per-event shape + seq continuity ----------------------------------
  const seenSeqs = new Set<number>();
  history.forEach((raw, i) => {
    const seqGuess = typeof raw === 'object' && raw !== null && Number.isFinite((raw as { seq?: unknown }).seq as number)
      ? ((raw as { seq: number }).seq as number)
      : null;
    if (typeof raw !== 'object' || raw === null) {
      issue(seqGuess, 'MALFORMED_EVENT', `位置 ${i + 1} 的事件不是对象`);
      return;
    }
    const ev = raw as Record<string, unknown>;
    if (typeof ev.type !== 'string') {
      issue(seqGuess, 'MALFORMED_EVENT', `位置 ${i + 1} 的事件缺少 type`);
      return;
    }
    if (!COMMAND_TYPES.has(ev.type) && !RUNTIME_TYPES.has(ev.type)) {
      issue(seqGuess, 'UNKNOWN_EVENT_TYPE', `未知事件类型：${ev.type}`);
    }
    if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq)) {
      issue(seqGuess, 'MALFORMED_EVENT', `事件 ${ev.type} 的 seq 不是整数`);
      return;
    }
    if (typeof ev.at !== 'number') {
      issue(ev.seq, 'MALFORMED_EVENT', `事件 #${ev.seq} (${ev.type}) 缺少时间戳 at`);
    }
    if (seenSeqs.has(ev.seq)) {
      issue(ev.seq, 'DUPLICATE_SEQ', `序号 ${ev.seq} 重复`);
    }
    seenSeqs.add(ev.seq);
  });

  const typed = history.filter(
    (e): e is HistoryEvent =>
      typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string',
  );

  // seq order / gap check (expects 1..N contiguous)
  typed.forEach((ev, i) => {
    if (ev.seq !== i + 1) {
      if (ev.seq > i + 1) issue(ev.seq, 'SEQ_GAP', `序号跳号：期望 ${i + 1}，实际 ${ev.seq}`);
      // duplicates/out-of-order lower seqs are already flagged above
    }
  });

  const first = typed[0];
  if (!first || first.type !== 'WorkflowStarted') {
    issue(first?.seq ?? null, 'FIRST_EVENT_NOT_STARTED', '历史第一个事件必须是 WorkflowStarted');
  }

  // ---- cross-reference tables --------------------------------------------
  const activities = new Map<number, ActivityRec>();
  const timers = new Map<number, HistoryEvent[]>();
  const compensations = new Map<number, HistoryEvent[]>();

  const refActivity = (ev: HistoryEvent, id: number): boolean => {
    if (!activities.has(id)) {
      issue(ev.seq, 'UNKNOWN_ACTIVITY', `事件 #${ev.seq} (${ev.type}) 引用了不存在的活动 #${id}`);
      return false;
    }
    return true;
  };

  let workflowTerminals = 0;
  for (const ev of typed) {
    switch (ev.type) {
      case 'WorkflowCompleted':
      case 'WorkflowFailed':
        workflowTerminals++;
        break;

      case 'ActivityScheduled': {
        if (activities.has(ev.activityId)) {
          issue(ev.seq, 'DUPLICATE_SEQ', `活动 id ${ev.activityId} 被重复登记`);
        }
        activities.set(ev.activityId, { seq: ev.seq, attempts: new Map() });
        if (ev.compensationId !== undefined && !compensations.has(ev.compensationId) && ev.seq > 1) {
          // Compensation activity referencing a not-yet-registered compensation
          // is checked once all events are parsed; skip here.
        }
        break;
      }

      case 'ActivityStarted':
      case 'ActivityAttemptFailed':
      case 'ActivityCompleted':
      case 'ActivityTimedOut':
      case 'ActivityCancelled':
      case 'ActivityTerminalIgnored': {
        if (!refActivity(ev, ev.activityId)) break;
        const rec = activities.get(ev.activityId)!;
        if (!rec.attempts.has(ev.attempt)) rec.attempts.set(ev.attempt, { events: [], hasTerminal: false });
        const a = rec.attempts.get(ev.attempt)!;
        a.events.push(ev);
        if (
          ev.type === 'ActivityCompleted' ||
          ev.type === 'ActivityTimedOut' ||
          ev.type === 'ActivityCancelled'
        ) {
          if (a.hasTerminal) {
            issue(ev.seq, 'DUPLICATE_TERMINAL', `活动 #${ev.activityId} 尝试 ${ev.attempt} 出现多个终态事件`);
          }
          a.hasTerminal = true;
        }
        break;
      }

      case 'TimerScheduled':
        timers.set(ev.timerId, [ev]);
        break;
      case 'TimerFired':
      case 'TimerCancelled':
        if (!timers.has(ev.timerId)) {
          issue(ev.seq, 'UNKNOWN_TIMER', `事件 #${ev.seq} 引用了不存在的计时器 #${ev.timerId}`);
        } else {
          timers.get(ev.timerId)!.push(ev);
        }
        break;

      case 'CompensationRegistered':
        compensations.set(ev.compensationId, [ev]);
        if (ev.afterActivitySeq !== 0) {
          const target = typed.find((x) => x.seq === ev.afterActivitySeq);
          if (!target || (target.type !== 'ActivityScheduled' && target.type !== 'ActivityCompleted')) {
            issue(ev.seq, 'ORPHAN_COMPENSATION', `补偿 #${ev.compensationId} 引用的活动事件 #${ev.afterActivitySeq} 不存在`);
          }
        }
        break;
      case 'CompensationSucceeded':
      case 'CompensationFailed':
        if (!compensations.has(ev.compensationId)) {
          issue(ev.seq, 'UNKNOWN_COMPENSATION', `事件 #${ev.seq} 引用了不存在的补偿 #${ev.compensationId}`);
        } else {
          compensations.get(ev.compensationId)!.push(ev);
        }
        break;

      case 'VersionMarker':
        if (typeof ev.changeId !== 'string' || typeof ev.version !== 'number') {
          issue(ev.seq, 'MALFORMED_EVENT', `版本标记 #${ev.seq} 字段不完整`);
        }
        break;
    }
  }

  if (workflowTerminals === 0) {
    issue(null, 'TRUNCATED', '历史在 WorkflowCompleted/WorkflowFailed 之前结束（被截断）');
  } else if (workflowTerminals > 1) {
    issue(null, 'MALFORMED_EVENT', `历史包含 ${workflowTerminals} 个工作流终态事件`);
  }

  // ---- lifecycle consistency ---------------------------------------------
  for (const [id, rec] of activities) {
    const attemptNos = [...rec.attempts.keys()].sort((a, b) => a - b);
    let prev: number | null = null;
    for (const n of attemptNos) {
      if (prev !== null && n !== prev + 1) {
        issue(rec.seq, 'INVALID_ATTEMPT_LIFECYCLE', `活动 #${id} 的尝试序号不连续：${prev} -> ${n}`);
      }
      const a = rec.attempts.get(n)!;
      const firstEv = a.events[0];
      if (firstEv.type !== 'ActivityStarted') {
        issue(firstEv.seq, 'INVALID_ATTEMPT_LIFECYCLE', `活动 #${id} 尝试 ${n} 缺少 ActivityStarted`);
      }
      // started must precede the rest; terminal ordering within attempt
      const startedSeq = a.events.find((e) => e.type === 'ActivityStarted')?.seq;
      for (const ev of a.events) {
        if (ev.type !== 'ActivityStarted' && startedSeq !== undefined && ev.seq < startedSeq) {
          issue(ev.seq, 'INVALID_ATTEMPT_LIFECYCLE', `活动 #${id} 尝试 ${n} 的 ${ev.type} 早于 ActivityStarted`);
        }
      }
      // after a terminal, only ignored events are allowed (duplicate terminal
      // itself already flagged); a new attempt's started is fine.
      prev = n;
    }
    void ACTIVITY_RUNTIME;
  }

  for (const [id, evs] of timers) {
    const after = evs.slice(1);
    if (after.length > 1) {
      issue(after[1].seq, 'DUPLICATE_TERMINAL', `计时器 #${id} 有多个结束事件`);
    }
  }
  for (const [id, evs] of compensations) {
    // A registration with no result is normal: the compensation simply never
    // ran because the workflow succeeded. Only demand a compensation activity
    // when a result event exists.
    const hasResult = evs.length > 1;
    if (hasResult) {
      const after = evs.slice(1);
      if (after.length > 1) {
        issue(after[1].seq, 'DUPLICATE_TERMINAL', `补偿 #${id} 有多个结果事件`);
      }
      const hasActivity = typed.some(
        (e) => e.type === 'ActivityScheduled' && e.compensationId === id,
      );
      if (!hasActivity) {
        issue(evs[0].seq, 'UNRESOLVED_AFTER_TERMINAL', `补偿 #${id} 有结果事件但找不到对应的补偿活动`);
      }
    }
  }

  // Activities referenced by compensationOf must be scheduled events.
  for (const ev of typed) {
    if (ev.type === 'ActivityScheduled' && ev.compensationId !== undefined) {
      if (!compensations.has(ev.compensationId)) {
        issue(ev.seq, 'UNKNOWN_COMPENSATION', `补偿活动 #${ev.activityId} 引用不存在的补偿 #${ev.compensationId}`);
      }
    }
  }

  return issues;
}
