import { HttpClient, MitraApiError } from './utils/http-client';
import { AuthModule } from './modules/auth';
import { EntitiesModule, EntitiesProxy } from './modules/entities';
import { FunctionsModule } from './modules/functions';
import { IntegrationModule } from './modules/integration';
import { QueriesModule } from './modules/queries';

/**
 * Configuration options for creating a Mitra client.
 */
export interface MitraClientConfig {
  /**
   * Your app's unique identifier.
   * Found in the Mitra Code Studio dashboard.
   */
  appId: string;

  /**
   * Base URL for the Mitra API (Kong Gateway).
   * Injected automatically via `VITE_MITRA_API_URL` environment variable
   * during the Code Studio build process.
   *
   * @example
   * ```typescript
   * apiUrl: import.meta.env.VITE_MITRA_API_URL
   * ```
   */
  apiUrl: string;

  /**
   * Global error handler called whenever an API request fails.
   * Useful for displaying toast notifications or logging errors.
   *
   * @example
   * ```typescript
   * const mitra = createClient({
   *   appId: 'your-app-id',
   *   onError: (error) => toast.error(error.message),
   * });
   * ```
   */
  onError?: (error: MitraApiError) => void;
}

/**
 * Response from the public app info endpoint.
 * @internal
 */
interface AppInfoResponse {
  dataSourceId: string;
  allowSignup: boolean;
}

/**
 * The Mitra client instance providing access to all SDK modules.
 *
 * @example
 * ```typescript
 * const mitra = createClient({
 *   appId: 'your-app-id',
 * });
 *
 * // Initialize (resolves app config automatically)
 * await mitra.init();
 *
 * // Authentication
 * await mitra.auth.signIn({ email, password });
 *
 * // Database operations
 * const tasks = await mitra.entities.Task.list();
 *
 * // Serverless functions
 * const execution = await mitra.functions.execute('function-id', { orderId });
 * ```
 */
export interface MitraClient {
  /**
   * Initializes the client by resolving app config from the server.
   *
   * Must be called before using `auth.signUp()` or `entities`.
   * Fetches dataSourceId and allowSignup from the public app info endpoint.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   *
   * @example
   * ```typescript
   * const mitra = createClient({ appId: 'your-app-id' });
   * await mitra.init();
   * ```
   */
  init(): Promise<void>;

  /**
   * Authentication module for managing user sessions.
   *
   * Handles user registration, login, logout, and session persistence.
   *
   * @example
   * ```typescript
   * await mitra.auth.signIn({ email: 'user@example.com', password: 'password' });
   * console.log(mitra.auth.currentUser);
   * ```
   */
  auth: AuthModule;

  /**
   * Entities module for database CRUD operations.
   *
   * Access any table dynamically using `mitra.entities.TableName`.
   *
   * @example
   * ```typescript
   * const tasks = await mitra.entities.Task.list('-created_at', 10);
   * const task = await mitra.entities.Task.create({ title: 'New task' });
   * ```
   */
  entities: EntitiesProxy;

  /**
   * Functions module for executing serverless functions.
   *
   * @example
   * ```typescript
   * const execution = await mitra.functions.execute('function-id', { orderId });
   * console.log(execution.status, execution.output);
   * ```
   */
  functions: FunctionsModule;

  /**
   * Integration module for proxying HTTP requests to external APIs.
   *
   * Sends requests through the Mitra server, which handles authentication
   * and credential injection automatically based on the template config.
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
  integration: IntegrationModule;

  /**
   * Queries module for executing reusable named SELECT queries.
   *
   * @example
   * ```typescript
   * const result = await mitra.queries.execute('query-id', { status: 'active' });
   * console.log(result.rows);
   * ```
   */
  queries: QueriesModule;

  /**
   * Whether this app allows public user registration.
   * Defaults to `true` before `init()` is called.
   */
  readonly allowSignup: boolean;

  /**
   * The configuration used to create this client.
   */
  config: MitraClientConfig;
}

/**
 * Creates a new Mitra client instance.
 *
 * The client provides access to all Mitra Platform features:
 * - **auth**: User authentication and session management
 * - **entities**: Database CRUD operations
 * - **functions**: Serverless function invocation
 * - **integration**: Proxy HTTP requests to external APIs
 * - **queries**: Custom query management and execution
 *
 * After creating the client, call `init()` to resolve the app's config
 * (dataSourceId, allowSignup) automatically from the server.
 *
 * @param config - Configuration options for the client.
 * @returns A configured MitraClient instance.
 *
 * @example
 * ```typescript
 * import { createClient } from 'mitra-platform-sdk';
 *
 * const mitra = createClient({
 *   appId: import.meta.env.VITE_MITRA_APP_ID,
 *   apiUrl: import.meta.env.VITE_MITRA_API_URL,
 * });
 *
 * await mitra.init();
 *
 * // Use the client
 * await mitra.auth.signIn({ email, password });
 * const tasks = await mitra.entities.Task.list();
 * ```
 *
 * @example
 * ```typescript
 * // Export as singleton for use throughout your app
 * // src/api/mitraClient.ts
 * import { createClient } from 'mitra-platform-sdk';
 *
 * export const mitra = createClient({
 *   appId: import.meta.env.VITE_MITRA_APP_ID,
 *   apiUrl: import.meta.env.VITE_MITRA_API_URL,
 * });
 * ```
 */
export function createClient(config: MitraClientConfig): MitraClient {
  const { appId, apiUrl, onError } = config;

  // Determine service URLs from base API URL
  const iamUrl = `${apiUrl}/iam`;
  const dataManagerUrl = `${apiUrl}/data-manager`;
  const functionsUrl = `${apiUrl}/functions`;
  const integrationUrl = `${apiUrl}/integration`;
  const codeStudioUrl = `${apiUrl}/code-studio`;

  // Create auth module first (manages tokens)
  const authModule = new AuthModule(appId, iamUrl);

  const onUnauthorized = () => authModule.refreshSession();
  const defaultHeaders = { 'X-App-Id': appId };

  // Create HTTP client that uses auth tokens
  const httpClient = new HttpClient({
    baseUrl: dataManagerUrl,
    getToken: () => authModule.accessToken,
    onUnauthorized,
    onError,
    defaultHeaders,
  });

  // Create modules
  const entitiesModule = new EntitiesModule(httpClient, '') as EntitiesProxy;

  const functionsHttpClient = new HttpClient({
    baseUrl: functionsUrl,
    getToken: () => authModule.accessToken,
    onUnauthorized,
    onError,
    defaultHeaders,
  });
  const functionsModule = new FunctionsModule(functionsHttpClient);

  const integrationHttpClient = new HttpClient({
    baseUrl: integrationUrl,
    getToken: () => authModule.accessToken,
    onUnauthorized,
    onError,
    defaultHeaders,
  });
  const integrationModule = new IntegrationModule(integrationHttpClient);

  const queriesModule = new QueriesModule(httpClient);

  let initialized = false;
  let allowSignup = true;

  async function init(): Promise<void> {
    if (initialized) return;

    const publicClient = new HttpClient({
      baseUrl: codeStudioUrl,
      getToken: () => null,
    });

    const appInfo = await publicClient.get<AppInfoResponse>(
      `/api/v1/apps/${appId}/info`
    );

    entitiesModule.setDataSourceId(appInfo.dataSourceId);
    queriesModule.setDataSourceId(appInfo.dataSourceId);
    allowSignup = appInfo.allowSignup;

    initialized = true;
  }

  return {
    init,
    auth: authModule,
    entities: entitiesModule,
    functions: functionsModule,
    integration: integrationModule,
    queries: queriesModule,
    get allowSignup() {
      return allowSignup;
    },
    config,
  };
}

// Re-export types from modules
export type { User, SignInCredentials, SignUpData } from './modules/auth';
export type { EntityListOptions, EntityTable } from './modules/entities';
export type { FunctionExecution } from './modules/functions';
export type { ProxyInput, ProxyResult } from './modules/integration';
export type { QueryResult } from './modules/queries';
export { MitraApiError } from './utils/http-client';
