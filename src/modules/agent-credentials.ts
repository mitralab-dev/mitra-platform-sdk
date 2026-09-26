import {
  createAgentCredentialsModule,
  type AgentConnectionCustomProvider,
  type AgentConnectionCustomProviderInput,
  type AgentCredentialOptions,
  type AgentCredentialsModule as CoreAgentCredentialsModule,
  type AgentModel,
  type AuthenticationResult,
  type CredentialStatus,
  type CredentialUsage,
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
  list(options?: AgentCredentialOptions): Promise<CredentialStatus[]>;
  listModels(agentId?: string, options?: AgentCredentialOptions): Promise<AgentModel[]>;
  /**
   * The last subscription window a chat on this credential reported, readable with no chat open.
   * `null` until a turn on the provider's subscription login has reported one.
   */
  usage(
    provider: AgentCredentialProvider,
    options?: AgentCredentialOptions
  ): Promise<CredentialUsage | null>;
  saveApiKey(
    provider: AgentCredentialProvider,
    apiKey: string,
    options?: AgentCredentialOptions
  ): Promise<void>;
  remove(provider: AgentCredentialProvider, options?: AgentCredentialOptions): Promise<void>;
  startOAuth(
    provider: AgentOAuthProvider,
    options?: AgentCredentialOptions
  ): Promise<OAuthStartResult>;
  exchangeOAuth(
    provider: AgentOAuthProvider,
    input: OAuthExchangeInput,
    options?: AgentCredentialOptions
  ): Promise<AuthenticationResult>;
  startDeviceAuthorization(
    provider: AgentDeviceProvider,
    options?: AgentCredentialOptions
  ): Promise<DeviceAuthorization>;
  pollDeviceAuthorization(
    provider: AgentDeviceProvider,
    deviceAuthId: string,
    options?: AgentCredentialOptions
  ): Promise<AuthenticationResult>;
  listCustomProviders(options?: AgentCredentialOptions): Promise<AgentConnectionCustomProvider[]>;
  createCustomProvider(
    input: AgentConnectionCustomProviderInput,
    options?: AgentCredentialOptions
  ): Promise<AgentConnectionCustomProvider[]>;
  deleteCustomProvider(id: string, options?: AgentCredentialOptions): Promise<void>;
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
    list: (options) => core.list(options),
    listModels: (agentId, options) => core.listModels(agentId, options),
    usage: (provider, options) => {
      requireProvider(provider, ['ANTHROPIC', 'OPENAI'] as const, 'Subscription usage');
      return core.usage(provider, options);
    },
    saveApiKey: (provider, apiKey, options) => {
      requireProvider(provider, ['ANTHROPIC', 'OPENAI'] as const, 'API key authentication');
      return core.saveApiKey(provider, apiKey, options);
    },
    remove: (provider, options) => {
      requireProvider(provider, ['ANTHROPIC', 'OPENAI'] as const, 'Credential removal');
      return core.remove(provider, options);
    },
    startOAuth: (provider, options) => {
      requireProvider(provider, ['ANTHROPIC'] as const, 'OAuth');
      return core.startOAuth(provider, options);
    },
    exchangeOAuth: (provider, input, options) => {
      requireProvider(provider, ['ANTHROPIC'] as const, 'OAuth');
      return core.exchangeOAuth(provider, input, options);
    },
    startDeviceAuthorization: (provider, options) => {
      requireProvider(provider, ['OPENAI'] as const, 'Device authorization');
      return core.startDeviceAuthorization(provider, options);
    },
    pollDeviceAuthorization: (provider, deviceAuthId, options) => {
      requireProvider(provider, ['OPENAI'] as const, 'Device authorization');
      return core.pollDeviceAuthorization(provider, deviceAuthId, options);
    },
    listCustomProviders: (options) => core.listCustomProviders(options),
    createCustomProvider: (input, options) => core.createCustomProvider(input, options),
    deleteCustomProvider: (id, options) => core.deleteCustomProvider(id, options),
  };
}

export type {
  AgentConnectionCustomProvider,
  AgentConnectionCustomProviderInput,
  AgentCredentialOptions,
  AgentCredentialScope,
} from '@mitralab.io/sdk-core';
