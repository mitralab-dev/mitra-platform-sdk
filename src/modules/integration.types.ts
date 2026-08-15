/** Input for a proxied HTTP request through an integration. */
export interface ProxyInput {
  /** HTTP method (GET, POST, PUT, DELETE, etc.). */
  method: string;
  /** API endpoint path (appended to the template's baseUrl). */
  endpoint: string;
  /** Additional headers. */
  headers?: Record<string, string>;
  /** Request body. */
  body?: unknown;
  /** Query parameters. */
  queryParams?: Record<string, string>;
}

export type { ProxyResult } from '@mitralab.io/sdk-core';
