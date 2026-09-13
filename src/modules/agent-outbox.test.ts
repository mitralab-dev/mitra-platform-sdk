import type { AgentTaskEvent, AgentTaskSession } from '@mitralab.io/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../utils/http-client';
import { OUTBOX_DELAYS_MS } from './agent-outbox';
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

const emptyPage = {
  content: [],
  page: { size: 100, totalElements: 0, totalPages: 0, number: 0 },
};

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn((code = 1000) => this.onclose?.({ code } as CloseEvent));
  send = vi.fn();

  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.());
  }
}

const auth: AuthSessionPort = {
  accessToken: 'access',
  ensureFreshSession: vi.fn().mockResolvedValue(true),
  handleUnauthorized: vi.fn().mockResolvedValue(false),
  readSessionTokens: vi.fn().mockReturnValue({ token: 'access', refreshToken: 'refresh' }),
  onSessionChange: vi.fn().mockReturnValue(() => undefined),
  adoptSession: vi.fn(),
};

type InputAnswer = () => Promise<unknown>;

const networkLost: InputAnswer = () => Promise.reject(new TypeError('Failed to fetch'));
const accepted: InputAnswer = () => Promise.resolve({ ok: true, status: 204 });
const rejected: InputAnswer = () => Promise.resolve({
  ok: false,
  status: 400,
  json: async () => ({ message: 'Prompt too long' }),
});

/**
 * The copilot as the session sees it: the task, an empty history, no box channel, and
 * `/inputs` answering in the order the test scripted, the last answer repeating.
 */
function copilot(inputAnswers: InputAnswer[]) {
  const inputs = vi.fn();
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/inputs')) {
      inputs(url);
      const answer = inputAnswers[Math.min(inputs.mock.calls.length, inputAnswers.length) - 1];
      return answer();
    }
    if (url.includes('/channel')) return Promise.resolve({ ok: false, status: 404 });
    if (url.includes('/messages')) return Promise.resolve({ ok: true, status: 200, json: async () => emptyPage });
    return Promise.resolve({ ok: true, status: 200, json: async () => task });
  }));
  return inputs;
}

interface Watched {
  session: AgentTaskSession;
  errors: Array<{ code?: string; error: string }>;
  raws: AgentTaskEvent[];
}

async function openSession(): Promise<Watched> {
  const http = new HttpClient({ baseUrl: 'https://api.mitra.io/copilot' });
  const tasks = createBrowserAgentTasksModule(http, auth, 'https://api.mitra.io');
  const session = tasks.session({ taskId: 'task-1' });
  const errors: Watched['errors'] = [];
  const raws: AgentTaskEvent[] = [];
  session.on('error', (payload) => errors.push(payload));
  session.on('raw', (event) => raws.push(event));
  await vi.waitFor(() => expect(session.status).toBe('idle'));
  return { session, errors, raws };
}

const outboxEvents = (raws: AgentTaskEvent[]) => raws
  .filter((event) => event.type.startsWith('input'))
  .map(({ type, payload }) => ({ type, payload }));

describe('agent input outbox', () => {
  let onlineListeners: Array<() => void>;

  beforeEach(() => {
    onlineListeners = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('addEventListener', vi.fn((type: string, listener: () => void) => {
      if (type === 'online') onlineListeners.push(listener);
    }));
    vi.stubGlobal('removeEventListener', vi.fn((_type: string, listener: () => void) => {
      onlineListeners = onlineListeners.filter((candidate) => candidate !== listener);
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps a prompt the network lost and sends it once when the browser is back online', async () => {
    // Tester, 2026-09-13: offline, send() failed with "Failed to send Agent prompt: Failed to
    // fetch" and the message was gone.
    const inputs = copilot([networkLost, accepted]);
    const { session, errors, raws } = await openSession();

    session.send('hello');
    await vi.waitFor(() => expect(inputs).toHaveBeenCalledTimes(1));

    expect(errors).toEqual([]);
    expect(outboxEvents(raws)).toEqual([{
      type: 'inputUnsent',
      payload: { attempt: 1, reason: 'Failed to fetch', waitingForOnline: true },
    }]);
    // The turn is held, not failed: the prompt is still on its way.
    expect(session.status).toBe('streaming');
    expect(onlineListeners).toHaveLength(1);

    for (const listener of onlineListeners) listener();
    await vi.waitFor(() => expect(inputs).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(outboxEvents(raws).at(-1)).toEqual({
      type: 'inputSent',
      payload: { attempts: 2 },
    }));
    expect(errors).toEqual([]);
    expect(onlineListeners).toHaveLength(0);
    session.close();
  });

  it('does not retry a prompt the server answered with an error', async () => {
    const inputs = copilot([rejected]);
    const { session, errors, raws } = await openSession();

    session.send('hello');
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect(errors[0].error).toBe('Failed to send Agent prompt: Prompt too long');
    for (const listener of onlineListeners) listener();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inputs).toHaveBeenCalledTimes(1);
    expect(outboxEvents(raws)).toEqual([]);
    session.close();
  });

  it('says so when the session closes with a prompt still unsent', async () => {
    copilot([networkLost]);
    const { session, errors, raws } = await openSession();
    session.send('hello');
    await vi.waitFor(() => expect(outboxEvents(raws)).toHaveLength(1));

    session.close();

    expect(errors).toEqual([{
      code: 'INPUT_UNSENT',
      error: expect.stringContaining('never sent'),
    }]);
    expect(onlineListeners).toHaveLength(0);
  });

  it('retries on a bounded backoff when the browser does not say it is offline, then gives up', async () => {
    vi.stubGlobal('navigator', {});
    const inputs = copilot([networkLost]);
    const { session, errors, raws } = await openSession();
    vi.useFakeTimers();

    session.send('hello');
    await vi.advanceTimersByTimeAsync(0);
    expect(inputs).toHaveBeenCalledTimes(1);

    for (const [index, delayMs] of OUTBOX_DELAYS_MS.entries()) {
      expect(outboxEvents(raws).at(-1)).toEqual({
        type: 'inputUnsent',
        payload: { attempt: index + 1, reason: 'Failed to fetch', waitingForOnline: false, retryInMs: delayMs },
      });
      expect(errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(delayMs);
      expect(inputs).toHaveBeenCalledTimes(index + 2);
    }

    expect(errors).toEqual([{
      error: `Failed to send Agent prompt: Agent prompt was not sent after ${OUTBOX_DELAYS_MS.length + 1} attempts: Failed to fetch`,
    }]);
    expect(session.status).toBe('idle');
    session.close();
  });
});
