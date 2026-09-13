import type { AgentTaskEvent, AgentTaskInput, AgentTasksModule } from '@mitralab.io/sdk-core';

/**
 * Waits between retries of a prompt whose request got no response, while the browser does not
 * say it is offline. Bounded: past the list the prompt fails the way it always did. When the
 * browser does say it is offline, the prompt waits for the `online` event instead, however
 * long that takes: retrying into a network that is known to be down burns attempts for nothing.
 */
export const OUTBOX_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 40_000];

export interface OutboxNetwork {
  /** True only when the browser says there is no network. Unknown counts as online. */
  isOffline(): boolean;
  /** Calls the listener when the browser reports the network is back. Returns the unsubscribe. */
  onOnline(listener: () => void): () => void;
}

interface NetworkGlobals {
  navigator?: { onLine?: boolean };
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export const browserNetwork: OutboxNetwork = {
  isOffline: () => (globalThis as NetworkGlobals).navigator?.onLine === false,
  onOnline: (listener) => {
    const target = globalThis as NetworkGlobals;
    if (typeof target.addEventListener !== 'function') return () => undefined;
    target.addEventListener('online', listener);
    return () => target.removeEventListener?.('online', listener);
  },
};

/**
 * `fetch` rejects with a TypeError when no response came back at all. Every other failure
 * either carries the server's answer (`MitraApiError`) or never left this SDK, and neither is
 * retried: a prompt the server refused would be refused again, and one it accepted would be
 * sent twice. The TypeError still covers the request that reached the server and lost its
 * response on the way back; only a server-side idempotency key could make that retry safe.
 */
function sendGotNoResponse(error: unknown): boolean {
  return error instanceof TypeError;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface HeldPrompt {
  readonly input: AgentTaskInput;
  attempts: number;
  resolve(): void;
  reject(error: Error): void;
  /** Disarms whatever would trigger the next retry. */
  disarm(): void;
}

/**
 * Prompts whose request never got a response, kept per task until the network takes them or
 * the session gives up on them. The core's `send()` awaits the promise, so the turn it started
 * stays open while the prompt waits; what the app sees meanwhile comes through the session's
 * `raw` event as `inputUnsent` and `inputSent` frames, and as an `error` frame if the session
 * closes first. Nothing here changes the message: the retry is the same request again.
 */
export class AgentInputOutbox {
  private readonly held = new Map<string, HeldPrompt[]>();

  constructor(
    private readonly tasks: AgentTasksModule,
    private readonly announce: (taskId: string, event: AgentTaskEvent) => void,
    private readonly network: OutboxNetwork = browserNetwork
  ) {}

  async sendInput(taskId: string, input: AgentTaskInput): Promise<void> {
    try {
      await this.tasks.sendInput(taskId, input);
    } catch (error) {
      if (input.type !== 'message' || !sendGotNoResponse(error)) throw error;
      await this.hold(taskId, input, error);
    }
  }

  /** The session is closing: a prompt still waiting is reported, never dropped in silence. */
  abandon(taskId: string): void {
    const pending = this.held.get(taskId);
    if (!pending?.length) return;
    this.held.delete(taskId);
    const error = new Error(
      `Agent prompt was never sent: the session closed while it waited for the network (${pending.length} pending).`
    );
    this.announce(taskId, {
      type: 'error',
      payload: { code: 'INPUT_UNSENT', message: error.message },
      timestamp: Date.now(),
    });
    for (const prompt of pending) {
      prompt.disarm();
      prompt.reject(error);
    }
  }

  private hold(taskId: string, input: AgentTaskInput, cause: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const prompt: HeldPrompt = { input, attempts: 1, resolve, reject, disarm: () => undefined };
      this.held.set(taskId, [...(this.held.get(taskId) ?? []), prompt]);
      this.schedule(taskId, prompt, cause);
    });
  }

  private schedule(taskId: string, prompt: HeldPrompt, cause: unknown): void {
    const waitingForOnline = this.network.isOffline();
    const retryInMs = waitingForOnline ? undefined : OUTBOX_DELAYS_MS[prompt.attempts - 1];
    if (!waitingForOnline && retryInMs === undefined) {
      this.release(taskId, prompt);
      prompt.reject(new Error(
        `Agent prompt was not sent after ${prompt.attempts} attempts: ${reasonOf(cause)}`
      ));
      return;
    }
    this.announce(taskId, {
      type: 'inputUnsent',
      payload: {
        attempt: prompt.attempts,
        reason: reasonOf(cause),
        waitingForOnline,
        ...(retryInMs === undefined ? {} : { retryInMs }),
      },
      timestamp: Date.now(),
    });
    const retry = () => {
      prompt.disarm();
      void this.retry(taskId, prompt);
    };
    const timer = retryInMs === undefined ? null : globalThis.setTimeout(retry, retryInMs);
    const offOnline = this.network.onOnline(retry);
    prompt.disarm = () => {
      if (timer !== null) globalThis.clearTimeout(timer);
      offOnline();
      prompt.disarm = () => undefined;
    };
  }

  private async retry(taskId: string, prompt: HeldPrompt): Promise<void> {
    prompt.attempts += 1;
    try {
      await this.tasks.sendInput(taskId, prompt.input);
    } catch (error) {
      // Abandoned while the request was out: already reported, nothing left to decide.
      if (!this.isHeld(taskId, prompt)) return;
      if (!sendGotNoResponse(error)) {
        this.release(taskId, prompt);
        prompt.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.schedule(taskId, prompt, error);
      return;
    }
    if (!this.isHeld(taskId, prompt)) return;
    this.release(taskId, prompt);
    this.announce(taskId, {
      type: 'inputSent',
      payload: { attempts: prompt.attempts },
      timestamp: Date.now(),
    });
    prompt.resolve();
  }

  private isHeld(taskId: string, prompt: HeldPrompt): boolean {
    return this.held.get(taskId)?.includes(prompt) ?? false;
  }

  private release(taskId: string, prompt: HeldPrompt): void {
    const rest = (this.held.get(taskId) ?? []).filter((candidate) => candidate !== prompt);
    if (rest.length) this.held.set(taskId, rest);
    else this.held.delete(taskId);
  }
}
