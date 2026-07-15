import { Activity, BellRing, CheckCircle2, Clock3, ExternalLink, MonitorOff, PlayCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatRelativeTime, pickLocale, type LocaleCode } from './i18n';
import type {
  RuntimeCockpitItem,
  RuntimeCockpitLane,
  RuntimeCockpitProjection,
  RuntimeCockpitReason,
} from './runtimeCockpit';

type CockpitFilter = 'all' | RuntimeCockpitLane;

const laneOrder: RuntimeCockpitLane[] = ['attention', 'working', 'done', 'idle', 'offline'];

function laneLabel(locale: LocaleCode, lane: RuntimeCockpitLane): string {
  const labels: Record<RuntimeCockpitLane, [string, string]> = {
    attention: ['需要处理', 'Needs attention'],
    working: ['运行中', 'Working'],
    done: ['已完成', 'Done'],
    idle: ['空闲', 'Idle'],
    offline: ['离线', 'Offline'],
  };
  return pickLocale(locale, labels[lane][0], labels[lane][1]);
}

function reasonLabel(locale: LocaleCode, reason: RuntimeCockpitReason): string {
  const labels: Record<RuntimeCockpitReason, [string, string]> = {
    pending_permission: ['等待你审批', 'Approval required'],
    needs_reply: ['等待你回复', 'Reply required'],
    unseen_failure: ['失败，等待查看', 'Failure needs review'],
    unseen_attention: ['有新进展', 'New activity'],
    worker_missing: ['节点不可用', 'Worker unavailable'],
    worker_offline: ['节点已离线', 'Worker offline'],
    execution_queued: ['已进入队列', 'Queued'],
    execution_running: ['正在执行', 'Running'],
    unseen_completion: ['已完成，等待查看', 'Completed, unread'],
    session_failed: ['执行失败', 'Failed'],
    session_terminated: ['会话已结束', 'Session ended'],
    session_idle: ['等待任务', 'Ready'],
  };
  return pickLocale(locale, labels[reason][0], labels[reason][1]);
}

function LaneIcon({ lane }: { lane: RuntimeCockpitLane }) {
  if (lane === 'attention') return <BellRing size={17} />;
  if (lane === 'working') return <PlayCircle size={17} />;
  if (lane === 'done') return <CheckCircle2 size={17} />;
  if (lane === 'offline') return <MonitorOff size={17} />;
  return <Clock3 size={17} />;
}

function RuntimeRow({
  item,
  locale,
  onOpenSession,
  onOpenTask,
}: {
  item: RuntimeCockpitItem;
  locale: LocaleCode;
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const relativeTime = formatRelativeTime(locale, item.stateUpdatedAt || item.lastActivityAt);
  const taskId = item.taskId;
  return (
    <article className={`runtime-cockpit-row lane-${item.lane}`}>
      <button
        className="runtime-cockpit-row-main"
        type="button"
        aria-label={pickLocale(locale, `打开会话 ${item.title}`, `Open session ${item.title}`)}
        onClick={() => onOpenSession(item.sessionId)}
      >
        <span className="runtime-cockpit-state-icon" aria-hidden="true">
          <LaneIcon lane={item.lane} />
        </span>
        <span className="runtime-cockpit-row-content">
          <span className="runtime-cockpit-row-title">
            <strong>{item.title}</strong>
            <span className="runtime-cockpit-state-label">{reasonLabel(locale, item.reason)}</span>
          </span>
          <span className="runtime-cockpit-row-meta">
            <span>{item.backend}</span>
            <span>{item.workerName}</span>
            <span>{item.projectName}</span>
            {relativeTime ? <time dateTime={item.stateUpdatedAt || item.lastActivityAt || undefined}>{relativeTime}</time> : null}
          </span>
          {item.summary ? <span className="runtime-cockpit-row-summary">{item.summary}</span> : null}
        </span>
      </button>
      {taskId ? (
        <button
          className="runtime-cockpit-task-link"
          type="button"
          onClick={() => onOpenTask(taskId)}
          aria-label={pickLocale(locale, `打开 ${item.title} 的任务`, `Open task for ${item.title}`)}
          title={pickLocale(locale, '打开关联任务', 'Open linked task')}
        >
          <ExternalLink size={16} />
        </button>
      ) : null}
    </article>
  );
}

export function RuntimeCockpit({
  projection,
  locale,
  onOpenSession,
  onOpenTask,
}: {
  projection: RuntimeCockpitProjection;
  locale: LocaleCode;
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [filter, setFilter] = useState<CockpitFilter>('all');
  const availableLanes = laneOrder.filter((lane) => projection.counts[lane] > 0);
  const activeFilter = filter !== 'all' && projection.counts[filter] === 0 ? 'all' : filter;
  const visibleItems = useMemo(
    () => (activeFilter === 'all' ? projection.items : projection.items.filter((item) => item.lane === activeFilter)),
    [activeFilter, projection.items],
  );

  if (projection.items.length === 0) {
    return (
      <section className="runtime-cockpit runtime-cockpit-empty">
        <Activity size={28} />
        <strong>{pickLocale(locale, '暂无运行中的会话', 'No agent sessions yet')}</strong>
        <span>{pickLocale(locale, '新建会话或连接节点后会显示在这里。', 'Start a session or connect a worker to see it here.')}</span>
      </section>
    );
  }

  return (
    <section className="runtime-cockpit" aria-label={pickLocale(locale, 'Agent 运行总览', 'Agent runtime cockpit')}>
      <header className="runtime-cockpit-head">
        <div>
          <span className="runtime-cockpit-eyebrow">{pickLocale(locale, '运行总览', 'Runtime cockpit')}</span>
          <h1>{pickLocale(locale, '所有 Agent，一眼看清', 'Every agent at a glance')}</h1>
          <p>
            {pickLocale(
              locale,
              `${projection.counts.attention} 个需要处理，${projection.counts.working} 个正在运行`,
              `${projection.counts.attention} need attention, ${projection.counts.working} working`,
            )}
          </p>
        </div>
      </header>

      <div className="runtime-cockpit-filters" role="group" aria-label={pickLocale(locale, '筛选运行状态', 'Filter runtime status')}>
        <button
          type="button"
          className={activeFilter === 'all' ? 'selected' : ''}
          aria-pressed={activeFilter === 'all'}
          onClick={() => setFilter('all')}
        >
          {pickLocale(locale, '全部', 'All')}
          <span>{projection.items.length}</span>
        </button>
        {availableLanes.map((lane) => (
          <button
            type="button"
            key={lane}
            className={activeFilter === lane ? `selected lane-${lane}` : `lane-${lane}`}
            aria-pressed={activeFilter === lane}
            onClick={() => setFilter(lane)}
          >
            {laneLabel(locale, lane)}
            <span>{projection.counts[lane]}</span>
          </button>
        ))}
      </div>

      <div className="runtime-cockpit-list" aria-live="polite">
        {visibleItems.map((item) => (
          <RuntimeRow
            key={item.sessionId}
            item={item}
            locale={locale}
            onOpenSession={onOpenSession}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>
    </section>
  );
}
