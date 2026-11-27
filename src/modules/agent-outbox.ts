import type {
  AgentTaskEvent,
  AgentTaskInput,
  AgentTaskSession,
  AgentTasksModule,
  AgentTurnResult,
} from '@mitralab.io/sdk-core';

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

let clientMessageSequence = 0;

// The core's own generator, so a message held here goes out with an id of the same shape as one
// the core gives: the core takes it through `clientMessageId` when the network is back.
function newClientMessageId(): string {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  return random
    ? random.call((globalThis as { crypto: unknown }).crypto)
    : `m-${Date.now()}-${++clientMessageSequence}`;
}

function idOf(input: AgentTaskInput): string | undefined {
  return input.type === 'message' ? input.clientMessageId : undefined;
}

function withId(clientMessageId: string | undefined): { clientMessageId?: string } {
  return clientMessageId === undefined ? {} : { clientMessageId };
}

function cancelledUnsent(): Error {
  return new Error('Agent prompt was cancelled before it was sent.');
}

// Its first request got no response, so it may have reached the server anyway: the cancel only
// stops the retries.
function cancelledRetry(): Error {
  return new Error('Agent prompt was cancelled: it will not be retried, but its first request may have reached the server.');
}

interface HeldPrompt {
  readonly input: AgentTaskInput;
  attempts: number;
  /** A retry request is out: it may still land, so the prompt can no longer be cancelled. */
  sending: boolean;
  resolve(): void;
  reject(error: Error): void;
  /** Disarms whatever would trigger the next retry. */
  disarm(): void;
}

/** A prompt that has not entered the core yet: the browser said it was offline when it was sent. */
interface GatedPrompt {
  readonly clientMessageId: string;
  resolve(): void;
  reject(error: Error): void;
  disarm(): void;
}

function neverSent(pending: number): Error {
  return new Error(
    `Agent prompt was never sent: the session closed while it waited for the network (${pending} pending).`
  );
}

/** A wrapped session that hears the outbox's frames for its task. */
interface Hearer {
  readonly taskId: () => string | null;
  hear(event: AgentTaskEvent): void;
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
  private readonly gated = new Map<object, GatedPrompt[]>();
  private readonly hearers = new Set<Hearer>();

  constructor(
    private readonly tasks: AgentTasksModule,
    private readonly network: OutboxNetwork = browserNetwork
  ) {}

  /** Returns the way to stop hearing. */
  listen(hearer: Hearer): () => void {
    this.hearers.add(hearer);
    return () => this.hearers.delete(hearer);
  }

  private announce(taskId: string, event: AgentTaskEvent): void {
    for (const hearer of this.hearers) {
      if (hearer.taskId() === taskId) hearer.hear(event);
    }
  }

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
    this.drop(taskId, pending);
  }

  /** True when the browser says there is no network at all. */
  get offline(): boolean {
    return this.network.isOffline();
  }

  /**
   * Keeps a prompt out of the core until the browser reports the network is back, then hands it
   * over through `deliver`. Prompts held for one session leave in the order they arrived. The
   * promise settles when the prompt is handed over, or rejects if the session closes first.
   */
  holdUntilOnline(
    session: object,
    taskId: string | null,
    clientMessageId: string,
    deliver: () => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const prompt: GatedPrompt = { clientMessageId, resolve, reject, disarm: () => undefined };
      this.gated.set(session, [...(this.gated.get(session) ?? []), prompt]);
      const offOnline = this.network.onOnline(() => {
        prompt.disarm();
        const pending = this.gated.get(session) ?? [];
        if (!pending.includes(prompt)) return;
        const rest = pending.filter((candidate) => candidate !== prompt);
        if (rest.length) this.gated.set(session, rest);
        else this.gated.delete(session);
        deliver();
        resolve();
      });
      prompt.disarm = () => {
        offOnline();
        prompt.disarm = () => undefined;
      };
      // Armed before the frame goes out: a listener may take the prompt back inside it.
      if (taskId) {
        this.announce(taskId, {
          type: 'inputUnsent',
          payload: {
            attempt: 0,
            reason: 'The browser is offline.',
            waitingForOnline: true,
            clientMessageId,
          },
          timestamp: Date.now(),
        });
      }
    });
  }

  /**
   * Takes back a prompt this outbox still holds, by the id `send` returned, and rejects its
   * promise: nothing more is sent for it. False when the prompt is not held here (it went
   * out, it was never held, or a retry request for it is out and may still land). A prompt held
   * after a request that got no response may have reached the server with that first request.
   */
  cancelUnsent(session: object, taskId: string | null, clientMessageId: string): boolean {
    const gated = this.gated.get(session) ?? [];
    const waiting = gated.find((prompt) => prompt.clientMessageId === clientMessageId);
    if (waiting) {
      const rest = gated.filter((prompt) => prompt !== waiting);
      if (rest.length) this.gated.set(session, rest);
      else this.gated.delete(session);
      waiting.disarm();
      waiting.reject(cancelledUnsent());
      return true;
    }
    if (!taskId) return false;
    const held = this.held.get(taskId)?.find((prompt) => idOf(prompt.input) === clientMessageId);
    if (!held || held.sending) return false;
    this.release(taskId, held);
    held.disarm();
    held.reject(cancelledRetry());
    return true;
  }

  /** The session is closing with prompts that never entered the core: same report as `abandon`. */
  abandonGated(session: object, taskId: string | null): void {
    const pending = this.gated.get(session);
    if (!pending?.length) return;
    this.gated.delete(session);
    this.drop(taskId, pending);
  }

  private drop(taskId: string | null, pending: Array<GatedPrompt | HeldPrompt>): void {
    const error = neverSent(pending.length);
    if (taskId) {
      const clientMessageIds = pending.flatMap((prompt) => {
        const id = 'input' in prompt ? idOf(prompt.input) : prompt.clientMessageId;
        return id === undefined ? [] : [id];
      });
      this.announce(taskId, {
        type: 'error',
        payload: { code: 'INPUT_UNSENT', message: error.message, clientMessageIds },
        timestamp: Date.now(),
      });
    }
    for (const prompt of pending) {
      prompt.disarm();
      prompt.reject(error);
    }
  }

  private hold(taskId: string, input: AgentTaskInput, cause: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const prompt: HeldPrompt = {
        input,
        attempts: 1,
        sending: false,
        resolve,
        reject,
        disarm: () => undefined,
      };
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
    // Armed before the frame goes out: a listener may take the prompt back inside it.
    this.announce(taskId, {
      type: 'inputUnsent',
      payload: {
        attempt: prompt.attempts,
        reason: reasonOf(cause),
        waitingForOnline,
        ...(retryInMs === undefined ? {} : { retryInMs }),
        ...withId(idOf(prompt.input)),
      },
      timestamp: Date.now(),
    });
  }

  private async retry(taskId: string, prompt: HeldPrompt): Promise<void> {
    if (!this.isHeld(taskId, prompt)) return;
    prompt.attempts += 1;
    prompt.sending = true;
    try {
      await this.tasks.sendInput(taskId, prompt.input);
    } catch (error) {
      prompt.sending = false;
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
      payload: { attempts: prompt.attempts, ...withId(idOf(prompt.input)) },
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

/** The session `agentTasks.session` returns: the core's, plus taking back a prompt held here. */
export interface BrowserAgentTaskSession extends AgentTaskSession {
  /**
   * Takes back a message still held, by the id `send` returned or the `inputUnsent` frame
   * carries: its `sendAndWait` rejects and nothing more is sent for it. One held after a request
   * that got no response may have reached the server with that request; the cancel only stops
   * the retries. True when it was taken back; false when it is not held any more (it went out,
   * or is on its way).
   */
  cancelUnsent(clientMessageId: string): boolean;
}

type Listener = (payload: unknown) => void;

/** As the core's own emit: a listener that throws never stops the others nor the caller. */
function notify(listeners: ReadonlySet<Listener>, payload: unknown): void {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      // The app's listener failed; the session goes on.
    }
  }
}

/**
 * The core's send opens the channel and reads the turn baseline before the prompt goes out,
 * and with the browser offline every one of those requests fails before `sendInput` is ever
 * called, so the outbox above never sees the prompt and the core reports it as failed. While
 * the browser says it is offline a prompt therefore does not enter the core at all: it waits
 * in the outbox and is sent, in order, once the network is back. Everything else on the
 * session is the core's, untouched.
 *
 * `send` returns the id the message goes out with, also for a prompt held offline: the id is
 * given here and the core sends with it once the network is back, so the screen can show that
 * message as waiting and `cancelUnsent` can take it back.
 *
 * The outbox frames reach the app through this wrapper's own `raw` and `error` listeners: a chat
 * on the direct channel is served by Core without the event source, so no observer of this SDK
 * sees its stream.
 */
export function holdSendsWhileOffline(
  session: AgentTaskSession,
  outbox: AgentInputOutbox
): BrowserAgentTaskSession {
  const passThrough = (prompt: string) => !outbox.offline || !prompt.trim() || session.status === 'closed';
  const raws = new Set<Listener>();
  const errors = new Set<Listener>();
  const outboxListeners: Partial<Record<string, Set<Listener>>> = { raw: raws, error: errors };
  const stopHearing = outbox.listen({
    taskId: () => session.taskId,
    hear: (event) => {
      // Two `session({ taskId })` calls share one core session: the closed wrapper stays quiet.
      if (session.status === 'closed') return;
      notify(raws, event);
      if (event.type !== 'error') return;
      // The outbox's only error frame is INPUT_UNSENT, which always carries its code.
      const payload = event.payload as { code: string; message: string };
      notify(errors, { code: payload.code, error: payload.message });
    },
  });
  const gated: Pick<BrowserAgentTaskSession, 'send' | 'sendAndWait' | 'close' | 'on' | 'cancelUnsent'> = {
    on: (event, handler) => {
      const off = session.on(event, handler);
      const own = outboxListeners[event];
      if (!own) return off;
      own.add(handler as Listener);
      return () => {
        own.delete(handler as Listener);
        off();
      };
    },
    send: (prompt, options) => {
      if (passThrough(prompt)) return session.send(prompt, options);
      const clientMessageId = options?.clientMessageId || newClientMessageId();
      void outbox
        .holdUntilOnline(session, session.taskId, clientMessageId, () =>
          session.send(prompt, { ...options, clientMessageId }))
        .catch(() => undefined);
      return clientMessageId;
    },
    sendAndWait: (prompt, options) => {
      if (passThrough(prompt)) return session.sendAndWait(prompt, options);
      const clientMessageId = options?.clientMessageId || newClientMessageId();
      let turn: Promise<AgentTurnResult> | undefined;
      return outbox
        .holdUntilOnline(session, session.taskId, clientMessageId, () => {
          turn = session.sendAndWait(prompt, { ...options, clientMessageId });
        })
        .then(() => turn as Promise<AgentTurnResult>);
    },
    cancelUnsent: (clientMessageId) => outbox.cancelUnsent(session, session.taskId, clientMessageId),
    close: () => {
      if (session.status !== 'closed') {
        outbox.abandonGated(session, session.taskId);
        if (session.taskId) outbox.abandon(session.taskId);
      }
      stopHearing();
      raws.clear();
      errors.clear();
      session.close();
    },
  };
  return new Proxy(session, {
    get: (target, key) => (key in gated ? gated[key as keyof typeof gated] : Reflect.get(target, key, target)),
  }) as BrowserAgentTaskSession;
}
