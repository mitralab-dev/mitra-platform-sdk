import {
  createAgentCredentialsModule,
  type AgentCredentialsModule as CoreAgentCredentialsModule,
  type AgentModel,
  type AuthenticationResult,
  type CredentialStatus,
  type DeviceAuthorization,
  type OAuthExchangeInput,
  type OAuthStartResult,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import type { HttpClient } from '../utils/http-client';

export type AgentCredentialProvider = 'ANTHROPIC' | 'OPENAI';
export type AgentOAuthProvider = 'ANTHROPIC';
export type AgentDeviceProvider = 'OPENAI';

export interface AgentCredentialsModule {
  list(): Promise<CredentialStatus[]>;
  listModels(agentId?: string): Promise<AgentModel[]>;
  saveApiKey(provider: AgentCredentialProvider, apiKey: string): Promise<void>;
  remove(provider: AgentCredentialProvider): Promise<void>;
  startOAuth(provider: AgentOAuthProvider): Promise<OAuthStartResult>;
  exchangeOAuth(
    provider: AgentOAuthProvider,
    input: OAuthExchangeInput
  ): Promise<AuthenticationResult>;
  startDeviceAuthorization(provider: AgentDeviceProvider): Promise<DeviceAuthorization>;
  pollDeviceAuthorization(
    provider: AgentDeviceProvider,
    deviceAuthId: string
  ): Promise<AuthenticationResult>;
}

function requireProvider<T extends string>(
  provider: string,
  allowed: readonly T[],
  flow: string
): asserts provider is T {
  if (!allowed.includes(provider as T)) {
    throw new TypeError(`${flow} does not support provider ${provider}.`);
  }
}

/** Browser-safe credential facade restricted to provider flows supported by Copilot. */
export function createBrowserAgentCredentialsModule(
  httpClient: HttpClient
): AgentCredentialsModule {
  const core: CoreAgentCredentialsModule = createAgentCredentialsModule(httpClient, coreErrors);
  return {
    list: () => core.list(),
    listModels: (agentId) => core.listModels(agentId),
    saveApiKey: (provider, apiKey) => {
      requireProvider(provider, ['ANTHROPIC', 'OPENAI'] as const, 'API key authentication');
      return core.saveApiKey(provider, apiKey);
    },
    remove: (provider) => {
      requireProvider(provider, ['ANTHROPIC', 'OPENAI'] as const, 'Credential removal');
      return core.remove(provider);
    },
    startOAuth: (provider) => {
      requireProvider(provider, ['ANTHROPIC'] as const, 'OAuth');
      return core.startOAuth(provider);
    },
    exchangeOAuth: (provider, input) => {
      requireProvider(provider, ['ANTHROPIC'] as const, 'OAuth');
      return core.exchangeOAuth(provider, input);
    },
    startDeviceAuthorization: (provider) => {
      requireProvider(provider, ['OPENAI'] as const, 'Device authorization');
      return core.startDeviceAuthorization(provider);
    },
    pollDeviceAuthorization: (provider, deviceAuthId) => {
      requireProvider(provider, ['OPENAI'] as const, 'Device authorization');
      return core.pollDeviceAuthorization(provider, deviceAuthId);
    },
  };
}
