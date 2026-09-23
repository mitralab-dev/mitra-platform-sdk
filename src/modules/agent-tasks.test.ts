import type { AgentTaskSessionOptions } from '@mitralab.io/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetchSequence } from '../test-utils';
import { HttpClient } from '../utils/http-client';
import { createBrowserAgentTasksModule } from './agent-tasks';
import type { AuthSessionPort } from './auth';

const task = {
  id: 'task-1',
  appId: 'app-1',
  agentId: null,
  userId: 'user-1',
  title: 'Chat',
  agentType: 'CLAUDE',
  reasoningEffort: null,
  archived: false,
  createdAt: '2026-08-22T00:00:00Z',
  updatedAt: '2026-08-22T00:00:00Z',
};

function page<T>(content: T[]) {
  return {
    content,
    page: {
      size: 20,
      totalElements: content.length,
      totalPages: content.length === 0 ? 0 : 1,
      number: 0,
    },
  };
}

const auth: AuthSessionPort = {
  accessToken: 'access',
  ensureFreshSession: vi.fn().mockResolvedValue(true),
  handleUnauthorized: vi.fn().mockResolvedValue(false),
  readSessionTokens: vi.fn().mockReturnValue({ token: 'access', refreshToken: 'refresh' }),
  onSessionChange: vi.fn().mockReturnValue(() => undefined),
  adoptSession: vi.fn(),
};

describe('createBrowserAgentTasksModule', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('composes the complete Core REST module with its Core-owned session manager', async () => {
    const fetchMock = mockFetchSequence([
      { body: page([task]) },
      { body: task },
      { body: task },
      { body: { ...task, title: 'Renamed' } },
      { body: undefined, status: 204 },
      { body: undefined, status: 204 },
      { body: page([]) },
    ]);
    const http = new HttpClient({ baseUrl: 'https://api.mitra.io/copilot' });
    const tasks = createBrowserAgentTasksModule(http, auth, 'https://api.mitra.io');

    await expect(tasks.list({ archived: false })).resolves.toMatchObject({ content: [task] });
    await expect(tasks.get('task-1')).resolves.toEqual(task);
    await expect(tasks.create({ agentType: 'CLAUDE' })).resolves.toEqual(task);
    await expect(tasks.rename('task-1', 'Renamed')).resolves.toMatchObject({ title: 'Renamed' });
    await expect(tasks.archive('task-1')).resolves.toBeUndefined();
    await expect(tasks.sendInput('task-1', { type: 'interrupt' })).resolves.toBeUndefined();
    await expect(tasks.listMessages('task-1')).resolves.toMatchObject({ content: [] });
    expect(typeof tasks.session).toBe('function');
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  /** Answers the create with the task and refuses everything else: only the create body matters. */
  async function createBody(options: AgentTaskSessionOptions): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn((input: unknown, _init?: { body?: string }) => Promise.resolve(
      String(input).endsWith('/copilot/api/v1/tasks')
        ? { ok: true, status: 200, json: async () => task }
        : { ok: false, status: 404, json: async () => ({}) }
    ));
    vi.stubGlobal('fetch', fetchMock);
    // A browser always has one; Node 18, which CI also runs, does not, and Core only creates on
    // the box when it can reach it.
    vi.stubGlobal('WebSocket', class { readyState = 0; close() {} });
    const http = new HttpClient({ baseUrl: 'https://api.mitra.io/copilot' });
    const session = createBrowserAgentTasksModule(http, auth, 'https://api.mitra.io').session(options);
    const created = new Promise<void>((resolve) => session.on('taskCreated', () => resolve()));
    session.send('hello');
    await created;
    session.close();
    const create = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/copilot/api/v1/tasks'));
    return JSON.parse(create?.[1]?.body ?? '{}') as Record<string, unknown>;
  }

  it.each<[string, AgentTaskSessionOptions, Record<string, unknown>]>([
    ['auto is born on the box', { create: true, agentType: 'CLAUDE' }, { runtime: 'T3' }],
    ['websocket is born on the box', { create: true, agentType: 'CLAUDE', transport: 'websocket' }, { runtime: 'T3' }],
    ['http is born on the box, reached over its HTTP routes', { create: true, agentType: 'CLAUDE', transport: 'http' }, { runtime: 'T3' }],
    ['an explicit runtime wins', { create: true, agentType: 'CLAUDE', runtime: 'RUNNER' }, { runtime: 'RUNNER' }],
    ['scope ACCOUNT sends it in the body', { create: true, agentType: 'CLAUDE', agentId: 'agent-1', scope: 'ACCOUNT' }, { agentId: 'agent-1', runtime: 'T3', scope: 'ACCOUNT' }],
  ])('a chat created with %s', async (_name, options, expected) => {
    const body = await createBody(options);

    expect(body).toEqual({ agentType: 'CLAUDE', ...expected });
  });
});
