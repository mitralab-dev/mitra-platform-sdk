import {
  createIntegrationModule,
  type IntegrationModule as CoreIntegrationModule,
} from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import { HttpClient } from '../utils/http-client';
import type { ProxyInput, ProxyResult } from './integration.types';

export type { ProxyInput, ProxyResult } from './integration.types';

/** Platform SDK 1.x facade over the shared integration contract. */
export class IntegrationModule {
  private readonly core: CoreIntegrationModule;

  constructor(httpClient: HttpClient) {
    this.core = createIntegrationModule(httpClient, coreErrors);
  }

  executeResource(resourceId: string, params?: Record<string, unknown>): Promise<ProxyResult> {
    return this.core.executeResource(resourceId, params);
  }

  execute(configId: string, request: ProxyInput): Promise<ProxyResult> {
    return this.core.execute(configId, request);
  }
}
