import { stripTrailingSlashes } from '../utils/url';
import type {
  AgentSessionTransport,
  AgentTaskEvent,
  AgentTaskEventConnection,
  AgentTaskEventObserver,
  AgentTaskEventSource,
} from '@mitralab.io/sdk-core';
import type { AuthSessionPort } from './auth';

const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Silence that counts as a dead channel. The copilot pings every 25 s on both transports, so
 * two missed pings is a network, proxy or suspended tab that killed the channel without closing
 * it. Without this a half-open channel never produces `onclose` nor ends the SSE read, so
 * `onDisconnect` never fires and the recovery the core already has never starts.
 */
export const SILENCE_TIMEOUT_MS = 60_000;

/** Rearmed by every frame, ping included. Firing means the channel is gone, not idle. */
class SilenceWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onSilence: () => void) {}

  touch(): void {
    this.clear();
    this.timer = globalThis.setTimeout(this.onSilence, SILENCE_TIMEOUT_MS);
  }

  clear(): void {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function silenceError(transport: string): Error {
  return new Error(`Agent ${transport} went silent for ${SILENCE_TIMEOUT_MS / 1000}s.`);
}

function stripBearer(token: string): string {
  return token.replace(/^Bearer\s+/i, '');
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function expectEvent(value: unknown): AgentTaskEvent | null {
  const event = asObject(value);
  if (!event || typeof event.type !== 'string' || !event.type) return null;
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) return null;
  if (event.sequence !== undefined && (
    typeof event.sequence !== 'number'
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 0
  )) return null;
  return {
    type: event.type,
    payload: event.payload,
    timestamp: event.timestamp,
    ...(typeof event.sequence === 'number' ? { sequence: event.sequence } : {}),
  };
}

function parseEvent(raw: unknown): AgentTaskEvent | null {
  if (typeof raw !== 'string') return expectEvent(raw);
  try {
    return expectEvent(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function isNormalClose(event: CloseEvent): boolean {
  return event.code === 1000 || event.code === 4409;
}

/** Browser WebSocket and SSE boundary for the Core-owned Agent session lifecycle. */
export class BrowserAgentTaskEventSource implements AgentTaskEventSource {
  private readonly apiUrl: string;
  private readonly sseFallbackTasks = new Set<string>();

  constructor(
    private readonly auth: AuthSessionPort,
    apiUrl: string
  ) {
    this.apiUrl = stripTrailingSlashes(apiUrl);
  }

  async open(
    taskId: string,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal,
    transport: AgentSessionTransport = 'auto'
  ): Promise<AgentTaskEventConnection> {
    if (transport === 'http') return this.openSse(taskId, observer, signal);
    if (transport === 'websocket') return this.openWebSocket(taskId, observer, signal);

    if (this.sseFallbackTasks.has(taskId)) {
      return this.wrapAutoConnection(taskId, await this.openSse(taskId, observer, signal));
    }

    try {
      const connection = await this.openWebSocket(taskId, {
        ...observer,
        onDisconnect: (error) => {
          this.sseFallbackTasks.add(taskId);
          observer.onDisconnect(error);
        },
      }, signal);
      return this.wrapAutoConnection(taskId, connection);
    } catch {
      this.sseFallbackTasks.add(taskId);
      return this.wrapAutoConnection(taskId, await this.openSse(taskId, observer, signal));
    }
  }

  private wrapAutoConnection(
    taskId: string,
    connection: AgentTaskEventConnection
  ): AgentTaskEventConnection {
    return {
      close: () => {
        this.sseFallbackTasks.delete(taskId);
        connection.close();
      },
    };
  }

  private async requireFreshToken(): Promise<string> {
    const fresh = await this.auth.ensureFreshSession();
    const token = this.auth.accessToken;
    if (!fresh || !token) {
      throw new Error('A fresh authenticated app session is required for Agent streaming.');
    }
    return token;
  }

  private async openWebSocket(
    taskId: string,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal
  ): Promise<AgentTaskEventConnection> {
    if (typeof globalThis.WebSocket !== 'function') {
      throw new TypeError('WebSocket is not available.');
    }
    if (signal?.aborted) throw signal.reason ?? new Error('Agent WebSocket connection aborted.');

    const token = await this.requireFreshToken();
    const url = `${this.apiUrl.replace(/^http/i, 'ws')}/copilot/ws/tasks/${encodeURIComponent(taskId)}?token=${encodeURIComponent(stripBearer(token))}`;

    return new Promise((resolve, reject) => {
      const socket = new globalThis.WebSocket(url);
      let opened = false;
      let intentionalClose = false;
      let settled = false;

      const removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
      const clearHandshake = () => {
        globalThis.clearTimeout(timer);
        removeAbortListener();
      };
      const rejectHandshake = (error: Error) => {
        if (settled) return;
        settled = true;
        intentionalClose = true;
        clearHandshake();
        socket.close();
        reject(error);
      };
      const watchdog = new SilenceWatchdog(() => {
        if (intentionalClose) return;
        // Reported from here, not from `onclose`: closing a half-open socket can sit in
        // CLOSING for as long as the browser waits for a peer that is already gone.
        intentionalClose = true;
        removeAbortListener();
        observer.onDisconnect(silenceError('WebSocket'));
        socket.close(1000, 'Client closed');
      });
      const close = () => {
        if (intentionalClose) return;
        intentionalClose = true;
        watchdog.clear();
        removeAbortListener();
        socket.close(1000, 'Client closed');
      };
      const onAbort = () => {
        if (!opened) {
          rejectHandshake(signal?.reason instanceof Error
            ? signal.reason
            : new Error('Agent WebSocket connection aborted.'));
          return;
        }
        close();
      };
      const timer = globalThis.setTimeout(() => {
        rejectHandshake(new Error('Timed out connecting to the Agent WebSocket.'));
      }, CONNECT_TIMEOUT_MS);

      signal?.addEventListener('abort', onAbort, { once: true });
      socket.onopen = () => {
        if (settled) return;
        opened = true;
        settled = true;
        globalThis.clearTimeout(timer);
        watchdog.touch();
        resolve({ close });
      };
      socket.onerror = () => {
        if (!opened) rejectHandshake(new Error('Failed to connect to the Agent WebSocket.'));
      };
      socket.onmessage = (message) => {
        // Any frame proves the channel is alive, ping included: touch before parsing.
        watchdog.touch();
        const event = parseEvent(message.data);
        if (event) observer.onEvent(event);
      };
      socket.onclose = (event) => {
        globalThis.clearTimeout(timer);
        watchdog.clear();
        removeAbortListener();
        if (!opened) {
          rejectHandshake(new Error(`Agent WebSocket closed during handshake (${event.code}).`));
          return;
        }
        if (!intentionalClose && !isNormalClose(event)) {
          observer.onDisconnect(new Error(`Agent WebSocket disconnected (${event.code}).`));
        }
      };
    });
  }

  private async openSse(
    taskId: string,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal
  ): Promise<AgentTaskEventConnection> {
    if (signal?.aborted) throw signal.reason ?? new Error('Agent SSE connection aborted.');
    const requestToken = await this.requireFreshToken();
    const abort = new AbortController();
    let intentionalClose = false;
    let disconnected = false;
    const url = `${this.apiUrl}/copilot/api/v1/tasks/${encodeURIComponent(taskId)}/events`;
    const request = (token: string) => globalThis.fetch(url, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${stripBearer(token)}` },
      signal: abort.signal,
    });
    const onAbort = () => {
      intentionalClose = true;
      abort.abort(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let response = await request(requestToken);
    if (response.status === 401 && await this.auth.handleUnauthorized(requestToken)) {
      const currentToken = this.auth.accessToken;
      if (currentToken) response = await request(currentToken);
    }
    if (!response.ok || !response.body) {
      signal?.removeEventListener('abort', onAbort);
      abort.abort();
      throw new Error(`Agent SSE connection failed (${response.status}).`);
    }

    const disconnect = (error?: unknown) => {
      if (disconnected || intentionalClose || signal?.aborted) return;
      disconnected = true;
      observer.onDisconnect(error);
    };
    void this.readSse(response.body, observer, abort)
      .then(() => disconnect())
      .catch((error: unknown) => disconnect(error))
      .finally(() => signal?.removeEventListener('abort', onAbort));

    return {
      close: () => {
        if (intentionalClose) return;
        intentionalClose = true;
        signal?.removeEventListener('abort', onAbort);
        abort.abort();
      },
    };
  }

  private async readSse(
    body: ReadableStream<Uint8Array>,
    observer: AgentTaskEventObserver,
    abort: AbortController
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // A read that nothing answers is the SSE shape of a half-open channel: the copilot's ping
    // is bytes like any other, so silence past the window is the stream being gone. The read
    // is raced against the window rather than relying on the abort to fail it, because not
    // every fetch fails a pending read the moment its signal fires.
    let breakSilence!: (error: Error) => void;
    const silence = new Promise<never>((_, reject) => { breakSilence = reject; });
    const watchdog = new SilenceWatchdog(() => breakSilence(silenceError('SSE stream')));
    try {
      watchdog.touch();
      while (!abort.signal.aborted) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await Promise.race([reader.read(), silence]);
        } catch (error) {
          abort.abort();
          await reader.cancel().catch(() => undefined);
          throw error;
        }
        watchdog.touch();
        const { done, value } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = /\r?\n\r?\n/.exec(buffer);
        while (separator?.index !== undefined) {
          const block = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = block.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          const event = data ? parseEvent(data) : null;
          if (event) observer.onEvent(event);
          separator = /\r?\n\r?\n/.exec(buffer);
        }
      }
    } finally {
      watchdog.clear();
      reader.releaseLock();
    }
  }
}
