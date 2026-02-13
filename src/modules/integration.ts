import { HttpClient } from '../utils/http-client';
import type { ProxyInput, ProxyResult } from './integration.types';

export type { ProxyInput, ProxyResult } from './integration.types';

/**
 * Module for proxying HTTP requests to external APIs.
 *
 * Sends requests through the Mitra server, which handles authentication
 * and credential injection based on the integration config.
 *
 * @example
 * ```typescript
 * const result = await mitra.integration.execute('config-id', {
 *   method: 'GET',
 *   endpoint: '/users',
 * });
 * console.log(result.body);
 * ```
 */
export class IntegrationModule {
  private httpClient: HttpClient;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
  }

  /**
   * Executes a proxied HTTP request through an integration config.
   *
   * The Mitra server handles authentication and injects credentials automatically.
   *
   * @param configId - UUID of the integration config.
   * @param request - The HTTP request to proxy (method, endpoint, body, etc.).
   * @returns Proxy result with status, headers, body, and execution metadata.
   * @throws {MitraApiError} On config not found (404) or external API failure.
   *
   * @example
   * ```typescript
   * const result = await mitra.integration.execute('config-id', {
   *   method: 'POST',
   *   endpoint: '/orders',
   *   body: { product: 'Widget', quantity: 5 },
   * });
   * ```
   */
  async execute(configId: string, request: ProxyInput): Promise<ProxyResult> {
    return this.httpClient.post<ProxyResult>(
      `/api/v1/proxy/${configId}/execute`,
      { ...request, source: 'SDK' }
    );
  }
}
