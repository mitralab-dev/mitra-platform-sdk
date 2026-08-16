import { configureSdkMitra, getConfig, type LoginResponse } from 'mitra-interactions-sdk';
import type { AuthModule } from '../modules/auth';

/**
 * The legacy SDK accepts both a bare JWT and a `Bearer `-prefixed one, but this
 * SDK stores the bare token and adds the scheme when building the request. Any
 * token crossing the bridge is normalized to the bare form.
 */
function stripBearer(token: string): string {
  return token.replace(/^\s*(?:bearer\s+)+/i, '').trim();
}

/**
 * Keeps a single session shared between this SDK and `mitra-interactions-sdk`.
 *
 * The bridge only propagates sessions that one of the two SDKs already produced.
 * It never starts a login and never triggers a token refresh of its own, so the
 * single-flight refresh each SDK implements stays untouched.
 */
export class LegacySessionBridge {
  private readonly auth: AuthModule;
  private readonly appId: string;
  private readonly apiUrl: string;

  constructor(auth: AuthModule, appId: string, apiUrl: string) {
    this.auth = auth;
    this.appId = appId;
    this.apiUrl = apiUrl;
  }

  /**
   * Configures the legacy SDK and hands it the session this SDK already holds.
   *
   * Called once per client. Failures are swallowed: an unusable legacy SDK must
   * not stop the new client from being created.
   */
  connect(): void {
    const { token, refreshToken } = this.auth.readSessionTokens();

    try {
      configureSdkMitra({
        baseURL: this.apiUrl,
        projectId: this.appId,
        onTokenRefresh: (session) => this.adopt(session),
        ...(token ? { token } : {}),
        ...(refreshToken ? { refreshToken } : {}),
      });
    } catch {
      // The legacy SDK rejects configurations this client cannot fix, such as a
      // blank apiUrl. The new surface keeps working without the bridge.
    }
  }

  /**
   * Stores a session produced by the legacy SDK and reinstates the refresh hook.
   *
   * `configureSdkMitra` replaces the legacy global configuration instead of
   * merging into it, and the legacy login path calls it without a callback, so
   * `onTokenRefresh` has to be registered again after every legacy login.
   */
  adopt(session: LoginResponse): void {
    this.auth.adoptSession({
      token: stripBearer(session.token),
      refreshToken: session.refreshToken ?? null,
    });

    try {
      configureSdkMitra({
        ...getConfig(),
        onTokenRefresh: (refreshed) => this.adopt(refreshed),
      });
    } catch {
      // Nothing to reinstate when the legacy SDK is not configured.
    }
  }
}

let activeBridge: LegacySessionBridge | null = null;

/**
 * Registers the bridge the legacy login wrappers report their sessions to.
 *
 * The legacy SDK is a module-level singleton, so the bridge is one as well. A
 * second `createClient` call replaces the first, matching which client the
 * legacy SDK is configured against.
 *
 * @internal
 */
export function setActiveBridge(bridge: LegacySessionBridge): void {
  activeBridge = bridge;
}

/**
 * Propagates a legacy session to the active client, if there is one.
 *
 * A no-op when the application never called `createClient`, which is the case
 * for apps still running on the legacy SDK alone.
 *
 * @internal
 */
export function adoptLegacySession(session: LoginResponse): void {
  activeBridge?.adopt(session);
}

/**
 * Drops the active bridge.
 *
 * @internal
 */
export function resetActiveBridge(): void {
  activeBridge = null;
}
