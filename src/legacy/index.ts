/**
 * Legacy `mitra-interactions-sdk` surface, re-exported so an application can
 * swap the legacy package for `@mitralab.io/platform-sdk` without rewriting
 * call sites first.
 *
 * Everything here is deprecated. Microsoft SSO is the only login without a
 * native replacement. The other capabilities remain available during migration
 * even when the native API has different input or response semantics.
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
import type * as LegacyTypes from 'mitra-interactions-sdk';
import { adoptLegacySession } from './bridge';

/**
 * @deprecated Use `createClient`, which configures the legacy SDK for you.
 * Calling this directly replaces the legacy configuration and refresh hook
 * until the next bridged session change.
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
 * @deprecated Use `mitra.auth.signInWithGoogle()` when `method` is Google.
 * Other legacy login methods remain supported until an equivalent exists.
 */
export const loginMitra: typeof legacyLoginMitra = async (method, options) => {
  const session = await legacyLoginMitra(method, options);
  adoptLegacySession(session);
  return session;
};

/**
 * @deprecated Use `mitra.auth.signInWithGoogle()`.
 */
export const loginWithGoogleMitra: typeof legacyLoginWithGoogleMitra = async (options) => {
  const session = await legacyLoginWithGoogleMitra(options);
  adoptLegacySession(session);
  return session;
};

/**
 * @deprecated No replacement yet; Microsoft SSO remains supported through the
 * legacy surface.
 */
export const loginWithMicrosoftMitra: typeof legacyLoginWithMicrosoftMitra = async (options) => {
  const session = await legacyLoginWithMicrosoftMitra(options);
  adoptLegacySession(session);
  return session;
};

/**
 * @deprecated For Google redirects, use
 * `mitra.auth.completeGoogleSignInRedirect()`. Other providers remain supported
 * through the legacy surface.
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
 * @deprecated Use `mitra.functions.execute` instead. The native method invokes
 * the synchronous Functions endpoint and returns its execution contract.
 */
export const executeServerFunctionMitra = legacyExecuteServerFunctionMitra;

/**
 * @deprecated Use `mitra.functions.executeAsync` instead, then poll or cancel
 * the returned execution ID through the same module.
 */
export const executeServerFunctionAsyncMitra = legacyExecuteServerFunctionAsyncMitra;

/**
 * @deprecated Use `mitra.publicFunctions.execute` instead.
 */
export const executePublicServerFunctionMitra = legacyExecutePublicServerFunctionMitra;

/**
 * @deprecated Use `mitra.publicFunctions.executeAsync` instead.
 */
export const executePublicServerFunctionAsyncMitra = legacyExecutePublicServerFunctionAsyncMitra;

/**
 * @deprecated Kept for backward compatibility. The direct public API has no anonymous polling;
 * use `mitra.functions.getExecution` only in an authenticated flow.
 */
export const getPublicServerFunctionExecutionMitra = legacyGetPublicServerFunctionExecutionMitra;

/**
 * @deprecated Use `mitra.functions.cancelExecution` instead.
 */
export const stopServerFunctionExecutionMitra = legacyStopServerFunctionExecutionMitra;

/**
 * @deprecated Use `mitra.integration.execute` instead.
 */
export const callIntegrationMitra = legacyCallIntegrationMitra;

/**
 * @deprecated Use `mitra.integration.list()` instead.
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
 * @deprecated Use `mitra.agentTasks.session` instead.
 */
export const getAgentTaskMitra = legacyGetAgentTaskMitra;

/**
 * @deprecated Use `mitra.agentTasks.list`, `rename`, and `archive` instead.
 */
export const manageAgentChatMitra = legacyManageAgentChatMitra;

/**
 * @deprecated Use `mitra.agentCredentials` instead.
 */
export const manageAgentCredentialMitra = legacyManageAgentCredentialMitra;

/** @deprecated Legacy compatibility type. */
export type AgentChat = LegacyTypes.AgentChat;
/** @deprecated Legacy compatibility type. */
export type AgentCredentialStatus = LegacyTypes.AgentCredentialStatus;
/** @deprecated Legacy compatibility type. */
export type AgentDeltaEvent = LegacyTypes.AgentDeltaEvent;
/** @deprecated Legacy compatibility type. */
export type AgentErrorEvent = LegacyTypes.AgentErrorEvent;
/** @deprecated Legacy compatibility type. */
export type AgentMessage = LegacyTypes.AgentMessage;
/** @deprecated Legacy compatibility type. */
export type AgentModel = LegacyTypes.AgentModel;
/** @deprecated Legacy compatibility type. */
export type AgentProvider = LegacyTypes.AgentProvider;
/** @deprecated Legacy compatibility type. */
export type AgentQueueChangeEvent = LegacyTypes.AgentQueueChangeEvent;
/** @deprecated Legacy compatibility type. */
export type AgentRawEvent = LegacyTypes.AgentRawEvent;
/** @deprecated Legacy compatibility type. */
export type AgentStatusChangeEvent = LegacyTypes.AgentStatusChangeEvent;
/** @deprecated Legacy compatibility type. */
export type AgentTaskCreatedEvent = LegacyTypes.AgentTaskCreatedEvent;
/** @deprecated Legacy compatibility type. */
export type AgentTaskEventMap = LegacyTypes.AgentTaskEventMap;
/** @deprecated Legacy compatibility type. */
export type AgentTaskEventName = LegacyTypes.AgentTaskEventName;
/** @deprecated Legacy compatibility type. */
export type AgentTaskSession = LegacyTypes.AgentTaskSession;
/** @deprecated Legacy compatibility type. */
export type AgentTaskStatus = LegacyTypes.AgentTaskStatus;
/** @deprecated Legacy compatibility type. */
export type AgentTaskTransport = LegacyTypes.AgentTaskTransport;
/** @deprecated Legacy compatibility type. */
export type AgentTimelineItem = LegacyTypes.AgentTimelineItem;
/** @deprecated Legacy compatibility type. */
export type AgentToolEvent = LegacyTypes.AgentToolEvent;
/** @deprecated Legacy compatibility type. */
export type AgentTurnEndEvent = LegacyTypes.AgentTurnEndEvent;
/** @deprecated Legacy compatibility type. */
export type AgentType = LegacyTypes.AgentType;
/** @deprecated Legacy compatibility type. */
export type AuthAgentCredentialResult = LegacyTypes.AuthAgentCredentialResult;
/** @deprecated Legacy compatibility type. */
export type CallIntegrationOptions = LegacyTypes.CallIntegrationOptions;
/** @deprecated Legacy compatibility type. */
export type CallIntegrationResponse = LegacyTypes.CallIntegrationResponse;
/** @deprecated Legacy compatibility type. */
export type ChatManageAction = LegacyTypes.ChatManageAction;
/** @deprecated Legacy compatibility type. */
export type ConnectAgentCredentialResult = LegacyTypes.ConnectAgentCredentialResult;
/** @deprecated Legacy compatibility type. */
export type CreateRecordOptions = LegacyTypes.CreateRecordOptions;
/** @deprecated Legacy compatibility type. */
export type CreateRecordsBatchOptions = LegacyTypes.CreateRecordsBatchOptions;
/** @deprecated Legacy compatibility type. */
export type CredentialAction = LegacyTypes.CredentialAction;
/** @deprecated Legacy compatibility type. */
export type DeleteAgentChatResult = LegacyTypes.DeleteAgentChatResult;
/** @deprecated Legacy compatibility type. */
export type DeleteRecordOptions = LegacyTypes.DeleteRecordOptions;
/** @deprecated Legacy compatibility type. */
export type DeviceAuthAgentCredentialResult = LegacyTypes.DeviceAuthAgentCredentialResult;
/** @deprecated Legacy compatibility type. */
export type ExecutePublicServerFunctionAsyncResponse = LegacyTypes.ExecutePublicServerFunctionAsyncResponse;
/** @deprecated Legacy compatibility type. */
export type ExecutePublicServerFunctionOptions = LegacyTypes.ExecutePublicServerFunctionOptions;
/** @deprecated Legacy compatibility type. */
export type ExecutePublicServerFunctionResponse = LegacyTypes.ExecutePublicServerFunctionResponse;
/** @deprecated Legacy compatibility type. */
export type ExecuteServerFunctionAsyncOptions = LegacyTypes.ExecuteServerFunctionAsyncOptions;
/** @deprecated Legacy compatibility type. */
export type ExecuteServerFunctionAsyncResponse = LegacyTypes.ExecuteServerFunctionAsyncResponse;
/** @deprecated Legacy compatibility type. */
export type ExecuteServerFunctionOptions = LegacyTypes.ExecuteServerFunctionOptions;
/** @deprecated Legacy compatibility type. */
export type ExecuteServerFunctionResponse = LegacyTypes.ExecuteServerFunctionResponse;
/** @deprecated Legacy compatibility type. */
export type GetAgentTaskCreateOptions = LegacyTypes.GetAgentTaskCreateOptions;
/** @deprecated Legacy compatibility type. */
export type GetAgentTaskOpenOptions = LegacyTypes.GetAgentTaskOpenOptions;
/** @deprecated Legacy compatibility type. */
export type GetAgentTaskOptions = LegacyTypes.GetAgentTaskOptions;
/** @deprecated Legacy compatibility type. */
export type GetPublicServerFunctionExecutionOptions = LegacyTypes.GetPublicServerFunctionExecutionOptions;
/** @deprecated Legacy compatibility type. */
export type GetPublicServerFunctionExecutionResponse = LegacyTypes.GetPublicServerFunctionExecutionResponse;
/** @deprecated Legacy compatibility type. */
export type GetRecordOptions = LegacyTypes.GetRecordOptions;
/** @deprecated Legacy compatibility type. */
export type IntegrationResponse = LegacyTypes.IntegrationResponse;
/** @deprecated Legacy compatibility type. */
export type ListAgentModelsResult = LegacyTypes.ListAgentModelsResult;
/** @deprecated Legacy compatibility type. */
export type ListAgentProvidersResult = LegacyTypes.ListAgentProvidersResult;
/** @deprecated Legacy compatibility type. */
export type ListIntegrationsOptions = LegacyTypes.ListIntegrationsOptions;
/** @deprecated Legacy compatibility type. */
export type ListRecordsOptions = LegacyTypes.ListRecordsOptions;
/** @deprecated Legacy compatibility type. */
export type ListRecordsResponse = LegacyTypes.ListRecordsResponse;
/** @deprecated Legacy compatibility type. */
export type LoginOptions = LegacyTypes.LoginOptions;
/** @deprecated Legacy compatibility type. */
export type LoginResponse = LegacyTypes.LoginResponse;
/** @deprecated Legacy compatibility type. */
export type ManageAgentChatDeleteOptions = LegacyTypes.ManageAgentChatDeleteOptions;
/** @deprecated Legacy compatibility type. */
export type ManageAgentChatListOptions = LegacyTypes.ManageAgentChatListOptions;
/** @deprecated Legacy compatibility type. */
export type ManageAgentChatOptions = LegacyTypes.ManageAgentChatOptions;
/** @deprecated Legacy compatibility type. */
export type ManageAgentChatRenameOptions = LegacyTypes.ManageAgentChatRenameOptions;
/** @deprecated Legacy compatibility type. */
export type ManageAgentCredentialOptions = LegacyTypes.ManageAgentCredentialOptions;
/** @deprecated Legacy compatibility type. */
export type MitraConfig = LegacyTypes.MitraConfig;
/** @deprecated Legacy compatibility type. */
export type MitraInstance = LegacyTypes.MitraInstance;
/** @deprecated Legacy compatibility type. */
export type PatchRecordOptions = LegacyTypes.PatchRecordOptions;
/** @deprecated Legacy compatibility type. */
export type QueuedItem = LegacyTypes.QueuedItem;
/** @deprecated Legacy compatibility type. */
export type RenameAgentChatResult = LegacyTypes.RenameAgentChatResult;
/** @deprecated Legacy compatibility type. */
export type SendOptions = LegacyTypes.SendOptions;
/** @deprecated Legacy compatibility type. */
export type StopServerFunctionExecutionOptions = LegacyTypes.StopServerFunctionExecutionOptions;
/** @deprecated Legacy compatibility type. */
export type StopServerFunctionExecutionResponse = LegacyTypes.StopServerFunctionExecutionResponse;
/** @deprecated Legacy compatibility type. */
export type UpdateRecordOptions = LegacyTypes.UpdateRecordOptions;
