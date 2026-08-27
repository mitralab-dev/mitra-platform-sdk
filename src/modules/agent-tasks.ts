import {
  createAgentTaskSessionManager,
  createAgentTasksModule,
  withAgentTaskSessions,
  type AgentTasksWithSessions,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import type { HttpClient } from '../utils/http-client';
import type { AuthSessionPort } from './auth';
import { BrowserAgentTaskEventSource } from './agent-session';

/** Composes Core's Agent lifecycle with the browser streaming boundary. */
export function createBrowserAgentTasksModule(
  httpClient: HttpClient,
  auth: AuthSessionPort,
  apiUrl: string
): AgentTasksWithSessions {
  const tasks = createAgentTasksModule(httpClient, coreErrors);
  const manager = createAgentTaskSessionManager({
    tasks,
    eventSource: new BrowserAgentTaskEventSource(auth, apiUrl),
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
