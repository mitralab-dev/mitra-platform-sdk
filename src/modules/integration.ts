import {
  createIntegrationAdminModule,
  createIntegrationModule,
  type IntegrationAdminModule,
  type IntegrationModule as CoreIntegrationModule,
  type ListTemplateConfigsOptions,
  type TemplateConfigPage,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import { HttpClient } from '../utils/http-client';
import type { ProxyInput, ProxyResult } from './integration.types';

export type { ProxyInput, ProxyResult } from './integration.types';
export type { ListTemplateConfigsOptions, TemplateConfigPage } from '@mitralab.io/sdk-core';

/** Platform SDK 1.x facade over the shared integration contract. */
export class IntegrationModule {
  private readonly core: CoreIntegrationModule;
  private readonly configs: Pick<IntegrationAdminModule, 'list'>;

  constructor(httpClient: HttpClient) {
    this.core = createIntegrationModule(httpClient, coreErrors);
    this.configs = createIntegrationAdminModule(httpClient, coreErrors);
  }

  /** Lists the current app's integration configs without exposing admin mutations. */
  list(options?: ListTemplateConfigsOptions): Promise<TemplateConfigPage> {
    return this.configs.list(options);
  }

  executeResource(resourceId: string, params?: Record<string, unknown>): Promise<ProxyResult> {
    return this.core.executeResource(resourceId, params);
  }

  execute(configId: string, request: ProxyInput): Promise<ProxyResult> {
    return this.core.execute(configId, request);
  }

  /** Executes a saved integration config selected by its app-scoped alias. */
  executeByAlias(alias: string, request: ProxyInput): Promise<ProxyResult> {
    return this.core.executeByAlias(alias, request);
  }
}
