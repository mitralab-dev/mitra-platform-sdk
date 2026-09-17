import type { AgentTaskSessionOptions } from '@mitralab.io/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, mockFetchSequence } from '../test-utils';
import { HttpClient } from '../utils/http-client';
import { createBrowserAgentTasksModule, type BrowserAgentTaskSessionOptions } from './agent-tasks';
import type { AuthSessionPort } from './auth';

// The core session manager stays real; only what this SDK hands it is recorded.
const sessionOptionsSeen = vi.hoisted(() => vi.fn<(options: AgentTaskSessionOptions) => void>());
vi.mock('@mitralab.io/sdk-core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@mitralab.io/sdk-core')>();
  const createAgentTaskSessionManager: typeof core.createAgentTaskSessionManager = (options) => {
    const manager = core.createAgentTaskSessionManager(options);
    return {
      session: (sessionOptions) => {
        sessionOptionsSeen(sessionOptions);
        return manager.session(sessionOptions);
      },
    };
  };
  return { ...core, createAgentTaskSessionManager };
});

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

  it.each<[string, BrowserAgentTaskSessionOptions, string | undefined]>([
    ['auto is born on the box', { create: true, agentType: 'CLAUDE' }, 'T3'],
    ['websocket is born on the box', { create: true, agentType: 'CLAUDE', transport: 'websocket' }, 'T3'],
    ['http stays on the runner', { create: true, agentType: 'CLAUDE', transport: 'http' }, undefined],
    ['an explicit runtime wins', { create: true, agentType: 'CLAUDE', runtime: 'RUNNER' }, 'RUNNER'],
    ['an existing chat is opened as it is', { taskId: 'task-1' }, undefined],
  ])('a session created with %s', (_name, options, runtime) => {
    sessionOptionsSeen.mockClear();
    mockFetch(task);
    const http = new HttpClient({ baseUrl: 'https://api.mitra.io/copilot' });
    const tasks = createBrowserAgentTasksModule(http, auth, 'https://api.mitra.io');

    tasks.session(options).close();

    expect(sessionOptionsSeen).toHaveBeenCalledExactlyOnceWith({ ...options, ...(runtime ? { runtime } : {}) });
  });
});
