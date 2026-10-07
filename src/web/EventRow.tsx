import type { HistoryEvent } from '../shared/types.js';

function eventDotClass(ev: HistoryEvent): string {
  switch (ev.type) {
    case 'ActivityCompleted':
    case 'WorkflowCompleted':
    case 'CompensationSucceeded':
      return 'terminal-ok';
    case 'WorkflowFailed':
    case 'ActivityTimedOut':
    case 'ActivityCancelled':
    case 'CompensationFailed':
      return 'terminal-bad';
    case 'ActivityTerminalIgnored':
      return 'ignored';
    case 'ActivityStarted':
    case 'ActivityAttemptFailed':
    case 'TimerFired':
    case 'TimerCancelled':
      return 'runtime';
    default:
      return 'command';
  }
}

function subtitle(ev: HistoryEvent): string {
  switch (ev.type) {
    case 'WorkflowStarted':
      return `${ev.workflowType}@${ev.version}`;
    case 'WorkflowCompleted':
      return JSON.stringify(ev.result);
    case 'WorkflowFailed':
      return `${ev.error.name}: ${ev.error.message}`;
    case 'ActivityScheduled':
      return `#${ev.activityId} ${ev.activityType}${ev.compensationId !== undefined ? ' （补偿）' : ''} ${JSON.stringify(ev.input)}`;
    case 'ActivityStarted':
      return `#${ev.activityId} 尝试 ${ev.attempt}`;
    case 'ActivityAttemptFailed':
      return `#${ev.activityId} 尝试 ${ev.attempt} ${ev.kind} ${ev.error.message}${ev.backoffMs ? `，退避 ${ev.backoffMs}ms` : ''}`;
    case 'ActivityCompleted':
      return `#${ev.activityId} 尝试 ${ev.attempt} → ${JSON.stringify(ev.result)}`;
    case 'ActivityTimedOut':
      return `#${ev.activityId} 尝试 ${ev.attempt} 超时`;
    case 'ActivityCancelled':
      return `#${ev.activityId} 尝试 ${ev.attempt} 已取消`;
    case 'ActivityTerminalIgnored':
      return `#${ev.activityId} 尝试 ${ev.attempt} 丢弃 ${ev.ignored}`;
    case 'TimerScheduled':
      return `#${ev.timerId} ${ev.durationMs}ms`;
    case 'TimerFired':
    case 'TimerCancelled':
      return `#${ev.timerId}`;
    case 'CompensationRegistered':
      return `#${ev.compensationId} ${ev.label}（活动 #${ev.afterActivitySeq}）`;
    case 'CompensationSucceeded':
    case 'CompensationFailed':
      return `#${ev.compensationId}`;
    case 'VersionMarker':
      return `${ev.changeId} = v${ev.version}`;
    case 'RandomConsumed':
      return ev.value.toFixed(4);
    case 'NowSampled':
      return `${ev.nowMs}ms`;
    case 'DeterminismViolation':
      return ev.kind;
    default:
      return '';
  }
}

export function EventRow({
  ev,
  current,
  beyond,
  marked,
  onClick,
}: {
  ev: HistoryEvent;
  current: boolean;
  beyond: boolean;
  marked?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`event-row${current ? ' current' : ''}${beyond ? ' beyond' : ''}`}
      onClick={onClick}
      title={ev.type}
    >
      <span className="seq">{ev.seq}</span>
      <span className={`dot ${eventDotClass(ev)}`} style={marked ? { boxShadow: '0 0 0 2px var(--red)' } : undefined} />
      <span>
        <span className="ev-title">
          {ev.type}
          {marked ? '  ⬅ 第一个分歧点' : ''}
        </span>
        <span className="ev-at">t={ev.at}ms</span>
        <div className="ev-sub">{subtitle(ev)}</div>
      </span>
    </div>
  );
}
