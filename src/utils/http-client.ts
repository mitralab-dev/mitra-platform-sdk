import type {
  QueryParamValue,
  Transport,
  TransportRequestOptions,
} from '@mitralab.io/sdk-core';

type ErrorPayload = Record<string, unknown>;

const bearerCredentialPattern = /(Bearer\s+)\S+/gi;
const sensitiveDetailKeyPattern =
  /token|authorization|password|secret|api.?key|credential|private.?key/i;

function isSensitiveDetailKey(key: string): boolean {
  return sensitiveDetailKeyPattern.test(key);
}

function redactText(value: string, currentToken: string | null): string {
  const withoutBearerCredentials = value.replace(bearerCredentialPattern, '$1[REDACTED]');
  return currentToken
    ? withoutBearerCredentials.split(currentToken).join('[REDACTED]')
    : withoutBearerCredentials;
}

function redactDetails(value: unknown, currentToken: string | null): unknown {
  if (typeof value === 'string') return redactText(value, currentToken);
  if (Array.isArray(value)) return value.map((item) => redactDetails(item, currentToken));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const redactedKey = redactText(key, currentToken);
        return [
          redactedKey,
          isSensitiveDetailKey(redactedKey)
            ? '[REDACTED]'
            : redactDetails(entry, currentToken),
        ];
      })
    );
  }
  return value;
}

function asErrorPayload(value: unknown): ErrorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as ErrorPayload;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildRequestUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, QueryParamValue>
): string {
  const url = `${baseUrl}${path}`;
  if (!params) return url;

  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) searchParams.append(key, String(value));
  });

  const queryString = searchParams.toString();
  return queryString ? `${url}?${queryString}` : url;
}

/** Allowed query parameter value types. */
export type { QueryParamValue } from '@mitralab.io/sdk-core';

/**
 * Configuration options for creating an HttpClient instance.
 */
export interface HttpClientConfig {
  /** Base URL for all HTTP requests (e.g., 'https://api.mitra.io') */
  baseUrl: string;
  /** Function that returns the current authentication token, or null if not authenticated */
  getToken?: () => string | null;
  /** Refreshes an authenticated session before the Authorization header is constructed. */
  beforeAuthenticatedRequest?: () => Promise<void>;
  /**
   * Callback invoked on a 401 with the token used by that request. Returns
   * true when the request should be retried once with the current credential.
   */
  onUnauthorized?: (requestToken: string | null) => Promise<boolean>;
  /** Called whenever an API request fails. Useful for global error handling (e.g., toast notifications). */
  onError?: (error: MitraApiError) => void;
  /** Headers included in every request (e.g., X-App-Id for tracing). */
  defaultHeaders?: Record<string, string>;
}

/**
 * Options for making HTTP requests.
 */
export interface RequestOptions extends Omit<TransportRequestOptions, 'method'> {
  /** HTTP method (defaults to 'GET') */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Request body (will be JSON stringified) */
  body?: unknown;
  /** Additional headers to include in the request */
  headers?: Record<string, string>;
  /** URL query parameters */
  params?: Record<string, QueryParamValue>;
  /** @internal Flag to prevent infinite retry loops on 401 */
  isRetry?: boolean;
}

/**
 * HTTP client for making authenticated API requests.
 *
 * Handles JSON serialization, authentication headers, and error handling.
 * All requests automatically include the Authorization header when a token is available.
 *
 * @example
 * ```typescript
 * const client = new HttpClient({
 *   baseUrl: 'https://api.mitra.io',
 *   getToken: () => localStorage.getItem('token'),
 * });
 *
 * const users = await client.get<User[]>('/users');
 * const user = await client.post<User>('/users', { name: 'John' });
 * ```
 */
export class HttpClient implements Transport {
  private readonly baseUrl: string;
  private readonly tokenGetter: () => string | null;
  private readonly beforeAuthenticatedRequest?: () => Promise<void>;
  private readonly onUnauthorized?: (requestToken: string | null) => Promise<boolean>;
  private readonly onError?: (error: MitraApiError) => void;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.tokenGetter = config.getToken ?? (() => null);
    this.beforeAuthenticatedRequest = config.beforeAuthenticatedRequest;
    this.onUnauthorized = config.onUnauthorized;
    this.onError = config.onError;
    this.defaultHeaders = config.defaultHeaders ?? {};
  }

  /**
   * Returns the current authentication token.
   * @returns The JWT token if authenticated, null otherwise
   */
  getToken(): string | null {
    return this.tokenGetter();
  }

  /**
   * Makes an HTTP request with automatic JSON handling and authentication.
   *
   * @param path - API endpoint path (e.g., '/users')
   * @param options - Request options including method, body, headers, and params
   * @returns Promise resolving to the parsed JSON response
   * @throws {MitraApiError} When the API returns an error response
   *
   * @example
   * ```typescript
   * const result = await client.request<User>('/users/123', {
   *   method: 'PUT',
   *   body: { name: 'Updated Name' },
   * });
   * ```
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, headers = {}, params, isRetry } = options;

    const url = buildRequestUrl(this.baseUrl, path, params);

    if (!isRetry && this.tokenGetter() && this.beforeAuthenticatedRequest) {
      await this.beforeAuthenticatedRequest();
    }

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...headers,
    };

    const token = this.tokenGetter();
    if (token) {
      requestHeaders['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });

    if (response.redirected || response.type === 'opaqueredirect') {
      const error = new MitraApiError(
        'Redirected responses are not allowed',
        response.status,
        'REDIRECT_NOT_ALLOWED'
      );
      this.onError?.(error);
      throw error;
    }

    if (!response.ok) {
      if (response.status === 401 && !isRetry && this.onUnauthorized) {
        const refreshed = await this.onUnauthorized(token);
        if (refreshed) {
          return this.request<T>(path, { ...options, isRetry: true });
        }
      }

      const error = await this.errorFromResponse(response, token);
      this.onError?.(error);
      throw error;
    }

    return this.parseResponseBody<T>(response, path);
  }

  private async errorFromResponse(response: Response, token: string | null): Promise<MitraApiError> {
    const errorBody: unknown = await response.json().catch(() => ({}));
    const errorPayload = asErrorPayload(errorBody);
    const rawMessage = optionalString(errorPayload.message);
    const rawCode = optionalString(errorPayload.error_code);
    return new MitraApiError(
      redactText(rawMessage || `Request failed with status ${response.status}`, token),
      response.status,
      rawCode === undefined ? undefined : redactText(rawCode, token),
      redactDetails(errorBody, token)
    );
  }

  private async parseResponseBody<T>(response: Response, path: string): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }

    if (typeof response.text === 'function') {
      const responseText = await response.text();
      if (responseText.length === 0) {
        return undefined as T;
      }

      try {
        return JSON.parse(responseText) as T;
      } catch {
        const error = new MitraApiError(
          `Response from ${path} is not valid JSON`,
          response.status,
          'INVALID_RESPONSE'
        );
        this.onError?.(error);
        throw error;
      }
    }

    return response.json();
  }

  /**
   * Makes a GET request.
   *
   * @param path - API endpoint path
   * @param params - Optional query parameters
   * @returns Promise resolving to the parsed JSON response
   *
   * @example
   * ```typescript
   * const users = await client.get<User[]>('/users', { limit: 10 });
   * ```
   */
  get<T>(path: string, params?: Record<string, QueryParamValue>): Promise<T> {
    return this.request<T>(path, { method: 'GET', params });
  }

  /**
   * Makes a POST request.
   *
   * @param path - API endpoint path
   * @param body - Request body (will be JSON stringified)
   * @returns Promise resolving to the parsed JSON response
   *
   * @example
   * ```typescript
   * const user = await client.post<User>('/users', { name: 'John', email: 'john@example.com' });
   * ```
   */
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  /**
   * Makes a PUT request.
   *
   * @param path - API endpoint path
   * @param body - Request body (will be JSON stringified)
   * @returns Promise resolving to the parsed JSON response
   *
   * @example
   * ```typescript
   * const user = await client.put<User>('/users/123', { name: 'Updated Name' });
   * ```
   */
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body });
  }

  /**
   * Makes a DELETE request.
   *
   * @param path - API endpoint path
   * @param params - Optional query parameters
   * @returns Promise resolving to the parsed JSON response (or undefined for 204 responses)
   *
   * @example
   * ```typescript
   * await client.delete('/users/123');
   * ```
   */
  delete<T>(path: string, params?: Record<string, QueryParamValue>): Promise<T> {
    return this.request<T>(path, { method: 'DELETE', params });
  }
}

/**
 * Error thrown when a Mitra API request fails.
 *
 * Contains detailed information about the error including HTTP status,
 * error code, and additional details from the server response.
 *
 * @example
 * ```typescript
 * try {
 *   await mitra.entities.Task.get('invalid-id');
 * } catch (error) {
 *   if (error instanceof MitraApiError) {
 *     console.log(error.status);   // 404
 *     console.log(error.message);  // "Task not found"
 *     console.log(error.code);     // "ENTITY_NOT_FOUND"
 *   }
 * }
 * ```
 */
export class MitraApiError extends Error {
  constructor(
    message: string,
    /** HTTP status code (e.g., 400, 401, 404, 500) */
    public readonly status: number,
    /** Application-specific error code (e.g., 'ENTITY_NOT_FOUND', 'VALIDATION_ERROR') */
    public readonly code?: string,
    /** Additional error details from the server response */
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'MitraApiError';
  }
}
