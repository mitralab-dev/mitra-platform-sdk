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
 * const result = await mitra.integration.executeResource('resource-id', {
 *   descricao: 'Notebook',
 *   limit: 10,
 * });
 * console.log(result.body);
 * ```
 */
export class IntegrationModule {
  private readonly httpClient: HttpClient;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
  }

  /**
   * Executes a pre-defined integration resource by ID.
   *
   * The resource's endpoint, method, and body are resolved server-side
   * using the provided parameters. Only declared parameters can be passed.
   *
   * @param resourceId - UUID of the integration resource.
   * @param params - Named parameters declared in the resource's params schema.
   * @returns Proxy result with status, headers, body, and execution metadata.
   * @throws {MitraApiError} On resource not found (404) or external API failure.
   *
   * @example
   * ```typescript
   * const result = await mitra.integration.executeResource('resource-id', {
   *   descricao: 'Notebook',
   *   limit: 10,
   * });
   * console.log(result.body);
   * ```
   */
  async executeResource(
    resourceId: string,
    params?: Record<string, unknown>
  ): Promise<ProxyResult> {
    return this.httpClient.post<ProxyResult>(
      `/api/v1/proxy/resources/${resourceId}/execute`,
      { params }
    );
  }

  /**
   * Executes a proxied HTTP request through an integration config.
   *
   * The Mitra server handles authentication and injects credentials automatically.
   * Note: integrations configured with RESOURCE_ONLY mode will block direct proxy access.
   *
   * @param configId - UUID of the integration config.
   * @param request - The HTTP request to proxy (method, endpoint, body, etc.).
   * @returns Proxy result with status, headers, body, and execution metadata.
   * @throws {MitraApiError} On config not found (404) or external API failure.
   */
  async execute(configId: string, request: ProxyInput): Promise<ProxyResult> {
    return this.httpClient.post<ProxyResult>(
      `/api/v1/proxy/template-configs/${configId}/execute`,
      { ...request, source: 'SDK' }
    );
  }
}
