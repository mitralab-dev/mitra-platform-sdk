import { resolveApiKeyToken } from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import { MitraApiError, type HttpClient } from '../utils/http-client';

/**
 * Api key authentication for processes that run without a person: a cron, a background
 * collector, another service. The key is created in Settings -> API keys and traded for a token
 * that authorizes the configured app.
 *
 * Which calls that takes, and what the answers mean, is the shared IAM contract in
 * `@mitralab.io/sdk-core`. What lives here is what belongs to this SDK: the runtime it accepts
 * and keeping the key out of anything it throws.
 */

/**
 * Errors travel to logs and error reports, and a failing exchange is the one place an upstream
 * message could carry the key back. Strip it before the error leaves this module.
 */
async function withoutLeakingKey<T>(apiKey: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof MitraApiError && error.message.includes(apiKey)) {
      throw new MitraApiError(error.message.split(apiKey).join('[REDACTED]'), error.status);
    }
    throw error;
  }
}

/**
 * Rejects the browser, where a key would be served to every visitor along with the bundle.
 *
 * This is what separates api key authentication from the SSO methods beside it: those exist
 * for a person in front of a screen, this one for a process holding a long-lived credential.
 */
export function assertServerRuntime(): void {
  if (typeof globalThis.window !== 'undefined') {
    throw new MitraApiError(
      'Api key authentication runs only on a server. In a browser the key would be served to every visitor; sign in with Google or Microsoft instead.',
      400
    );
  }
}

/** Trades an api key for a token that authorizes `appId`. */
export async function resolveApiKeySession(
  publicClient: HttpClient,
  appId: string,
  apiKey: string
): Promise<string> {
  return resolveApiKeyToken(
    (path, init) =>
      withoutLeakingKey(apiKey, () =>
        publicClient.request<unknown>(path, {
          method: 'POST',
          ...(init.body === undefined ? {} : { body: init.body }),
          ...(init.bearer === undefined
            ? {}
            : { headers: { Authorization: `Bearer ${init.bearer}` } }),
        })
      ),
    appId,
    apiKey,
    coreErrors
  );
}
