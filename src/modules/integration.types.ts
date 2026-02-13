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

/** Result of a proxied HTTP request. */
export interface ProxyResult {
  /** HTTP status code from the external API. */
  status: number;
  /** Response headers. */
  headers: Record<string, string>;
  /** Response body. */
  body: unknown;
  /** Execution time in milliseconds. */
  durationMs: number;
  /** Unique execution record ID. */
  executionId: string;
}
