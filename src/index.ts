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
 * import { createClient } from 'mitra-platform-sdk';
 *
 * const mitra = createClient({
 *   appId: 'your-app-id',
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
