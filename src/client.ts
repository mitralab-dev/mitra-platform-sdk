import { stripTrailingSlashes } from './utils/url';
import {
  createPublicFunctionsModule,
  encodePathSegment,
  expectObject,
  type AgentTasksWithSessions,
  type PublicFunctionsModule,
} from '@mitralab.io/sdk-core';
import { coreErrors } from './core-errors';
import { HttpClient, MitraApiError } from './utils/http-client';
import { LegacySessionBridge, setActiveBridge } from './legacy/bridge';
import { AuthModule, getAuthSessionPort } from './modules/auth';
import { EntitiesModule, EntitiesProxy } from './modules/entities';
import { FunctionsModule } from './modules/functions';
import { IntegrationModule } from './modules/integration';
import { QueriesModule } from './modules/queries';
import { createBrowserAgentTasksModule } from './modules/agent-tasks';
import {
  createBrowserAgentCredentialsModule,
  type AgentCredentialsModule,
} from './modules/agent-credentials';

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
   * Api key for server-side authentication, used by `auth.signInWithApiKey()`.
   * Never set this in code that reaches a browser: it would ship in the bundle.
   */
  apiKey?: string;

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
   * Absolute URL of the Mitra Google SSO page.
   *
   * When omitted, the SDK reads `window.__mitraEnv.authPageUrl` and then falls
   * back to `/sdk-auth.html` on the origin of `apiUrl`.
   *
   * @example
   * ```typescript
   * authPageUrl: 'https://auth.example.com/sdk-auth.html'
   * ```
   */
  authPageUrl?: string;

  /**
   * Global error handler called whenever an API request fails.
   * Useful for displaying toast notifications or logging errors.
   *
   * @example
   * ```typescript
   * const mitra = createClient({
   *   appId: 'your-app-id',
   *   apiUrl: 'https://api.example.com',
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
  dataSourceId: string | null;
  allowSignup: boolean;
  emailLoginEnabled: boolean;
  /** Which platform brand answers for this app, `null` when the server omits it. */
  brand: string | null;
}

function expectAppInfoResponse(value: unknown): AppInfoResponse {
  const response = expectObject<Record<string, unknown>>(
    value,
    'App info response',
    coreErrors
  );
  if (
    response.dataSourceId !== null
    && (typeof response.dataSourceId !== 'string' || !response.dataSourceId.trim())
  ) {
    throw coreErrors.invalidResponse(
      'App info response has an invalid dataSourceId field'
    );
  }
  if (typeof response.allowSignup !== 'boolean') {
    throw coreErrors.invalidResponse(
      'App info response has an invalid allowSignup field'
    );
  }
  return {
    dataSourceId: response.dataSourceId,
    allowSignup: response.allowSignup,
    // Unlike the fields above, a missing or non-boolean value is read as `false`
    // instead of failing `init()`: a Code Studio older than the email login gate
    // answers without this field, and an app that cannot prove it is enabled
    // should stop offering the option, not stop starting.
    emailLoginEnabled: response.emailLoginEnabled === true,
    // Same reasoning, and the brand is never guessed: without it the headless
    // email methods refuse instead of asking IAM to brand a message at random.
    brand: typeof response.brand === 'string' && response.brand.trim() ? response.brand : null,
  };
}

/**
 * The Mitra client instance providing access to all SDK modules.
 *
 * @example
 * ```typescript
 * const mitra = createClient({
 *   appId: 'your-app-id',
 *   apiUrl: 'https://api.example.com',
 * });
 *
 * // Initialize (resolves app config automatically)
 * await mitra.init();
 *
 * // Authentication
 * await mitra.auth.signInWithGoogle({ mode: 'popup' });
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
   * Fetches the compatibility dataSourceId, allowSignup, emailLoginEnabled, and
   * the brand `requestEmailCode()` sends with, from the public app info endpoint.
   *
   * Safe to call multiple times. Subsequent calls are no-ops.
   *
   * @example
   * ```typescript
   * const mitra = createClient({
   *   appId: 'your-app-id',
   *   apiUrl: 'https://api.example.com',
   * });
   * await mitra.init();
   * ```
   */
  init(): Promise<void>;

  /**
   * Authentication module for managing user sessions.
   *
   * Handles Google and Microsoft SSO, email sign-in, trusted preview sessions,
   * and session lifecycle.
   *
   * @example
   * ```typescript
   * await mitra.auth.signInWithGoogle({ mode: 'popup' });
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

  /** Anonymous execution of Functions explicitly published as public. */
  publicFunctions: PublicFunctionsModule;

  /** Browser-safe Agent task REST API and native live sessions. */
  agentTasks: AgentTasksWithSessions;

  /** Browser-safe credential status, model discovery, and provider auth flows. */
  agentCredentials: AgentCredentialsModule;

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
   * Whether this app offers sign-in by email, so the application can hide the
   * option instead of sending people to a request IAM would answer neutrally.
   * Defaults to `false` before `init()` is called, and stays `false` when the
   * server does not answer the field.
   */
  readonly emailLoginEnabled: boolean;

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
 * After creating the client, call `init()` to resolve the app's public config
 * (dataSourceId, allowSignup, emailLoginEnabled) automatically from the server.
 *
 * @param config - Configuration options for the client.
 * @returns A configured MitraClient instance.
 *
 * @example
 * ```typescript
 * import { createClient } from '@mitralab.io/platform-sdk';
 *
 * const mitra = createClient({
 *   appId: import.meta.env.VITE_MITRA_APP_ID,
 *   apiUrl: import.meta.env.VITE_MITRA_API_URL,
 * });
 *
 * await mitra.init();
 *
 * // Use the client
 * await mitra.auth.signInWithGoogle({ mode: 'popup' });
 * const tasks = await mitra.entities.Task.list();
 * ```
 *
 * @example
 * ```typescript
 * // Export as singleton for use throughout your app
 * // src/api/mitraClient.ts
 * import { createClient } from '@mitralab.io/platform-sdk';
 *
 * export const mitra = createClient({
 *   appId: import.meta.env.VITE_MITRA_APP_ID,
 *   apiUrl: import.meta.env.VITE_MITRA_API_URL,
 * });
 * ```
 */
export function createClient(config: MitraClientConfig): MitraClient {
  const { appId, apiUrl, apiKey, authPageUrl, onError } = config;
  const gatewayUrl = stripTrailingSlashes(apiUrl);

  // Determine service URLs from base API URL
  const iamUrl = `${gatewayUrl}/iam`;
  const dataManagerUrl = `${gatewayUrl}/data-manager`;
  const functionsUrl = `${gatewayUrl}/functions`;
  const integrationUrl = `${gatewayUrl}/integration`;
  const codeStudioUrl = `${gatewayUrl}/code-studio`;
  const copilotUrl = `${gatewayUrl}/copilot`;

  // Create auth module first (manages tokens)
  const authModule = new AuthModule(appId, iamUrl, { apiUrl: gatewayUrl, authPageUrl, apiKey });
  const authSession = getAuthSessionPort(authModule);

  const onUnauthorized = (requestToken: string | null) =>
    authSession.handleUnauthorized(requestToken);
  const beforeAuthenticatedRequest = () => authModule.ensureFreshSession().then(() => undefined);
  const defaultHeaders = { 'X-App-Id': appId };

  // Create HTTP client that uses auth tokens
  const httpClient = new HttpClient({
    baseUrl: dataManagerUrl,
    getToken: () => authModule.accessToken,
    beforeAuthenticatedRequest,
    onUnauthorized,
    onError,
    defaultHeaders,
  });

  // Create modules
  const entitiesModule = EntitiesModule.createProxy(httpClient, '') as EntitiesProxy;

  const functionsHttpClient = new HttpClient({
    baseUrl: functionsUrl,
    getToken: () => authModule.accessToken,
    beforeAuthenticatedRequest,
    onUnauthorized,
    onError,
    defaultHeaders,
  });
  const functionsModule = new FunctionsModule(functionsHttpClient);
  const publicFunctionsModule = createPublicFunctionsModule(
    new HttpClient({ baseUrl: functionsUrl, getToken: () => null }),
    coreErrors
  );

  const copilotHttpClient = new HttpClient({
    baseUrl: copilotUrl,
    getToken: () => authModule.accessToken,
    beforeAuthenticatedRequest,
    onUnauthorized,
    onError,
    defaultHeaders,
  });
  const agentTasksModule = createBrowserAgentTasksModule(
    copilotHttpClient,
    authSession,
    gatewayUrl,
    new HttpClient({
      baseUrl: copilotUrl,
      getToken: () => authModule.accessToken,
      beforeAuthenticatedRequest,
      onUnauthorized,
      defaultHeaders,
    })
  );
  const agentCredentialsModule = createBrowserAgentCredentialsModule(copilotHttpClient);

  const integrationHttpClient = new HttpClient({
    baseUrl: integrationUrl,
    getToken: () => authModule.accessToken,
    beforeAuthenticatedRequest,
    onUnauthorized,
    onError,
    defaultHeaders,
  });
  const integrationModule = new IntegrationModule(integrationHttpClient);

  const queriesModule = new QueriesModule(httpClient);

  // Share one session with the deprecated mitra-interactions-sdk surface: hand
  // it whatever session is already persisted, and adopt the ones it produces.
  const legacyBridge = new LegacySessionBridge(authSession, appId, apiUrl, authPageUrl);
  setActiveBridge(legacyBridge);
  legacyBridge.connect();

  let initialized = false;
  let allowSignup = true;
  let emailLoginEnabled = false;

  async function init(): Promise<void> {
    if (initialized) return;

    const publicClient = new HttpClient({
      baseUrl: codeStudioUrl,
      getToken: () => null,
    });

    const appInfo = expectAppInfoResponse(
      await publicClient.get<unknown>(
        `/api/v1/apps/${encodePathSegment(appId, 'appId', coreErrors)}/info`
      )
    );

    if (appInfo.dataSourceId) {
      entitiesModule.setDataSourceId(appInfo.dataSourceId);
    }
    if (appInfo.brand) {
      authModule.setBrand(appInfo.brand);
    }
    allowSignup = appInfo.allowSignup;
    emailLoginEnabled = appInfo.emailLoginEnabled;

    initialized = true;
  }

  return {
    init,
    auth: authModule,
    entities: entitiesModule,
    functions: functionsModule,
    publicFunctions: publicFunctionsModule,
    agentTasks: agentTasksModule,
    agentCredentials: agentCredentialsModule,
    integration: integrationModule,
    queries: queriesModule,
    get allowSignup() {
      return allowSignup;
    },
    get emailLoginEnabled() {
      return emailLoginEnabled;
    },
    config,
  };
}

// Re-export types from modules
export type {
  User,
  SignInCredentials,
  SignUpData,
  AuthPageSignInOptions,
  EmailCodeLanguage,
  EmailCodeRequest,
  EmailCodeRequestResult,
  EmailCodeVerification,
  EmailSignInOptions,
  GoogleSignInOptions,
  MicrosoftSignInOptions,
} from './modules/auth';
export type { EntityListOptions, EntityTable } from './modules/entities';
export type { FunctionExecution } from './modules/functions';
export type {
  ListTemplateConfigsOptions,
  ProxyInput,
  ProxyResult,
  TemplateConfigPage,
} from './modules/integration';
export type { QueryResult } from './modules/queries';
export type {
  NativeAgentMessage,
  AgentProviderUsage,
  AgentQueueItem,
  AgentSendOptions,
  AgentSendAndWaitOptions,
  AgentSessionTransport,
  AgentTask,
  AgentTaskCreateInput,
  AgentTaskInput,
  AgentTaskListOptions,
  AgentTaskRuntime,
  AgentTaskSessionEventMap,
  AgentTaskSessionOptions,
  AgentTaskSessionStatus,
  NativeAgentTaskSession,
  NativeAgentTimelineItem,
  NativeAgentToolEvent,
  AgentTurnResult,
  ExistingAgentTaskSessionOptions,
  NewAgentTaskSessionOptions,
  Page,
  PageOptions,
} from './modules/agent-tasks';
export type {
  AgentModel as NativeAgentModel,
  AuthenticationResult,
  CredentialStatus,
  CredentialUsage,
  DeviceAuthorization,
  OAuthExchangeInput,
  OAuthStartResult,
  PublicFunctionAsyncResult,
  PublicFunctionResult,
  PublicFunctionsModule,
} from '@mitralab.io/sdk-core';
export type {
  AgentConnectionCustomProvider,
  AgentConnectionCustomProviderInput,
  AgentCredentialOptions,
  AgentCredentialProvider,
  AgentCredentialScope,
  AgentCredentialsModule,
  AgentDeviceProvider,
  AgentOAuthProvider,
} from './modules/agent-credentials';
export { MitraApiError } from './utils/http-client';
