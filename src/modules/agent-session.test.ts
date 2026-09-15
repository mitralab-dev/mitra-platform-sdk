import type { AgentTaskEventObserver } from '@mitralab.io/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionPort } from './auth';
import { BrowserAgentTaskEventSource, RECONNECT_DELAYS_MS, SILENCE_TIMEOUT_MS } from './agent-session';

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  static autoOpen = true;
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  close = vi.fn((code = 1000) => this.onclose?.({ code } as CloseEvent));
  send = vi.fn((data: string) => {
    this.sent.push(data);
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) queueMicrotask(() => this.onopen?.());
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

function auth(): AuthSessionPort & {
  accessToken: string | null;
  ensureFreshSession: ReturnType<typeof vi.fn>;
  handleUnauthorized: ReturnType<typeof vi.fn>;
} {
  return {
    accessToken: 'app-access',
    ensureFreshSession: vi.fn().mockResolvedValue(true),
    handleUnauthorized: vi.fn().mockResolvedValue(false),
    readSessionTokens: vi.fn().mockReturnValue({ token: 'app-access', refreshToken: 'refresh' }),
    onSessionChange: vi.fn().mockReturnValue(() => undefined),
    adoptSession: vi.fn(),
  };
}

function observer(): AgentTaskEventObserver & {
  onEvent: ReturnType<typeof vi.fn>;
  onDisconnect: ReturnType<typeof vi.fn>;
} {
  return { onEvent: vi.fn(), onDisconnect: vi.fn() };
}

function openStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} });
}

/**
 * O copilot passou a ser perguntado onde a conversa e servida antes de qualquer conexao. Um
 * teste que quer o socket do copilot precisa dizer que o canal da caixa nao foi oferecido,
 * senao a recusa vira acidente do mock em vez de intencao do teste.
 */
function channelRefused(rest?: (url: string) => unknown): ReturnType<typeof vi.fn> {
  return vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/channel')) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve(rest ? rest(url) : { ok: true, status: 200, body: openStream() });
  });
}

function channelOffered(wsUrl: string, lastSequence = 0): ReturnType<typeof vi.fn> {
  return vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/channel')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ wsUrl, lastSequence }) });
    }
    return Promise.resolve({ ok: true, status: 200, body: openStream() });
  });
}

const BOX_WS_URL = 'wss://api.mitra.io/__ide/3773-box.e2b.app/api/mitra/chat/ws?grant=g&ticket=t';
const OTHER_BOX_WS_URL = 'wss://api.mitra.io/__ide/9120-box.e2b.app/api/mitra/chat/ws?grant=g2&ticket=t2';

describe('BrowserAgentTaskEventSource', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    FakeWebSocket.autoOpen = true;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', channelRefused());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refreshes before WebSocket and forwards valid event envelopes', async () => {
    const sessionAuth = auth();
    const events = observer();
    const source = new BrowserAgentTaskEventSource(sessionAuth, 'https://api.mitra.io/');

    const connection = await source.open('task/1', events, undefined, 'websocket');
    const socket = FakeWebSocket.instances[0];

    expect(sessionAuth.ensureFreshSession).toHaveBeenCalledOnce();
    expect(socket.url).toBe(
      'wss://api.mitra.io/copilot/ws/tasks/task%2F1?token=app-access'
    );
    socket.message({ type: 'textDelta', payload: { text: 'ok' }, timestamp: 1, sequence: 2 });
    socket.message({ type: '', timestamp: 1 });
    expect(events.onEvent).toHaveBeenCalledOnce();
    expect(events.onEvent).toHaveBeenCalledWith({
      type: 'textDelta',
      payload: { text: 'ok' },
      timestamp: 1,
      sequence: 2,
    });

    connection.close();
    expect(socket.close).toHaveBeenCalledWith(1000, 'Client closed');
    expect(events.onDisconnect).not.toHaveBeenCalled();
  });

  it('serves the chat from the box when the copilot offers the channel', async () => {
    vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 7));
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');

    const connection = await source.open('task-1', observer(), undefined, 'websocket');

    // Nada de config no app: quem oferece o caminho e o servidor, e a caixa e onde a conversa vive.
    expect(FakeWebSocket.instances[0].url).toBe(BOX_WS_URL);
    // Entrar num chat nao tem buraco a cobrir; repetir aqui jogaria a conversa inteira na tela.
    expect(FakeWebSocket.instances[0].sent).toEqual([]);
    connection.close();
  });

  it('keeps the copilot socket when the channel is not offered', async () => {
    vi.stubGlobal('fetch', channelRefused());
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');

    const connection = await source.open('task-1', observer(), undefined, 'websocket');

    // O interruptor vive no servidor: sem canal oferecido a conversa segue como sempre foi.
    expect(FakeWebSocket.instances[0].url).toBe(
      'wss://api.mitra.io/copilot/ws/tasks/task-1?token=app-access'
    );
    connection.close();
  });

  it('refuses a channel that points somewhere else, which would leak the credential', async () => {
    vi.stubGlobal('fetch', channelOffered('wss://attacker.example/api/mitra/chat/ws?grant=g'));
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');

    const connection = await source.open('task-1', observer(), undefined, 'websocket');

    expect(FakeWebSocket.instances[0].url).toContain('api.mitra.io/copilot/ws/tasks/task-1');
    connection.close();
  });

  it('waits for a box that is still booting instead of opening the old path', async () => {
    vi.useFakeTimers();
    let asks = 0;
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      if (!String(input).includes('/channel')) {
        return Promise.resolve({ ok: true, status: 200, body: openStream() });
      }
      asks += 1;
      if (asks === 1) return Promise.resolve({ ok: true, status: 202 });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ wsUrl: BOX_WS_URL, lastSequence: 0 }),
      });
    }));
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');

    const opening = source.open('task-1', observer(), undefined, 'websocket');
    await vi.advanceTimersByTimeAsync(2_100);
    const connection = await opening;

    expect(asks).toBe(2);
    expect(FakeWebSocket.instances[0].url).toBe(BOX_WS_URL);
    connection.close();
    vi.useRealTimers();
  });

  it('a session opened again after an idle close does not ask the box to replay', async () => {
    // Beta.21, 2026-09-14: a tab open since the day before had its box replaced. The open
    // that followed replayed from the cursor of the old box, and every old turn past it
    // landed on the screen as live text. What an idle chat missed is history, loaded by REST.
    vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 4));
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
    const events = observer();

    await source.open('task-1', events, undefined, 'websocket');
    const first = FakeWebSocket.instances[0];
    first.message({ type: 'textDelta', payload: { text: 'oi' }, timestamp: 1, sequence: 6 });
    first.message({ type: 'stepFinish', payload: { reason: 'stop' }, timestamp: 2, sequence: 7 });
    first.onclose?.({ code: 1000 } as CloseEvent);
    expect(events.onDisconnect).toHaveBeenCalledTimes(1);

    vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 12));
    await source.open('task-1', events, undefined, 'websocket');
    const second = FakeWebSocket.instances[1];

    expect(second.sent).toEqual([]);
    // Nothing between 7 and 12 reaches the core through this socket, as deltas or otherwise.
    const delivered = events.onEvent.mock.calls.map((call) => (call[0] as { sequence?: number }).sequence);
    expect(delivered).toEqual([6, 7]);
  });

  it('a cursor from a previous box never reaches a new one', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 3));
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
    const events = observer();

    await source.open('task-1', events, undefined, 'websocket');
    const first = FakeWebSocket.instances[0];
    first.message({ type: 'textDelta', payload: { text: 'a' }, timestamp: 1, sequence: 14 });

    // Mid-turn, the copilot answers with another box: its log is not the one the cursor came from.
    vi.stubGlobal('fetch', channelOffered(OTHER_BOX_WS_URL, 20));
    first.onclose?.({ code: 1006 } as CloseEvent);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    const second = FakeWebSocket.instances[1];
    expect(second.url).toBe(OTHER_BOX_WS_URL);
    expect(second.sent).toEqual([]);

    // The cursor is now where the new box's log was: a drop on it resumes from there, not from 14.
    second.message({ type: 'textDelta', payload: { text: 'b' }, timestamp: 2 });
    second.onclose?.({ code: 1006 } as CloseEvent);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(FakeWebSocket.instances[2].sent).toEqual([JSON.stringify({ type: 'replay', fromSequence: 20 })]);
    expect(events.onDisconnect).not.toHaveBeenCalled();
  });

  it('uses an authenticated SSE stream for the http preference', async () => {
    const sessionAuth = auth();
    const events = observer();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream });
    vi.stubGlobal('fetch', fetchMock);
    const source = new BrowserAgentTaskEventSource(sessionAuth, 'https://api.mitra.io');

    const connection = await source.open('task-1', events, undefined, 'http');
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.mitra.io/copilot/api/v1/tasks/task-1/events',
      expect.objectContaining({
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer app-access' },
      })
    );

    controller?.enqueue(new TextEncoder().encode(
      'event: message\r\ndata: {"type":"thinking","payload":{"text":"..."},"timestamp":3}\r\n\r\n'
    ));
    await vi.waitFor(() => expect(events.onEvent).toHaveBeenCalledWith({
      type: 'thinking',
      payload: { text: '...' },
      timestamp: 3,
    }));
    connection.close();
  });

  it('retries an SSE 401 once with the token rotated by auth', async () => {
    const sessionAuth = auth();
    sessionAuth.handleUnauthorized.mockImplementation(async (requestToken: string | null) => {
      expect(requestToken).toBe('app-access');
      sessionAuth.accessToken = 'rotated-access';
      return true;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, body: null })
      .mockResolvedValueOnce({ ok: true, status: 200, body: openStream() });
    vi.stubGlobal('fetch', fetchMock);
    const source = new BrowserAgentTaskEventSource(sessionAuth, 'https://api.mitra.io');

    const connection = await source.open('task-1', observer(), undefined, 'http');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer app-access');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer rotated-access');
    connection.close();
  });

  it('falls back from auto WebSocket to SSE and preserves explicit websocket errors', async () => {
    FakeWebSocket.autoOpen = false;
    const fetchMock = channelRefused();
    vi.stubGlobal('fetch', fetchMock);
    const sseCalls = () => fetchMock.mock.calls.filter((c) => !String(c[0]).includes('/channel')).length;
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');

    const auto = source.open('task-1', observer(), undefined, 'auto');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].onerror?.();
    const connection = await auto;
    expect(sseCalls()).toBe(1);
    connection.close();

    const explicit = source.open('task-2', observer(), undefined, 'websocket');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances[1].onerror?.();
    await expect(explicit).rejects.toThrow('Failed to connect');
    expect(sseCalls()).toBe(1);
  });

  it('reports a WebSocket that went silent as disconnected, and a ping keeps it alive', async () => {
    vi.useFakeTimers();
    const events = observer();
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
    const connection = await source.open('task-1', events, undefined, 'websocket');
    const socket = FakeWebSocket.instances[0];

    // Just under the window: a late ping, not a dead channel.
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 1_000);
    expect(events.onDisconnect).not.toHaveBeenCalled();

    // A ping is a frame like any other, and it moves the window.
    socket.message({ type: 'ping', payload: {}, timestamp: 1 });
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 1_000);
    expect(events.onDisconnect).not.toHaveBeenCalled();

    // Two pings missed: the channel is half-open and nothing else will ever say so. The
    // disconnect is reported once, from here, and the socket is let go.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.onDisconnect).toHaveBeenCalledTimes(1);
    expect(events.onDisconnect.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(events.onDisconnect.mock.calls[0][0])).toContain('silent');
    expect(socket.close).toHaveBeenCalled();

    // The close the watchdog started must not report a second disconnect.
    connection.close();
    expect(events.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('reports a close the session did not ask for, whatever its code', async () => {
    // Dev, 2026-09-13: the box closed the socket, the core never heard, the next send went out
    // and was answered on the server, and the session waited on a socket that no longer existed.
    for (const code of [1000, 4409, 1006]) {
      const events = observer();
      const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
      await source.open('task-1', events, undefined, 'websocket');
      const socket = FakeWebSocket.instances.at(-1)!;

      socket.onclose?.({ code } as CloseEvent);

      expect(events.onDisconnect).toHaveBeenCalledTimes(1);
      expect(String(events.onDisconnect.mock.calls[0][0])).toContain(String(code));
    }
  });

  it('asks for the box channel again after the box closed, instead of falling to SSE', async () => {
    // Dev, 2026-09-13: with the close reported, the next open went to the copilot's SSE for
    // good, because any WebSocket disconnect used to mean "WebSockets do not work here". A box
    // closing is not that: the conversation is still served by a box, and the copilot says which.
    const events = observer();
    const fetchMock = channelOffered(BOX_WS_URL, 3);
    vi.stubGlobal('fetch', fetchMock);
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
    await source.open('task-1', events, undefined, 'auto');
    const first = FakeWebSocket.instances.at(-1)!;
    expect(first.url).toBe(BOX_WS_URL);

    first.onclose?.({ code: 1000 } as CloseEvent);
    expect(events.onDisconnect).toHaveBeenCalledTimes(1);

    await source.open('task-1', events, undefined, 'auto');
    const second = FakeWebSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.url).toBe(BOX_WS_URL);
    // Two channel requests, no SSE stream: the box path was asked for again, not abandoned.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/channel'))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter((c) => !String(c[0]).includes('/channel'))).toHaveLength(0);
  });

  it('hands a replayed textChunk to the core as the delta it stands for', async () => {
    // Dev, 2026-09-13: after a drop the box repeats the missed text as textChunk rows, which
    // the core does not know; the screen froze and the whole answer landed at once on turn end.
    vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 1));
    const events = observer();
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
    await source.open('task-1', events, undefined, 'websocket');
    const socket = FakeWebSocket.instances[0];

    socket.message({
      type: 'textChunk',
      payload: { text: 'oi', kind: 'text', lifecycle: 'turn' },
      timestamp: 1,
      sequence: 2,
    });
    socket.message({ type: 'textChunk', payload: { text: 'hmm', kind: 'thinking' }, timestamp: 2, sequence: 3 });

    expect(events.onEvent).toHaveBeenNthCalledWith(1, {
      type: 'textDelta',
      payload: { text: 'oi', kind: 'text', lifecycle: 'turn' },
      timestamp: 1,
      sequence: 2,
    });
    expect(events.onEvent).toHaveBeenNthCalledWith(2, {
      type: 'thinking',
      payload: { text: 'hmm', kind: 'thinking' },
      timestamp: 2,
      sequence: 3,
    });
  });

  describe('box channel reconnection', () => {
    const streamed = (socket: FakeWebSocket) => {
      socket.message({ type: 'textDelta', payload: { text: 'a' }, timestamp: 1 });
    };
    const channelEvents = (events: ReturnType<typeof observer>) => events.onEvent.mock.calls
      .map((call) => call[0] as { type: string; payload: unknown })
      .filter((event) => event.type.startsWith('channel'))
      .map(({ type, payload }) => ({ type, payload }));

    it('reconnects on its own when the box drops mid-turn, and the core keeps streaming', async () => {
      // Testers, 2026-09-13: the stream stopped, then the rest of the answer appeared at once,
      // sometimes after an error. The drop reached the core as a disconnect, and the core's
      // recovery is a reconcile of persisted history, not a resumed stream.
      vi.useFakeTimers();
      const fetchMock = channelOffered(BOX_WS_URL, 3);
      vi.stubGlobal('fetch', fetchMock);
      const events = observer();
      const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
      const connection = await source.open('task-1', events, undefined, 'auto');
      const first = FakeWebSocket.instances[0];
      streamed(first);
      first.message({ type: 'toolCall', payload: { name: 'read' }, timestamp: 2, sequence: 5 });

      first.onclose?.({ code: 1006 } as CloseEvent);

      // The core never hears a disconnect: what it hears is that the channel is reconnecting.
      expect(events.onDisconnect).not.toHaveBeenCalled();
      expect(channelEvents(events)).toEqual([{
        type: 'channelReconnecting',
        payload: {
          attempt: 1,
          maxAttempts: RECONNECT_DELAYS_MS.length,
          reason: 'Agent WebSocket closed (1006).',
        },
      }]);

      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
      const second = FakeWebSocket.instances[1];
      expect(second.url).toBe(BOX_WS_URL);
      expect(second.sent).toEqual([JSON.stringify({ type: 'replay', fromSequence: 5 })]);
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/channel'))).toHaveLength(2);
      expect(channelEvents(events).at(-1)).toEqual({ type: 'channelConnected', payload: { attempt: 1 } });

      // Replayed and live frames of the new socket reach the same observer, same delta path.
      second.message({ type: 'textChunk', payload: { text: 'b', kind: 'text' }, timestamp: 3, sequence: 6 });
      expect(events.onEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'textDelta', payload: { text: 'b', kind: 'text' } })
      );
      expect(events.onDisconnect).not.toHaveBeenCalled();

      // Closing the session closes the socket that is live now, not the one that died.
      connection.close();
      expect(second.close).toHaveBeenCalledWith(1000, 'Client closed');
    });

    it('backs off between attempts and reports the disconnect only when it gives up', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 0));
      const events = observer();
      const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
      await source.open('task-1', events, undefined, 'auto');
      const first = FakeWebSocket.instances[0];
      streamed(first);

      FakeWebSocket.autoOpen = false;
      first.onclose?.({ code: 1006 } as CloseEvent);

      for (const [index, delayMs] of RECONNECT_DELAYS_MS.entries()) {
        expect(events.onDisconnect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(delayMs);
        expect(FakeWebSocket.instances).toHaveLength(index + 2);
        FakeWebSocket.instances.at(-1)!.onerror?.();
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(events.onDisconnect).toHaveBeenCalledTimes(1);
      const reported = String(events.onDisconnect.mock.calls[0][0]);
      expect(reported).toContain(`${RECONNECT_DELAYS_MS.length} attempts`);
      expect(reported).toContain('Failed to connect');
      expect(channelEvents(events).map((event) => event.type)).toEqual(
        RECONNECT_DELAYS_MS.map(() => 'channelReconnecting')
      );
    });

    it('keeps trying through a channel request the network lost, and stops when the copilot refuses', async () => {
      vi.useFakeTimers();
      let asks = 0;
      vi.stubGlobal('fetch', vi.fn((input: unknown) => {
        if (!String(input).includes('/channel')) {
          return Promise.resolve({ ok: true, status: 200, body: openStream() });
        }
        asks += 1;
        if (asks === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ wsUrl: BOX_WS_URL, lastSequence: 0 }),
          });
        }
        if (asks === 2) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ ok: false, status: 404 });
      }));
      const events = observer();
      const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
      await source.open('task-1', events, undefined, 'auto');
      streamed(FakeWebSocket.instances[0]);

      FakeWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent);
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
      // A request the network lost is a failed attempt, not a refusal.
      expect(asks).toBe(2);
      expect(events.onDisconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1]);
      // A refusal is final: the box is no longer where this chat is served.
      expect(asks).toBe(3);
      expect(events.onDisconnect).toHaveBeenCalledTimes(1);
      expect(String(events.onDisconnect.mock.calls[0][0])).toContain('no longer offers');
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('does not reconnect a channel another tab took over, nor an idle box', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 0));
      const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');

      // 4409: the copilot handed the slot to a newer socket; dialing again would take it back.
      const superseded = observer();
      await source.open('task-1', superseded, undefined, 'auto');
      streamed(FakeWebSocket.instances[0]);
      FakeWebSocket.instances[0].onclose?.({ code: 4409 } as CloseEvent);
      expect(superseded.onDisconnect).toHaveBeenCalledTimes(1);

      // No turn in flight: the sandbox pauses an idle box, and dialing again would wake it for
      // nobody. The next send reopens the channel, as it always did.
      const idle = observer();
      await source.open('task-2', idle, undefined, 'auto');
      const socket = FakeWebSocket.instances[1];
      streamed(socket);
      socket.message({ type: 'stepFinish', payload: { reason: 'stop' }, timestamp: 2, sequence: 1 });
      socket.onclose?.({ code: 1006 } as CloseEvent);
      expect(idle.onDisconnect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0] * 2);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(channelEvents(superseded)).toEqual([]);
      expect(channelEvents(idle)).toEqual([]);
    });

    it('leaves the box alone after a cancel the box acknowledged', async () => {
      // A turn ends the way the core reads it: stop, endTurn or interrupted, or a lifecycle
      // that says the interrupt was terminal. A drop after that is an idle box, not a lost turn.
      vi.useFakeTimers();
      vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 0));
      const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
      const endings = [
        { reason: 'interrupted' },
        { reason: 'toolUse', lifecycle: { interruptTerminal: true } },
      ];

      for (const [index, payload] of endings.entries()) {
        const events = observer();
        await source.open(`task-${index}`, events, undefined, 'auto');
        const socket = FakeWebSocket.instances[index];
        streamed(socket);
        socket.message({ type: 'stepFinish', payload, timestamp: 2, sequence: 1 });

        socket.onclose?.({ code: 1006 } as CloseEvent);

        expect(events.onDisconnect).toHaveBeenCalledTimes(1);
        expect(channelEvents(events)).toEqual([]);
      }
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0] * 2);
      expect(FakeWebSocket.instances).toHaveLength(endings.length);
    });

    it('treats a box that went silent mid-turn like a drop', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 0));
      const events = observer();
      const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
      await source.open('task-1', events, undefined, 'auto');
      streamed(FakeWebSocket.instances[0]);

      await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS);

      expect(events.onDisconnect).not.toHaveBeenCalled();
      expect(channelEvents(events)[0]).toMatchObject({
        type: 'channelReconnecting',
        payload: { reason: expect.stringContaining('silent') },
      });
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('stops reconnecting when the session closes in the middle of the backoff', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', channelOffered(BOX_WS_URL, 0));
      const events = observer();
      const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
      const connection = await source.open('task-1', events, undefined, 'auto');
      streamed(FakeWebSocket.instances[0]);
      FakeWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent);

      connection.close();
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0] * 2);

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(events.onDisconnect).not.toHaveBeenCalled();
    });
  });

  it('does not count a socket the caller closed as silent', async () => {
    vi.useFakeTimers();
    const events = observer();
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
    const connection = await source.open('task-1', events, undefined, 'websocket');

    connection.close();
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS * 2);

    expect(events.onDisconnect).not.toHaveBeenCalled();
  });

  it('reports an SSE stream that went silent as disconnected, and bytes keep it alive', async () => {
    vi.useFakeTimers();
    const events = observer();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream }));
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');
    const connection = await source.open('task-1', events, undefined, 'http');

    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 1_000);
    expect(events.onDisconnect).not.toHaveBeenCalled();

    // The copilot's SSE ping is `data: {}`: not an event, but bytes, and bytes move the window.
    controller?.enqueue(new TextEncoder().encode('data: {}\r\n\r\n'));
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 1_000);
    expect(events.onDisconnect).not.toHaveBeenCalled();
    expect(events.onEvent).not.toHaveBeenCalled();

    // A read nothing answers is what a half-open stream looks like: the fetch is aborted from
    // here and the disconnect carries the reason.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onDisconnect).toHaveBeenCalledTimes(1);
    expect(String(events.onDisconnect.mock.calls[0][0])).toContain('silent');
    connection.close();
  });

  it('refuses both transports when proactive refresh cannot provide a token', async () => {
    const sessionAuth = auth();
    sessionAuth.ensureFreshSession.mockResolvedValue(false);
    const source = new BrowserAgentTaskEventSource(sessionAuth, 'https://api.mitra.io');

    await expect(source.open('task-1', observer(), undefined, 'websocket')).rejects.toThrow(
      'fresh authenticated app session'
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
