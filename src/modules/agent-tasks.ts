import {
  createAgentTaskSessionManager,
  createAgentTasksModule,
  withAgentTaskSessions,
  type AgentTasksWithSessions,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import type { HttpClient } from '../utils/http-client';
import type { AuthSessionPort } from './auth';
import { AgentInputOutbox, holdSendsWhileOffline } from './agent-outbox';
import { BrowserAgentTaskEventSource } from './agent-session';

/**
 * Composes Core's Agent lifecycle with the browser boundary. Core owns the direct channel to
 * the chat's box, message and interrupt included; this SDK supplies the Copilot stream Core
 * falls back to and the outbox, which takes what Core sends by REST and holds a prompt while the
 * browser is offline or when its request got no response, until the browser is back. The public
 * REST primitive stays plain, so a direct `sendInput` fails as it always did.
 *
 * `channelHttpClient` asks the Copilot for the channel. It carries no global `onError`: a chat
 * whose box cannot be had falls back and says so with `channelDeclined`, which is not an error
 * for the app.
 */
export function createBrowserAgentTasksModule(
  httpClient: HttpClient,
  auth: AuthSessionPort,
  apiUrl: string,
  channelHttpClient: HttpClient = httpClient
): AgentTasksWithSessions {
  const tasks = createAgentTasksModule(httpClient, coreErrors);
  const outbox = new AgentInputOutbox(tasks);
  const manager = createAgentTaskSessionManager({
    tasks: {
      ...tasks,
      channel: createAgentTasksModule(channelHttpClient, coreErrors).channel,
      sendInput: (taskId, input) => outbox.sendInput(taskId, input),
    },
    eventSource: new BrowserAgentTaskEventSource(auth, apiUrl),
    directChannel: { apiUrl },
  });
  // The channel answer carries the box grant: it is Core's to follow, not the app's to read.
  const publicTasks = { ...tasks };
  delete publicTasks.channel;
  return withAgentTaskSessions(publicTasks, {
    session: (options) => holdSendsWhileOffline(manager.session(options), outbox),
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
  AgentTaskRuntime,
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
