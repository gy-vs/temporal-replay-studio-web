import type {
  Divergence,
  HistoryEvent,
  ReplayNote,
  ReplayReport,
} from '../shared/types.js';
import type { Projection } from './projection.js';

function Json({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <pre className="json">{text}</pre>;
}

function ActivityCards({ items, title }: { items: Projection['pendingActivities']; title: string }) {
  if (items.length === 0) return null;
  return (
    <div className="section">
      <h3>{title}（{items.length}）</h3>
      {items.map((a) => (
        <div className="card" key={a.activityId}>
          <div className="row">
            <span className="mono">#{a.activityId} {a.activityType}</span>
            <span className={`badge ${a.status}`}>{a.status}</span>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            尝试 {Math.max(a.attempt, 1)}
            {a.compensationId !== undefined ? ` · 补偿 #${a.compensationId}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

function DivergencePanel({ d }: { d: Divergence }) {
  return (
    <div className="banner diverges">
      <div className="msg">发现分歧{d.atSeq ? `（事件 #${d.atSeq}）` : ''}</div>
      <div>{d.message}</div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h3 style={{ color: 'var(--muted)' }}>历史期望</h3>
          <Json value={d.expected.event ?? { pending: d.expected.pending }} />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h3 style={{ color: 'var(--muted)' }}>新代码实际发出</h3>
          <Json value={d.actual} />
        </div>
      </div>
    </div>
  );
}

export function StatePanel({
  projection,
  replay,
  findings,
  currentEvent,
}: {
  projection: Projection;
  replay: ReplayReport | null;
  findings: { kind: string; message: string; line?: number }[];
  currentEvent: HistoryEvent | null;
}) {
  const notes = replay?.notes ?? [];
  return (
    <div>
      {replay?.status === 'matches' && (
        <div className="banner matches">
          <div className="msg">✓ 重放一致：新代码对这段历史做出的决定与旧代码完全相同</div>
          {notes.length > 0 && <div className="muted">{notes.length} 条兼容说明（版本标记/丢弃的终态）</div>}
        </div>
      )}
      {replay?.status === 'diverges' && replay.divergence && (
        <DivergencePanel d={replay.divergence} />
      )}
      {replay?.status === 'corrupt' && (
        <div className="banner corrupt">
          <div className="msg">历史已损坏，重放未执行（进程安全返回）</div>
          <div className="muted" style={{ margin: '4px 0' }}>
            {replay.corruption.length} 个结构问题，例如：{replay.corruption[0]?.message}
          </div>
          <Json value={replay.corruption} />
        </div>
      )}

      <div className="section">
        <h3>工作流状态</h3>
        <div className="card">
          <div className="row">
            <span className="muted">状态</span>
            <span className={`badge ${projection.workflowStatus === 'completed' ? 'completed' : projection.workflowStatus === 'failed' ? 'failed' : 'running'}`}>
              {projection.workflowStatus === 'running' ? '运行中' : projection.workflowStatus === 'completed' ? '已完成' : '已失败'}
            </span>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">虚拟时钟</span>
            <span className="mono">{projection.clock}ms</span>
          </div>
          {projection.result !== undefined && (
            <>
              <h3 style={{ marginTop: 10 }}>结果</h3>
              <Json value={projection.result} />
            </>
          )}
          {projection.error !== undefined && (
            <>
              <h3 style={{ marginTop: 10 }}>错误</h3>
              <Json value={projection.error} />
            </>
          )}
        </div>
      </div>

      <ActivityCards items={projection.pendingActivities} title="待执行 / 进行中的命令" />
      {projection.pendingTimers.length > 0 && (
        <div className="section">
          <h3>等待中的计时器（{projection.pendingTimers.length}）</h3>
          {projection.pendingTimers.map((t) => (
            <div className="card row" key={t.timerId}>
              <span className="mono">#{t.timerId} sleep {t.durationMs}ms</span>
              <span className="muted mono">t={t.fireAt}ms 触发</span>
            </div>
          ))}
        </div>
      )}

      {projection.compensations.length > 0 && (
        <div className="section">
          <h3>补偿（按注册相反顺序执行）</h3>
          {projection.compensations.map((c) => (
            <div className="card row" key={c.compensationId}>
              <span className="mono">#{c.compensationId} {c.label}</span>
              <span className={`badge ${c.status}`}>{c.status}</span>
            </div>
          ))}
        </div>
      )}

      <div className="section">
        <h3>已结束的活动（{projection.settledActivities.length}）</h3>
        {projection.settledActivities.length === 0 && <div className="muted">暂无</div>}
        {projection.settledActivities.map((a) => (
          <div className="card row" key={`done-${a.activityId}`}>
            <span className="mono">#{a.activityId} {a.activityType}</span>
            <span className={`badge ${a.status}`}>{a.status}</span>
          </div>
        ))}
      </div>

      {projection.versionMarkers.length > 0 && (
        <div className="section">
          <h3>版本标记</h3>
          {projection.versionMarkers.map((v) => (
            <div className="card row" key={v.seq}>
              <span className="mono">{v.changeId}</span>
              <span className="badge completed">v{v.version}</span>
            </div>
          ))}
        </div>
      )}

      <NotesSection notes={notes} ignored={projection.ignoredTerminals} />

      {findings.length > 0 && (
        <div className="section">
          <h3>注册时静态确定性检查（{findings.length}）</h3>
          <div className="card findings">
            {findings.map((f, i) => (
              <div key={i}>
                {f.line ? `第 ${f.line} 行 · ${f.kind}：` : `${f.kind}：`}{f.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {currentEvent && (
        <div className="section">
          <h3>当前事件 #{currentEvent.seq} 完整内容</h3>
          <Json value={currentEvent} />
        </div>
      )}
    </div>
  );
}

function NotesSection({ notes, ignored }: { notes: ReplayNote[]; ignored: number[] }) {
  const visible = notes.filter((n) => {
    if (n.kind !== 'ignoredTerminal') return true;
    return ignored.includes(n.seq);
  });
  if (visible.length === 0) return null;
  return (
    <div className="section notes">
      <h3>重放说明</h3>
      <div className="card">
        {visible.map((n, i) => (
          <div className="note" key={i}>
            <span className="badge scheduled">{n.kind}</span> <span className="muted">#{n.seq}</span> {n.message}
          </div>
        ))}
      </div>
    </div>
  );
}
