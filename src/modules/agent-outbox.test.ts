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

/** The browser as the session sees it: whether it says it is offline, and what that does to fetch. */
const browser = { offline: false };

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState = 0;
  close = vi.fn((code = 1000) => {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  });
  send = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (browser.offline) {
        this.onerror?.();
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    });
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  frames(): unknown[] {
    return this.send.mock.calls.map(([frame]) => JSON.parse(String(frame)) as unknown);
  }
}

const BOX_WS_URL = 'wss://api.mitra.io/__ide/3773-box.e2b.app/api/mitra/chat/ws?grant=g&ticket=t';

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
 * The copilot as the session sees it: the task, an empty history, the box channel only when
 * the test offers one, and `/inputs` answering in the order the test scripted, the last answer
 * repeating. `inputs` is called with the request body, so a test can read what went by REST.
 */
function copilot(inputAnswers: InputAnswer[], boxWsUrl?: string) {
  const inputs = vi.fn();
  vi.stubGlobal('fetch', vi.fn((input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (browser.offline) return Promise.reject(new TypeError('Failed to fetch'));
    if (url.includes('/inputs')) {
      inputs(JSON.parse(init?.body ?? '{}'));
      const answer = inputAnswers[Math.min(inputs.mock.calls.length, inputAnswers.length) - 1];
      return answer();
    }
    if (url.includes('/channel')) {
      return Promise.resolve(boxWsUrl
        ? { ok: true, status: 200, json: async () => ({ wsUrl: boxWsUrl, lastSequence: 0 }) }
        : { ok: false, status: 404 });
    }
    if (url.includes('/events')) {
      return Promise.resolve({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start() {} }) });
    }
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
    browser.offline = false;
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('navigator', { onLine: true });
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

  it('keeps a prompt whose request got no response and sends it once when the browser says the network is back', async () => {
    // Tester, 2026-09-13: send() failed with "Failed to send Agent prompt: Failed to fetch" and
    // the message was gone. Here the browser still says it is online, so the request goes out
    // and is what fails; the `online` event is the earliest of the two retry triggers.
    const inputs = copilot([networkLost, accepted]);
    const { session, errors, raws } = await openSession();

    session.send('hello');
    await vi.waitFor(() => expect(inputs).toHaveBeenCalledTimes(1));

    expect(errors).toEqual([]);
    expect(outboxEvents(raws)).toEqual([{
      type: 'inputUnsent',
      payload: { attempt: 1, reason: 'Failed to fetch', waitingForOnline: false, retryInMs: OUTBOX_DELAYS_MS[0] },
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

  describe('with the browser really offline', () => {
    // Tester, 2026-09-13, on the published beta.19: with the network off, send() still failed
    // with "Failed to send Agent prompt: Failed to fetch" and the message was gone. Aborting
    // only the /inputs request had passed: offline, the core's send opens the channel and reads
    // the turn baseline first, and those requests fail before the prompt reaches /inputs.
    const goOffline = () => {
      browser.offline = true;
      vi.stubGlobal('navigator', { onLine: false });
      // The browser drops the socket it held, the way a network going away does.
      FakeWebSocket.instances.at(-1)?.onclose?.({ code: 1006 } as CloseEvent);
    };
    const goOnline = () => {
      browser.offline = false;
      vi.stubGlobal('navigator', { onLine: true });
      for (const listener of [...onlineListeners]) listener();
    };

    it('holds the prompt until the browser is back, then sends it once', async () => {
      const inputs = copilot([accepted]);
      const { session, errors, raws } = await openSession();
      goOffline();

      session.send('hello');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(errors).toEqual([]);
      expect(inputs).not.toHaveBeenCalled();
      expect(outboxEvents(raws)).toEqual([{
        type: 'inputUnsent',
        payload: { attempt: 0, reason: 'The browser is offline.', waitingForOnline: true },
      }]);
      expect(session.status).toBe('idle');

      goOnline();
      await vi.waitFor(() => expect(inputs).toHaveBeenCalledTimes(1));
      expect(errors).toEqual([]);
      expect(session.status).toBe('streaming');
      session.close();
    });

    it('keeps the order of prompts sent while offline', async () => {
      const inputs = copilot([accepted]);
      const { session, errors } = await openSession();
      goOffline();

      session.send('first');
      session.send('second');
      goOnline();

      await vi.waitFor(() => expect(inputs).toHaveBeenCalledTimes(1));
      expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body))).toMatchObject({ content: 'first' });
      expect(session.queue.map((item) => item.text)).toEqual(['second']);
      expect(errors).toEqual([]);
      session.close();
    });

    it('says so when the session closes with a prompt still waiting for the network', async () => {
      copilot([accepted]);
      const { session, errors } = await openSession();
      goOffline();
      const waiting = session.sendAndWait('hello');
      const waitingFailure = waiting.catch((error: Error) => error.message);

      session.close();

      expect(errors).toEqual([{ code: 'INPUT_UNSENT', error: expect.stringContaining('never sent') }]);
      await expect(waitingFailure).resolves.toContain('never sent');
      expect(onlineListeners).toHaveLength(0);
    });
  });

  describe('on the direct channel', () => {
    // Issue #116: every send went to `/inputs` and the copilot opened a host socket to the box
    // just to hand it over, which put the copilot's socket buffer between the person and the
    // box. The box reads the client frame itself and asks the copilot only for admission.
    const box = () => FakeWebSocket.instances[0];

    it('writes the message on the box socket instead of calling the copilot REST', async () => {
      const inputs = copilot([accepted], BOX_WS_URL);
      const { session, errors } = await openSession();

      session.send('hello', { agentType: 'CLAUDE' });
      await vi.waitFor(() => expect(box().frames()).toEqual([
        { type: 'message', content: 'hello', agentType: 'CLAUDE' },
      ]));

      expect(box().url).toBe(BOX_WS_URL);
      expect(inputs).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      expect(session.status).toBe('streaming');
      session.close();
    });

    it('writes the interrupt on the box socket', async () => {
      const inputs = copilot([accepted], BOX_WS_URL);
      const { session, errors } = await openSession();
      session.send('hello');
      await vi.waitFor(() => expect(box().frames()).toHaveLength(1));

      await session.cancel();

      expect(box().frames().at(-1)).toEqual({ type: 'interrupt' });
      expect(inputs).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      session.close();
    });

    it('falls back to REST while the box socket is being redialed', async () => {
      const inputs = copilot([accepted], BOX_WS_URL);
      const { session, errors } = await openSession();
      session.send('hello');
      await vi.waitFor(() => expect(box().frames()).toHaveLength(1));
      box().message({ type: 'textDelta', payload: { text: 'a' }, timestamp: 1, sequence: 1 });
      box().onclose?.({ code: 1006 } as CloseEvent);

      await session.cancel();

      expect(inputs).toHaveBeenCalledExactlyOnceWith({ type: 'interrupt' });
      expect(box().frames()).toHaveLength(1);
      expect(errors).toEqual([]);
      session.close();
    });

    it('answers an approval by REST', async () => {
      const inputs = copilot([accepted], BOX_WS_URL);
      const { session, errors } = await openSession();

      session.respondApproval(true);

      await vi.waitFor(() => expect(inputs).toHaveBeenCalledExactlyOnceWith({ type: 'approval_response', approved: true }));
      expect(box().frames()).toEqual([]);
      expect(errors).toEqual([]);
      session.close();
    });
  });

  it('sends by REST for a chat served by the copilot socket', async () => {
    const inputs = copilot([accepted]);
    const { session, errors } = await openSession();

    session.send('hello');

    await vi.waitFor(() => expect(inputs).toHaveBeenCalledExactlyOnceWith({ type: 'message', content: 'hello' }));
    expect(FakeWebSocket.instances[0].frames()).toEqual([]);
    expect(errors).toEqual([]);
    session.close();
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
