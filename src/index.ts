/**
 * Mitra Platform SDK
 *
 * JavaScript/TypeScript SDK for building apps on Mitra Platform.
 * Provides authentication, database CRUD operations, serverless function execution,
 * integration proxy, and custom query execution.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { createClient } from '@mitralab.io/platform-sdk';
 *
 * const mitra = createClient({
 *   appId: 'your-app-id',
 *   apiUrl: 'https://api.example.com',
 * });
 *
 * await mitra.init();
 *
 * // Authentication
 * await mitra.auth.signIn({ email: 'user@example.com', password: 'password' });
 *
 * // Database operations
 * const tasks = await mitra.entities.Task.list('-created_at', 10);
 *
 * // Serverless functions
 * const execution = await mitra.functions.execute('function-id', { key: 'value' });
 * ```
 */

export { createClient } from './client';

export type {
  MitraClient,
  MitraClientConfig,
  User,
  SignInCredentials,
  SignUpData,
  EntityListOptions,
  EntityTable,
  FunctionExecution,
  ProxyInput,
  ProxyResult,
  QueryResult,
} from './client';

export { MitraApiError } from './utils/http-client';

/**
 * Deprecated `mitra-interactions-sdk` surface, re-exported so existing call
 * sites keep compiling after the package swap. See `./legacy` for the
 * replacement of each export.
 */
export * from './legacy';
