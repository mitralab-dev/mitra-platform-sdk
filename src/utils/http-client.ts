/**
 * Configuration options for creating an HttpClient instance.
 */
export interface HttpClientConfig {
  /** Base URL for all HTTP requests (e.g., 'https://api.mitra.io') */
  baseUrl: string;
  /** Function that returns the current authentication token, or null if not authenticated */
  getToken?: () => string | null;
  /** Callback invoked on 401 responses. Should attempt token refresh and return true if successful. */
  onUnauthorized?: () => Promise<boolean>;
  /** Called whenever an API request fails. Useful for global error handling (e.g., toast notifications). */
  onError?: (error: MitraApiError) => void;
  /** Headers included in every request (e.g., X-App-Id for tracing). */
  defaultHeaders?: Record<string, string>;
}

/**
 * Options for making HTTP requests.
 */
export interface RequestOptions {
  /** HTTP method (defaults to 'GET') */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Request body (will be JSON stringified) */
  body?: unknown;
  /** Additional headers to include in the request */
  headers?: Record<string, string>;
  /** URL query parameters */
  params?: Record<string, string | number | boolean | undefined>;
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
export class HttpClient {
  private baseUrl: string;
  private tokenGetter: () => string | null;
  private onUnauthorized?: () => Promise<boolean>;
  private onError?: (error: MitraApiError) => void;
  private defaultHeaders: Record<string, string>;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.tokenGetter = config.getToken ?? (() => null);
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

    let url = `${this.baseUrl}${path}`;

    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          searchParams.append(key, String(value));
        }
      });
      const queryString = searchParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
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
    });

    if (!response.ok) {
      if (response.status === 401 && !isRetry && this.onUnauthorized) {
        const refreshed = await this.onUnauthorized();
        if (refreshed) {
          return this.request<T>(path, { ...options, isRetry: true });
        }
      }

      const errorBody = await response.json().catch(() => ({}));
      const error = new MitraApiError(
        errorBody.message || `Request failed with status ${response.status}`,
        response.status,
        errorBody.error_code,
        errorBody
      );
      this.onError?.(error);
      throw error;
    }

    if (response.status === 204) {
      return undefined as T;
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
  get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
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
  delete<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
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
