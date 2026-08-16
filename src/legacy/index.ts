/**
 * Legacy `mitra-interactions-sdk` surface, re-exported so an application can
 * swap the legacy package for `@mitralab.io/platform-sdk` without rewriting
 * call sites first.
 *
 * Everything here is deprecated. Parts of it have no equivalent on the new
 * surface yet (SSO login, the Agent SDK, public Server Functions, the record
 * API) and stay supported until the platform ships one.
 *
 * The four legacy entry points that produce a session are wrapped so the
 * resulting session also lands in this SDK. Every other export is the legacy
 * implementation itself.
 *
 * @module
 */

import {
  callIntegrationMitra as legacyCallIntegrationMitra,
  configureSdkMitra as legacyConfigureSdkMitra,
  createMitraInstance as legacyCreateMitraInstance,
  createRecordMitra as legacyCreateRecordMitra,
  createRecordsBatchMitra as legacyCreateRecordsBatchMitra,
  deleteRecordMitra as legacyDeleteRecordMitra,
  exchangeSsoCodeMitra as legacyExchangeSsoCodeMitra,
  executePublicServerFunctionAsyncMitra as legacyExecutePublicServerFunctionAsyncMitra,
  executePublicServerFunctionMitra as legacyExecutePublicServerFunctionMitra,
  executeServerFunctionAsyncMitra as legacyExecuteServerFunctionAsyncMitra,
  executeServerFunctionMitra as legacyExecuteServerFunctionMitra,
  getAgentTaskMitra as legacyGetAgentTaskMitra,
  getConfig as legacyGetConfig,
  getPublicServerFunctionExecutionMitra as legacyGetPublicServerFunctionExecutionMitra,
  getRecordMitra as legacyGetRecordMitra,
  listIntegrationsMitra as legacyListIntegrationsMitra,
  listRecordsMitra as legacyListRecordsMitra,
  loginMitra as legacyLoginMitra,
  loginWithGoogleMitra as legacyLoginWithGoogleMitra,
  loginWithMicrosoftMitra as legacyLoginWithMicrosoftMitra,
  manageAgentChatMitra as legacyManageAgentChatMitra,
  manageAgentCredentialMitra as legacyManageAgentCredentialMitra,
  patchRecordMitra as legacyPatchRecordMitra,
  refreshTokenSilently as legacyRefreshTokenSilently,
  resolveProjectId as legacyResolveProjectId,
  stopServerFunctionExecutionMitra as legacyStopServerFunctionExecutionMitra,
  updateRecordMitra as legacyUpdateRecordMitra,
} from 'mitra-interactions-sdk';
import { adoptLegacySession } from './bridge';

/**
 * @deprecated Use `createClient`, which configures the legacy SDK for you.
 * Calling this directly replaces the legacy configuration and drops the session
 * bridge installed by `createClient`.
 */
export const configureSdkMitra = legacyConfigureSdkMitra;

/**
 * @deprecated Use `createClient` instead.
 */
export const createMitraInstance = legacyCreateMitraInstance;

/**
 * @deprecated Use `mitra.config` instead.
 */
export const getConfig = legacyGetConfig;

/**
 * @deprecated Use `mitra.config.appId` instead.
 */
export const resolveProjectId = legacyResolveProjectId;

/**
 * @deprecated No replacement yet; still supported. SSO is the only login the
 * platform offers today, and `mitra.auth.signIn` does not cover it.
 */
export const loginMitra: typeof legacyLoginMitra = async (method, options) => {
  const session = await legacyLoginMitra(method, options);
  adoptLegacySession(session);
  return session;
};

/**
 * @deprecated No replacement yet; still supported. SSO is the only login the
 * platform offers today, and `mitra.auth.signIn` does not cover it.
 */
export const loginWithGoogleMitra: typeof legacyLoginWithGoogleMitra = async (options) => {
  const session = await legacyLoginWithGoogleMitra(options);
  adoptLegacySession(session);
  return session;
};

/**
 * @deprecated No replacement yet; still supported. SSO is the only login the
 * platform offers today, and `mitra.auth.signIn` does not cover it.
 */
export const loginWithMicrosoftMitra: typeof legacyLoginWithMicrosoftMitra = async (options) => {
  const session = await legacyLoginWithMicrosoftMitra(options);
  adoptLegacySession(session);
  return session;
};

/**
 * @deprecated No replacement yet; still supported. Completes the redirect leg
 * of the legacy SSO flow.
 */
export const exchangeSsoCodeMitra: typeof legacyExchangeSsoCodeMitra = async (options) => {
  const session = await legacyExchangeSsoCodeMitra(options);
  adoptLegacySession(session);
  return session;
};

/**
 * @deprecated Use `mitra.auth.refreshSession` instead. This is the low-level
 * primitive: it returns a session without applying it to either SDK.
 */
export const refreshTokenSilently = legacyRefreshTokenSilently;

/**
 * @deprecated Use `mitra.functions.execute` instead. Note that the new method
 * is asynchronous and returns the created execution rather than its output.
 */
export const executeServerFunctionMitra = legacyExecuteServerFunctionMitra;

/**
 * @deprecated Use `mitra.functions.execute` instead.
 */
export const executeServerFunctionAsyncMitra = legacyExecuteServerFunctionAsyncMitra;

/**
 * @deprecated No replacement yet; still supported. `mitra.functions.execute`
 * always sends the caller's session and cannot run a public Server Function.
 */
export const executePublicServerFunctionMitra = legacyExecutePublicServerFunctionMitra;

/**
 * @deprecated No replacement yet; still supported. `mitra.functions.execute`
 * always sends the caller's session and cannot run a public Server Function.
 */
export const executePublicServerFunctionAsyncMitra = legacyExecutePublicServerFunctionAsyncMitra;

/**
 * @deprecated No replacement yet; still supported. The new Functions module has
 * no execution lookup.
 */
export const getPublicServerFunctionExecutionMitra = legacyGetPublicServerFunctionExecutionMitra;

/**
 * @deprecated No replacement yet; still supported. The new Functions module has
 * no cancellation method.
 */
export const stopServerFunctionExecutionMitra = legacyStopServerFunctionExecutionMitra;

/**
 * @deprecated Use `mitra.integration.execute` instead.
 */
export const callIntegrationMitra = legacyCallIntegrationMitra;

/**
 * @deprecated No replacement yet; still supported. The new Integration module
 * executes a known integration but does not list them.
 */
export const listIntegrationsMitra = legacyListIntegrationsMitra;

/**
 * @deprecated Use `mitra.entities.<Table>.list` instead.
 */
export const listRecordsMitra = legacyListRecordsMitra;

/**
 * @deprecated Use `mitra.entities.<Table>.get` instead.
 */
export const getRecordMitra = legacyGetRecordMitra;

/**
 * @deprecated Use `mitra.entities.<Table>.create` instead.
 */
export const createRecordMitra = legacyCreateRecordMitra;

/**
 * @deprecated Use `mitra.entities.<Table>.bulkCreate` instead.
 */
export const createRecordsBatchMitra = legacyCreateRecordsBatchMitra;

/**
 * @deprecated Use `mitra.entities.<Table>.update` instead.
 */
export const updateRecordMitra = legacyUpdateRecordMitra;

/**
 * @deprecated Use `mitra.entities.<Table>.update` instead, which also sends a
 * partial payload.
 */
export const patchRecordMitra = legacyPatchRecordMitra;

/**
 * @deprecated Use `mitra.entities.<Table>.delete` instead.
 */
export const deleteRecordMitra = legacyDeleteRecordMitra;

/**
 * @deprecated No replacement yet; still supported. The Agent SDK has no
 * equivalent on the new surface.
 */
export const getAgentTaskMitra = legacyGetAgentTaskMitra;

/**
 * @deprecated No replacement yet; still supported. The Agent SDK has no
 * equivalent on the new surface.
 */
export const manageAgentChatMitra = legacyManageAgentChatMitra;

/**
 * @deprecated No replacement yet; still supported. The Agent SDK has no
 * equivalent on the new surface.
 */
export const manageAgentCredentialMitra = legacyManageAgentCredentialMitra;

/**
 * Types of the legacy surface. Deprecated alongside the functions that use
 * them; they carry no deprecation tag of their own so that a call site keeps
 * exactly one warning.
 */
export type {
  AgentChat,
  AgentCredentialStatus,
  AgentDeltaEvent,
  AgentErrorEvent,
  AgentMessage,
  AgentModel,
  AgentProvider,
  AgentQueueChangeEvent,
  AgentRawEvent,
  AgentStatusChangeEvent,
  AgentTaskCreatedEvent,
  AgentTaskEventMap,
  AgentTaskEventName,
  AgentTaskSession,
  AgentTaskStatus,
  AgentTaskTransport,
  AgentTimelineItem,
  AgentToolEvent,
  AgentTurnEndEvent,
  AgentType,
  AuthAgentCredentialResult,
  CallIntegrationOptions,
  CallIntegrationResponse,
  ChatManageAction,
  ConnectAgentCredentialResult,
  CreateRecordOptions,
  CreateRecordsBatchOptions,
  CredentialAction,
  DeleteAgentChatResult,
  DeleteRecordOptions,
  DeviceAuthAgentCredentialResult,
  ExecutePublicServerFunctionAsyncResponse,
  ExecutePublicServerFunctionOptions,
  ExecutePublicServerFunctionResponse,
  ExecuteServerFunctionAsyncOptions,
  ExecuteServerFunctionAsyncResponse,
  ExecuteServerFunctionOptions,
  ExecuteServerFunctionResponse,
  GetAgentTaskCreateOptions,
  GetAgentTaskOpenOptions,
  GetAgentTaskOptions,
  GetPublicServerFunctionExecutionOptions,
  GetPublicServerFunctionExecutionResponse,
  GetRecordOptions,
  IntegrationResponse,
  ListAgentModelsResult,
  ListAgentProvidersResult,
  ListIntegrationsOptions,
  ListRecordsOptions,
  ListRecordsResponse,
  LoginOptions,
  LoginResponse,
  ManageAgentChatDeleteOptions,
  ManageAgentChatListOptions,
  ManageAgentChatOptions,
  ManageAgentChatRenameOptions,
  ManageAgentCredentialOptions,
  MitraConfig,
  MitraInstance,
  PatchRecordOptions,
  QueuedItem,
  RenameAgentChatResult,
  SendOptions,
  StopServerFunctionExecutionOptions,
  StopServerFunctionExecutionResponse,
  UpdateRecordOptions,
} from 'mitra-interactions-sdk';
