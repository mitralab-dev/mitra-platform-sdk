import {
  createAgentTaskSessionManager,
  createAgentTasksModule,
  withAgentTaskSessions,
  type AgentTaskEventConnection,
  type AgentTaskEventObserver,
  type AgentTaskEventSource,
  type AgentTasksWithSessions,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import type { HttpClient } from '../utils/http-client';
import type { AuthSessionPort } from './auth';
import { AgentInputOutbox } from './agent-outbox';
import { BrowserAgentTaskEventSource } from './agent-session';

/**
 * Composes Core's Agent lifecycle with the browser streaming boundary. The session's own
 * sends pass through the outbox, which holds a prompt the network lost until the browser is
 * back; the public REST primitive stays plain, so a direct `sendInput` fails as it always did.
 */
export function createBrowserAgentTasksModule(
  httpClient: HttpClient,
  auth: AuthSessionPort,
  apiUrl: string
): AgentTasksWithSessions {
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
  return withAgentTaskSessions(tasks, manager);
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
