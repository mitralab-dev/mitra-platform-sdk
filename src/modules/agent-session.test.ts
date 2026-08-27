import type { AgentTaskEventObserver } from '@mitralab.io/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionPort } from './auth';
import { BrowserAgentTaskEventSource } from './agent-session';

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  static autoOpen = true;
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn((code = 1000) => this.onclose?.({ code } as CloseEvent));

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

describe('BrowserAgentTaskEventSource', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    FakeWebSocket.autoOpen = true;
    vi.stubGlobal('WebSocket', FakeWebSocket);
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body: openStream() });
    vi.stubGlobal('fetch', fetchMock);
    const source = new BrowserAgentTaskEventSource(auth(), 'https://api.mitra.io');

    const auto = source.open('task-1', observer(), undefined, 'auto');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].onerror?.();
    const connection = await auto;
    expect(fetchMock).toHaveBeenCalledOnce();
    connection.close();

    const explicit = source.open('task-2', observer(), undefined, 'websocket');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances[1].onerror?.();
    await expect(explicit).rejects.toThrow('Failed to connect');
    expect(fetchMock).toHaveBeenCalledOnce();
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
