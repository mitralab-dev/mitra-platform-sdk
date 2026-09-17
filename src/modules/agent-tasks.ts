import {
  createAgentTaskSessionManager,
  createAgentTasksModule,
  withAgentTaskSessions,
  type AgentTaskEventConnection,
  type AgentTaskEventObserver,
  type AgentTaskEventSource,
  type AgentTaskSession,
  type AgentTaskSessionOptions,
  type AgentTasksModule,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import type { HttpClient } from '../utils/http-client';
import type { AuthSessionPort } from './auth';
import { AgentInputOutbox, holdSendsWhileOffline } from './agent-outbox';
import { BrowserAgentTaskEventSource } from './agent-session';

/** Where a chat is born: the T3 box that serves the direct channel, or the copilot's runner. */
export type AgentTaskRuntime = 'T3' | 'RUNNER';

/**
 * Core 0.2.3 carries `runtime` from the session options into `POST /api/v1/tasks`. The field is
 * added here by intersection so this SDK compiles against core 0.2.2; the intersection goes when
 * the pin moves.
 */
export type BrowserAgentTaskSessionOptions = AgentTaskSessionOptions & { runtime?: AgentTaskRuntime };

export interface BrowserAgentTasksModule extends AgentTasksModule {
  session(options: BrowserAgentTaskSessionOptions): AgentTaskSession;
}

/**
 * A chat opened over the direct channel is served by the box, so it is born there instead of
 * being adopted on the first channel request, which is what made the first open wait for a
 * boot. An SSE chat never reaches the box and stays on the runner. An explicit `runtime` wins.
 */
function bornOnBox(options: BrowserAgentTaskSessionOptions): BrowserAgentTaskSessionOptions {
  if (!('create' in options) || options.runtime || options.transport === 'http') return options;
  return { ...options, runtime: 'T3' };
}

/**
 * Composes Core's Agent lifecycle with the browser streaming boundary. The session's own
 * sends pass through the outbox, which holds a prompt while the browser is offline or when its
 * request got no response, until the browser is back; the public REST primitive stays plain,
 * so a direct `sendInput` fails as it always did.
 */
export function createBrowserAgentTasksModule(
  httpClient: HttpClient,
  auth: AuthSessionPort,
  apiUrl: string
): BrowserAgentTasksModule {
  const tasks = createAgentTasksModule(httpClient, coreErrors);
  const source = new BrowserAgentTaskEventSource(auth, apiUrl);
  // The outbox speaks to the app through the session's own stream, so it needs the observer
  // the core registered for the task. A close drains the outbox before the observer goes, so
  // a prompt still waiting is reported while the session can still hear it.
  const observers = new Map<string, AgentTaskEventObserver>();
  const outbox = new AgentInputOutbox(tasks, (taskId, event) => observers.get(taskId)?.onEvent(event));
  const eventSource: AgentTaskEventSource = {
    async open(taskId, observer, signal, transport) {
      observers.set(taskId, observer);
      let connection: AgentTaskEventConnection;
      try {
        connection = await source.open(taskId, observer, signal, transport);
      } catch (error) {
        observers.delete(taskId);
        throw error;
      }
      return {
        close: () => {
          outbox.abandon(taskId);
          observers.delete(taskId);
          connection.close();
        },
      };
    },
  };
  const manager = createAgentTaskSessionManager({
    tasks: { ...tasks, sendInput: (taskId, input) => outbox.sendInput(taskId, input) },
    eventSource,
  });
  return withAgentTaskSessions(tasks, {
    session: (options) => holdSendsWhileOffline(manager.session(bornOnBox(options)), outbox),
  });
}

export type {
  AgentMessage as NativeAgentMessage,
  AgentQueueItem,
  AgentSendAndWaitOptions,
  AgentSendOptions,
  AgentSessionTransport,
  AgentTask,
  AgentTaskCreateInput,
  AgentTaskInput,
  AgentTaskListOptions,
  AgentTaskSession as NativeAgentTaskSession,
  AgentTaskSessionEventMap,
  AgentTaskSessionOptions,
  AgentTaskSessionStatus,
  AgentTasksWithSessions,
  AgentTimelineItem as NativeAgentTimelineItem,
  AgentToolEvent as NativeAgentToolEvent,
  AgentTurnResult,
  ExistingAgentTaskSessionOptions,
  NewAgentTaskSessionOptions,
  Page,
  PageOptions,
} from '@mitralab.io/sdk-core';
