import { describe, expect, it } from 'vitest';
import type { AgentPermission, AgentSession, Worker } from '@agenthub/protocol';
import { projectRuntimeCockpit } from './runtimeCockpit';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    session_id: 'sess-1',
    backend: 'codex',
    worker_id: 'worker-1',
    workspace_root: 'E:/work/project',
    project_name: 'Project',
    namespace: 'default',
    mode: 'direct',
    runtime_session_ref: 'runtime-1',
    status: 'ready',
    execution_status: 'idle',
    title: 'Project session',
    display_title: 'Project session',
    custom_title: null,
    heuristic_title: 'Project session',
    llm_title: null,
    activity_summary: 'Waiting for work',
    last_message: '',
    last_activity_at: '2026-07-15T02:00:00Z',
    last_role: 'assistant',
    controls: {},
    runtime_metadata: {},
    metadata: {},
    archived_at: null,
    ...overrides,
  };
}

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    worker_id: 'worker-1',
    machine_name: 'Developer PC',
    os: 'windows',
    reachable_backends: ['codex'],
    workspace_roots: ['E:/work'],
    capabilities: {},
    status: 'online',
    last_heartbeat_at: '2026-07-15T02:01:00Z',
    runtime_settings: {
      max_concurrent_jobs: 2,
      job_poll_interval_seconds: 2,
      heartbeat_interval_seconds: 15,
    },
    ...overrides,
  };
}

function permission(overrides: Partial<AgentPermission> = {}): AgentPermission {
  return {
    permission_id: 'permission-1',
    session_id: 'sess-1',
    worker_id: 'worker-1',
    backend: 'codex',
    kind: 'question',
    title: 'Choose a deployment target',
    description: 'One answer is required.',
    detail: {},
    actions: {},
    status: 'pending',
    response: {},
    created_at: '2026-07-15T02:02:00Z',
    resolved_at: null,
    ...overrides,
  };
}

describe('projectRuntimeCockpit', () => {
  it('prioritizes pending input over an active execution', () => {
    const result = projectRuntimeCockpit(
      [session({ status: 'running', execution_status: 'running' })],
      [worker()],
      [permission()],
    );

    expect(result.items[0]).toMatchObject({
      lane: 'attention',
      reason: 'pending_permission',
      permissionId: 'permission-1',
    });
  });

  it('projects missing and offline workers before execution state', () => {
    const result = projectRuntimeCockpit(
      [
        session({ session_id: 'missing', worker_id: 'missing-worker', execution_status: 'running' }),
        session({ session_id: 'offline', execution_status: 'running' }),
      ],
      [worker({ status: 'offline' })],
      [],
    );

    expect(result.items.map((item) => [item.sessionId, item.lane, item.reason])).toEqual([
      ['missing', 'offline', 'worker_missing'],
      ['offline', 'offline', 'worker_offline'],
    ]);
  });

  it('separates working, unseen completion, and idle sessions', () => {
    const result = projectRuntimeCockpit(
      [
        session({ session_id: 'working', execution_status: 'queued' }),
        session({
          session_id: 'done',
          execution_status: 'idle',
          attention_status: 'unseen',
          attention_reason: 'completion',
          attention_changed_at: '2026-07-15T02:05:00Z',
        }),
        session({ session_id: 'idle' }),
      ],
      [worker()],
      [],
    );

    expect(result.counts).toEqual({ attention: 0, working: 1, done: 1, idle: 1, offline: 0 });
    expect(result.items.find((item) => item.sessionId === 'working')?.lane).toBe('working');
    expect(result.items.find((item) => item.sessionId === 'done')).toMatchObject({
      lane: 'done',
      reason: 'unseen_completion',
      stateUpdatedAt: '2026-07-15T02:05:00Z',
    });
    expect(result.items.find((item) => item.sessionId === 'idle')?.lane).toBe('idle');
  });

  it('excludes archived sessions and sorts by lane, activity, then session id', () => {
    const result = projectRuntimeCockpit(
      [
        session({ session_id: 'archived', archived_at: '2026-07-15T02:00:00Z' }),
        session({ session_id: 'idle-b', last_activity_at: '2026-07-15T02:00:00Z' }),
        session({ session_id: 'idle-a', last_activity_at: '2026-07-15T02:00:00Z' }),
        session({ session_id: 'attention', status: 'needs_reply', last_activity_at: '2026-07-15T01:00:00Z' }),
      ],
      [worker()],
      [],
    );

    expect(result.items.map((item) => item.sessionId)).toEqual(['attention', 'idle-a', 'idle-b']);
  });
});
