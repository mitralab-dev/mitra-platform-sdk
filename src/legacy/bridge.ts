import { stripTrailingSlashes } from '../utils/url';
import { configureSdkMitra, getConfig, type LoginResponse } from 'mitra-interactions-sdk';
import type { AuthSessionPort } from '../modules/auth';
import { resolveAuthPageUrl } from '../modules/auth-page-url';

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
  private readonly auth: AuthSessionPort;
  private readonly appId: string;
  private readonly apiUrl: string;
  private readonly configuredAuthPageUrl?: string;
  private readonly legacyUrl: string;
  private unsubscribeFromAuth: (() => void) | null = null;

  constructor(auth: AuthSessionPort, appId: string, apiUrl: string, authPageUrl?: string) {
    this.auth = auth;
    this.appId = appId;
    this.apiUrl = apiUrl;
    this.configuredAuthPageUrl = authPageUrl;
    const gatewayUrl = stripTrailingSlashes(apiUrl);
    this.legacyUrl = gatewayUrl ? `${gatewayUrl}/legacy` : '';
  }

  /**
   * Configures the legacy SDK and hands it the session this SDK already holds.
   *
   * Called once per client. Failures are swallowed: an unusable legacy SDK must
   * not stop the new client from being created.
   */
  connect(): void {
    this.disconnect();
    this.syncToLegacy(this.auth.readSessionTokens());
    this.unsubscribeFromAuth = this.auth.onSessionChange((session) => {
      this.syncToLegacy(session);
    });
  }

  /** Stops this bridge from changing the process-wide legacy SDK singleton. */
  disconnect(): void {
    this.unsubscribeFromAuth?.();
    this.unsubscribeFromAuth = null;
  }

  private syncToLegacy(session: { token: string | null; refreshToken: string | null }): void {
    try {
      const authPageUrl = resolveAuthPageUrl(
        this.apiUrl,
        this.configuredAuthPageUrl
      ).toString();
      configureSdkMitra({
        baseURL: this.legacyUrl,
        authUrl: this.legacyUrl,
        authPageUrl,
        projectId: this.appId,
        onTokenRefresh: (session) => this.rotate(session),
        ...(session.token ? { token: session.token } : {}),
        ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
      });

      // The legacy package has no public sign-out API. `getConfig()` returns its
      // live config object, so removing credentials here safely disables legacy
      // calls and refresh without coupling to its private localStorage key.
      const legacyConfig = getConfig();
      if (!session.token) delete legacyConfig.token;
      if (!session.refreshToken) delete legacyConfig.refreshToken;
    } catch {
      // The legacy SDK rejects configurations this client cannot fix, such as a
      // blank apiUrl. The new surface keeps working without the bridge.
    }
  }

  /**
   * Stores a session produced by a legacy login. The AuthModule subscription
   * then writes that session back to the process-wide legacy config and
   * reinstates the refresh hook removed by legacy login. It is a new session, so
   * the extra login tokens of the previous one are dropped.
   */
  adopt(session: LoginResponse): void {
    this.applyLegacySession(session, false);
  }

  /**
   * Stores tokens the legacy SDK silently refreshed for the session already in
   * place. Unlike a legacy login, this keeps the extra login tokens, because the
   * session behind them did not change.
   */
  private rotate(session: LoginResponse): void {
    this.applyLegacySession(session, true);
  }

  private applyLegacySession(session: LoginResponse, isRotation: boolean): void {
    const tokens = {
      token: stripBearer(session.token),
      refreshToken: session.refreshToken ?? null,
    };
    const applied = isRotation
      ? this.auth.rotateSession(tokens)
      : this.auth.adoptSession(tokens);
    if (!applied) this.syncToLegacy(this.auth.readSessionTokens());
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
  activeBridge?.disconnect();
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
  activeBridge?.disconnect();
  activeBridge = null;
}
