import { stripTrailingSlashes } from '../utils/url';
import { createAuthModule, type AuthModule as CoreAuthModule } from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import { HttpClient, MitraApiError } from '../utils/http-client';
import { expectAuthTokenResponse, GoogleAuthFlow, normalizeAllTokens } from './google-auth';
import type {
  User,
  SignInCredentials,
  SignUpData,
  AllTokens,
  AuthSession,
  AuthTokenResponse,
  AuthStateChangeCallback,
  GoogleSignInOptions,
  MicrosoftSignInOptions,
} from './auth.types';

export type {
  User,
  SignInCredentials,
  SignUpData,
  AllTokens,
  MitraSpaceToken,
  PlatformSessionTokens,
  AuthSession,
  AuthStateChangeCallback,
  GoogleSignInOptions,
  MicrosoftSignInOptions,
} from './auth.types';

interface AuthModuleOptions {
  apiUrl?: string;
  authPageUrl?: string;
}

interface AuthSessionTokens {
  token: string | null;
  refreshToken: string | null;
}

type AuthSessionChangeCallback = (session: AuthSessionTokens) => void;

interface RefreshFlight {
  generation: number;
  promise: Promise<boolean>;
}

const DEFAULT_TOKEN_VALIDITY_MS = 30_000;

export interface AuthSessionPort {
  readonly accessToken: string | null;
  ensureFreshSession(minValidityMs?: number): Promise<boolean>;
  handleUnauthorized(requestToken: string | null): Promise<boolean>;
  readSessionTokens(): AuthSessionTokens;
  onSessionChange(callback: AuthSessionChangeCallback): () => void;
  adoptSession(session: { token: string; refreshToken?: string | null }): boolean;
  rotateSession(session: { token: string; refreshToken?: string | null }): boolean;
}

const sessionPorts = new WeakMap<AuthModule, AuthSessionPort>();

/** @internal */
export function getAuthSessionPort(auth: AuthModule): AuthSessionPort {
  const port = sessionPorts.get(auth);
  if (!port) throw new Error('Auth session port is unavailable.');
  return port;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.replace(/^Bearer\s+/i, '').split('.')[1];
    if (!part || typeof globalThis.atob !== 'function') return null;
    const base64 = part.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const value: unknown = JSON.parse(globalThis.atob(padded));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function belongsToApp(token: string, appId: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return true;
  return payload.app_id === appId;
}

function isTokenExpiring(token: string, minValidityMs: number): boolean {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  return exp * 1_000 - Date.now() < minValidityMs;
}

/** A value carrying neither token says nothing, so it reads as no field at all. */
function discardEmptyAllTokens(tokens: AllTokens | null | undefined): AllTokens | null {
  if (!tokens || (!tokens.platform && !tokens.mitraSpace)) return null;
  return tokens;
}

/**
 * `platform` always comes from the response, never from the previous value: IAM
 * is authoritative on the membership behind it, and it stops sending the field
 * once the app leaves the flag, so a kept pair would expire silently. A malformed
 * `platform` normalizes to `null` and reads the same way, as no membership.
 * `mitraSpace` is long-lived and only issued at login, so a refresh that carries
 * none, absent or malformed, keeps the current token. Once nothing is left, the
 * merge collapses to `null` instead of an all-null value.
 */
function mergeAllTokens(
  current: AllTokens | null,
  incoming: AllTokens | undefined
): AllTokens | null {
  return discardEmptyAllTokens({
    platform: incoming?.platform ?? null,
    mitraSpace: incoming?.mitraSpace ?? current?.mitraSpace ?? null,
  });
}

function isDefinitiveRefreshFailure(error: unknown): boolean {
  return error instanceof MitraApiError
    && error.status >= 400
    && error.status < 500
    && error.status !== 408
    && error.status !== 429;
}

/**
 * Authentication module for managing user sessions.
 *
 * Handles Google SSO, trusted session adoption, sign-out, and automatic token refresh.
 * Auth state is persisted to localStorage with key `mitra_auth_{appId}`
 * and restored on page reload.
 *
 * @example
 * ```typescript
 * await mitra.auth.signInWithGoogle({ mode: 'popup' });
 * console.log(mitra.auth.currentUser);
 * ```
 */
export class AuthModule {
  private readonly appId: string;
  private _currentUser: User | null = null;
  #accessToken: string | null = null;
  #refreshToken: string | null = null;
  #allTokens: AllTokens | null = null;
  private sessionGeneration = 0;
  private refreshFlight: RefreshFlight | null = null;
  private transientRefreshFailureGeneration: number | null = null;
  private readonly listeners: Set<AuthStateChangeCallback> = new Set();
  private readonly sessionListeners: Set<AuthSessionChangeCallback> = new Set();
  private readonly storageKey: string;
  private readonly publicClient: HttpClient;
  private readonly authedClient: HttpClient;
  private readonly currentUserApi: CoreAuthModule;
  private readonly googleAuth: GoogleAuthFlow;
  private readonly microsoftAuth: GoogleAuthFlow;

  constructor(appId: string, iamBaseUrl: string, options: AuthModuleOptions = {}) {
    this.appId = appId;
    const trimmedIamBaseUrl = stripTrailingSlashes(iamBaseUrl);
    const apiUrl = stripTrailingSlashes(
      options.apiUrl ??
        (trimmedIamBaseUrl.endsWith('/iam')
          ? trimmedIamBaseUrl.slice(0, -'/iam'.length)
          : trimmedIamBaseUrl)
    );
    this.storageKey = `mitra_auth_${appId}`;
    this.publicClient = new HttpClient({ baseUrl: iamBaseUrl, getToken: () => null });
    this.authedClient = new HttpClient({
      baseUrl: iamBaseUrl,
      getToken: () => this.#accessToken,
      beforeAuthenticatedRequest: () => this.ensureFreshSession().then(() => undefined),
      onUnauthorized: (requestToken) => this.handleUnauthorized(requestToken),
    });
    this.currentUserApi = createAuthModule(this.authedClient, coreErrors);
    this.googleAuth = new GoogleAuthFlow({
      appId,
      apiUrl,
      authPageUrl: options.authPageUrl,
      client: this.publicClient,
    });
    this.microsoftAuth = new GoogleAuthFlow({
      appId,
      apiUrl,
      authPageUrl: options.authPageUrl,
      client: this.publicClient,
      provider: 'microsoft',
    });
    this.loadFromStorage();
    const readAccessToken = () => this.#accessToken;
    sessionPorts.set(this, {
      get accessToken() {
        return readAccessToken();
      },
      ensureFreshSession: (minValidityMs) => this.ensureFreshSession(minValidityMs),
      handleUnauthorized: (requestToken) => this.handleUnauthorized(requestToken),
      readSessionTokens: () => this.readSessionTokens(),
      onSessionChange: (callback) => this.onSessionChange(callback),
      adoptSession: (session) => this.adoptSession(session),
      rotateSession: (session) => this.rotateSession(session),
    });
  }

  /** The currently authenticated user, or null. */
  get currentUser(): User | null {
    return this._currentUser;
  }

  /** The current JWT access token, or null. */
  get accessToken(): string | null {
    return this.#accessToken;
  }

  /**
   * Extra tokens IAM issues alongside the app session, or `null`.
   *
   * The getter is `null` whenever IAM did not send the field, which is the case
   * for every app that is not enabled server-side, and whenever what it sent
   * carries neither token. `platform` carries a
   * session-scoped token pair for the tenant that owns
   * the app and is refreshed together with the app session, so read it from this
   * getter right before use instead of caching it. `mitraSpace` is long-lived,
   * comes only from login, and is kept across refreshes. Auth-state listeners are
   * not notified when a refresh rotates `platform`.
   *
   * These tokens are wider than the app session: `platform` reaches tenant
   * endpoints the app token cannot, and the mitraSpace token is very long-lived
   * and has no refresh flow. Like the rest of the session they are persisted in
   * `localStorage` under `mitra_auth_{appId}`, so they survive reloads and any
   * script on the application origin can read them. The only gate is the
   * server-side per-app flag.
   *
   * @example
   * ```typescript
   * const spaceToken = mitra.auth.allTokens?.mitraSpace?.token;
   * ```
   */
  get allTokens(): AllTokens | null {
    return this.#allTokens;
  }

  /** Whether a user is currently authenticated (local check, not server-validated). */
  get isAuthenticated(): boolean {
    return this._currentUser !== null && this.#accessToken !== null;
  }

  /** @deprecated Email/password authentication is not implemented by IAM. Use Google or Microsoft SSO. */
  async signIn(_credentials: SignInCredentials): Promise<User> {
    throw new MitraApiError(
      'Email/password authentication is not available. Use signInWithGoogle() or signInWithMicrosoft().',
      0,
      'UNSUPPORTED_AUTH_METHOD'
    );
  }

  /**
   * Signs in with Google SSO.
   *
   * Popup mode is used by default. Redirect mode stores a one-time CSRF context
   * in `sessionStorage` and navigates to the configured `sdk-auth.html` page.
   * Call {@link completeGoogleSignInRedirect} during application startup to
   * finish a redirect response.
   *
   * The auth page is resolved from `createClient({ authPageUrl })`, then
   * `window.__mitraEnv.authPageUrl`, and finally `/sdk-auth.html` on the API
   * gateway origin.
   *
   * @param options - Popup or redirect mode.
   * @returns The authenticated and hydrated user in popup mode.
   * @throws {MitraApiError} When IAM rejects the authorization code.
   * @throws {Error} When the browser blocks or cancels the popup, the flow times
   * out, or the OAuth response fails origin, source, state, or shape validation.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.signInWithGoogle();
   * ```
   *
   * @example
   * ```typescript
   * await mitra.auth.signInWithGoogle({ mode: 'redirect' });
   * ```
   */
  async signInWithGoogle(options: GoogleSignInOptions = {}): Promise<User> {
    return this.establishSession(await this.googleAuth.signIn(options));
  }

  /**
   * Completes a Google redirect response from `#codeMitra` and `#stateMitra`.
   *
   * The method consumes and clears the fragment and stored CSRF context, sends
   * the single-use code directly to IAM, persists both tokens, calls `auth.me()`,
   * and notifies auth-state listeners. It returns `null` when the current URL is
   * not a Google SSO redirect. Redirect errors must carry the same `stateMitra`
   * stored at the start of the flow before their message is exposed or consumed.
   *
   * @returns The authenticated user, or `null` when no redirect result is present.
   *
   * @example
   * ```typescript
   * const redirectedUser = await mitra.auth.completeGoogleSignInRedirect();
   * if (redirectedUser) console.log(redirectedUser.email);
   * ```
   */
  async completeGoogleSignInRedirect(): Promise<User | null> {
    const tokenResponse = await this.googleAuth.completeRedirect();
    return tokenResponse ? this.establishSession(tokenResponse) : null;
  }

  /**
   * Signs in with Microsoft SSO: the same auth-page handshake as Google, exchanged
   * at IAM's `/auth/microsoft`. Popup by default; redirect mode navigates away.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.signInWithMicrosoft();
   * ```
   */
  async signInWithMicrosoft(options: MicrosoftSignInOptions = {}): Promise<User> {
    return this.establishSession(await this.microsoftAuth.signIn(options));
  }

  /**
   * Completes a Microsoft redirect response from `#codeMitra` and `#stateMitra`.
   * Mirrors {@link completeGoogleSignInRedirect}; returns `null` when the current
   * URL is not a Microsoft SSO redirect.
   */
  async completeMicrosoftSignInRedirect(): Promise<User | null> {
    const tokenResponse = await this.microsoftAuth.completeRedirect();
    return tokenResponse ? this.establishSession(tokenResponse) : null;
  }

  /** @deprecated Email/password registration is not implemented by IAM. Use Google or Microsoft SSO. */
  async signUp(_data: SignUpData): Promise<User> {
    throw new MitraApiError(
      'Email/password registration is not available. Use signInWithGoogle() or signInWithMicrosoft().',
      0,
      'UNSUPPORTED_AUTH_METHOD'
    );
  }

  /**
   * Signs out the current user, clearing all auth state and localStorage.
   *
   * @param redirectUrl - Optional URL to navigate to after sign-out.
   *
   * @example
   * ```typescript
   * mitra.auth.signOut();
   * mitra.auth.signOut('/login');
   * ```
   */
  signOut(redirectUrl?: string): void {
    this.clearAuthState();

    if (globalThis.window !== undefined && redirectUrl) {
      globalThis.window.location.href = redirectUrl;
    }
  }

  /**
   * Refreshes the session using the stored refresh token.
   *
   * Called automatically before requests whose JWT is close to expiry and on
   * `401` responses. Can also be called manually. Multiple proactive, reactive,
   * and manual calls are deduplicated into one refresh request.
   *
   * @returns `true` if refresh succeeded, `false` otherwise.
   *
   * @example
   * ```typescript
   * const ok = await mitra.auth.refreshSession();
   * if (!ok) mitra.auth.redirectToLogin();
   * ```
   */
  async refreshSession(): Promise<boolean> {
    if (!this.#refreshToken) return false;

    if (!this.hasValidAppIdentity()) {
      this.clearAuthState();
      return false;
    }

    const generation = this.sessionGeneration;
    if (this.refreshFlight?.generation === generation) {
      return this.refreshFlight.promise;
    }

    this.transientRefreshFailureGeneration = null;
    const flight: RefreshFlight = {
      generation,
      promise: this.doRefresh(generation, this.#refreshToken),
    };
    this.refreshFlight = flight;
    try {
      return await flight.promise;
    } finally {
      if (this.refreshFlight === flight) {
        this.refreshFlight = null;
      }
    }
  }

  /**
   * Resolves a 401 against the credential that actually reached the server.
   * A newer session is retried as-is instead of being refreshed because of an
   * older request. A signed-out session is neither refreshed nor retried.
   *
   * @param requestToken - Access token attached to the rejected request.
   * @returns Whether the request should be retried once with the current token.
   *
   * @internal
   */
  private async handleUnauthorized(requestToken: string | null): Promise<boolean> {
    const currentToken = this.#accessToken;
    if (!currentToken) return false;
    if (currentToken !== requestToken) return true;
    return this.refreshSession();
  }

  /**
   * Fetches the current user from the server and updates local state.
   *
   * Clears auth state on a definitive 401. When the request reaches 401 after
   * IAM refresh failed due to a network error, 408, 429, or 5xx response, the
   * retained session is preserved and this method returns null.
   *
   * @returns The user if authenticated, `null` otherwise.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.me();
   * if (!user) console.log('Not authenticated');
   * ```
   */
  async me(): Promise<User | null> {
    if (!this.#accessToken) return null;
    const generation = this.sessionGeneration;

    try {
      const user = await this.getCurrentUser();
      if (generation !== this.sessionGeneration) return null;

      this._currentUser = user;
      this.transientRefreshFailureGeneration = null;
      this.saveToStorage();
      this.notifyListeners();
      return user;
    } catch (error) {
      if (
        error instanceof MitraApiError
        && error.status === 401
        && this.#accessToken
        && generation === this.sessionGeneration
        && this.transientRefreshFailureGeneration !== this.sessionGeneration
      ) {
        this.clearAuthState();
      }
      return null;
    }
  }

  /**
   * Validates the current session with the server.
   *
   * @returns `true` if the session is valid, `false` otherwise.
   *
   * @example
   * ```typescript
   * const valid = await mitra.auth.checkAuth();
   * if (!valid) mitra.auth.redirectToLogin();
   * ```
   */
  async checkAuth(): Promise<boolean> {
    return (await this.me()) !== null;
  }

  /**
   * Sets the access token manually (e.g., from SSO/OAuth callback).
   *
   * Call `me()` afterwards to fetch the associated user data. The extra tokens
   * are dropped because they belong to the session being replaced.
   *
   * @param token - JWT access token.
   * @param saveToStorage - Whether to persist to localStorage (default: true).
   *
   * @example
   * ```typescript
   * mitra.auth.setToken(tokenFromCallback);
   * await mitra.auth.me();
   * ```
   */
  setToken(token: string, saveToStorage: boolean = true): void {
    if (!this.belongsToConfiguredApp(token)) {
      this.clearAuthState();
      return;
    }
    this.invalidatePendingRefreshes();
    this.#accessToken = token;
    this.#allTokens = null;
    if (saveToStorage) {
      this.saveToStorage();
    }
    this.notifySessionListeners();
  }

  /**
   * Reads the tokens currently held by this module.
   *
   * Used by the legacy session bridge to hand a session persisted by this SDK
   * over to `mitra-interactions-sdk` on startup.
   *
   * @returns The access and refresh tokens, each `null` when absent.
   *
   * @internal
   */
  private readSessionTokens(): AuthSessionTokens {
    return { token: this.#accessToken, refreshToken: this.#refreshToken };
  }

  /**
   * Adopts an app-scoped session received from a trusted platform boundary.
   *
   * This preserves the access and refresh tokens together so the normal refresh
   * lifecycle continues after an embedded preview hands its session to the app.
   * Call {@link checkAuth} afterward to validate the token and hydrate the user.
   * {@link allTokens} goes back to `null` because the extra tokens belong to the
   * session being replaced.
   */
  setSession(session: AuthSession): boolean {
    return this.adoptSession({
      token: session.accessToken,
      refreshToken: session.refreshToken ?? null,
    });
  }

  /**
   * Ensures the current access token has enough remaining validity.
   *
   * JWT decoding is used only as a scheduling heuristic. Opaque tokens and JWTs
   * without a numeric `exp` claim proceed unchanged and remain server-authoritative.
   * Multiple proactive and reactive callers share the same refresh request.
   * Transient refresh failures preserve the current session so the caller can
   * continue and rely on the normal one-time `401` refresh fallback.
   *
   * This method is suitable for authenticated HTTP, WebSocket, and Server-Sent
   * Events boundaries that need a fresh token before connecting.
   *
   * @param minValidityMs - Minimum remaining token lifetime. Defaults to 30 seconds.
   * @returns `true` when no refresh is needed or refresh succeeds. Returns
   * `false` when a required refresh fails, even when a transient failure keeps
   * the current session available for a reactive server-authoritative fallback.
   */
  async ensureFreshSession(minValidityMs: number = DEFAULT_TOKEN_VALIDITY_MS): Promise<boolean> {
    if (!Number.isFinite(minValidityMs) || minValidityMs < 0) {
      throw new RangeError('minValidityMs must be a finite non-negative number');
    }
    if (!this.#accessToken) return false;
    if (!this.hasValidAppIdentity()) {
      this.clearAuthState();
      return false;
    }
    if (!isTokenExpiring(this.#accessToken, minValidityMs)) return true;

    return this.refreshSession();
  }

  /**
   * Subscribes an internal boundary to token changes without triggering login
   * or refresh. Unlike auth-state listeners, this callback is not invoked
   * immediately and does not depend on the user being hydrated.
   *
   * @param callback - Receives the current access and refresh tokens.
   * @returns A function that removes the callback.
   *
   * @internal
   */
  private onSessionChange(callback: AuthSessionChangeCallback): () => void {
    this.sessionListeners.add(callback);
    return () => this.sessionListeners.delete(callback);
  }

  /**
   * Adopts a session produced outside this module, such as a legacy SSO login.
   *
   * Replaces the in-memory tokens and persists them under the same storage key
   * the rest of the module uses. The current user is left untouched because the
   * legacy SDK does not return one; call `me()` to hydrate it. The extra tokens
   * are dropped because they belong to the session being replaced.
   *
   * @param session - Access token and, when the issuer returned one, refresh token.
   *
   * @internal
   */
  private adoptSession(session: { token: string; refreshToken?: string | null }): boolean {
    return this.applySession(session, false);
  }

  /**
   * Stores tokens another issuer rotated for the session already in place, such
   * as a silent refresh performed by the legacy SDK.
   *
   * This is not a login, so the extra tokens are kept: the user and the session
   * behind them did not change.
   *
   * @param session - Rotated access token and, when the issuer returned one, refresh token.
   *
   * @internal
   */
  private rotateSession(session: { token: string; refreshToken?: string | null }): boolean {
    return this.applySession(session, true);
  }

  private applySession(
    session: { token: string; refreshToken?: string | null },
    keepAllTokens: boolean
  ): boolean {
    if (
      !this.belongsToConfiguredApp(session.token)
      || (
        typeof session.refreshToken === 'string'
        && !this.belongsToConfiguredApp(session.refreshToken)
      )
    ) {
      this.clearAuthState();
      return false;
    }
    this.invalidatePendingRefreshes();
    if (!keepAllTokens) this.#allTokens = null;
    this.#accessToken = session.token;
    if (session.refreshToken !== undefined) {
      this.#refreshToken = session.refreshToken;
    }
    this.saveToStorage();
    this.notifySessionListeners();
    return true;
  }

  /**
   * Redirects to `/login?returnUrl=...` for unauthenticated users.
   *
   * @param returnUrl - URL to return to after login (default: '/').
   *
   * @example
   * ```typescript
   * if (!mitra.auth.isAuthenticated) {
   *   mitra.auth.redirectToLogin(window.location.pathname);
   * }
   * ```
   */
  redirectToLogin(returnUrl: string = '/'): void {
    if (globalThis.window === undefined) return;
    globalThis.window.location.href = `/login?returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  /**
   * Registers a callback for auth state changes.
   *
   * Called immediately with the current state, then on every sign-in/sign-out.
   *
   * @param callback - Receives the User on login, null on logout.
   * @returns Unsubscribe function.
   *
   * @example
   * ```typescript
   * useEffect(() => {
   *   const unsub = mitra.auth.onAuthStateChange((user) => {
   *     setUser(user);
   *     setLoading(false);
   *   });
   *   return unsub;
   * }, []);
   * ```
   */
  onAuthStateChange(callback: AuthStateChangeCallback): () => void {
    this.listeners.add(callback);
    callback(this._currentUser);

    return () => {
      this.listeners.delete(callback);
    };
  }

  private async doRefresh(generation: number, refreshToken: string): Promise<boolean> {
    let tokenResponse: AuthTokenResponse;
    try {
      tokenResponse = expectAuthTokenResponse(
        await this.publicClient.post<unknown>(
          '/api/v1/auth/refresh-token',
          { refreshToken }
        )
      );
    } catch (error) {
      if (generation !== this.sessionGeneration) return false;
      if (isDefinitiveRefreshFailure(error)) {
        this.clearAuthState();
      } else {
        this.transientRefreshFailureGeneration = generation;
      }
      return false;
    }

    if (generation !== this.sessionGeneration) return false;
    if (
      !this.belongsToConfiguredApp(tokenResponse.accessToken)
      || !this.belongsToConfiguredApp(tokenResponse.refreshToken)
    ) {
      this.clearAuthState();
      return false;
    }

    this.#accessToken = tokenResponse.accessToken;
    this.#refreshToken = tokenResponse.refreshToken;
    this.#allTokens = mergeAllTokens(this.#allTokens, tokenResponse.allTokens);
    this.transientRefreshFailureGeneration = null;
    this.saveToStorage();
    this.notifySessionListeners();
    return true;
  }

  private async establishSession(tokenResponse: AuthTokenResponse): Promise<User> {
    if (
      !this.belongsToConfiguredApp(tokenResponse.accessToken)
      || !this.belongsToConfiguredApp(tokenResponse.refreshToken)
    ) {
      this.clearAuthState();
      throw coreErrors.invalidResponse('Authentication returned a token for a different app');
    }
    this.invalidatePendingRefreshes();
    const generation = this.sessionGeneration;
    this.#accessToken = tokenResponse.accessToken;
    this.#refreshToken = tokenResponse.refreshToken;
    this.#allTokens = discardEmptyAllTokens(tokenResponse.allTokens);

    try {
      const user = await this.getCurrentUser();
      if (generation !== this.sessionGeneration) {
        throw new Error('Authentication session was superseded');
      }
      this.setAuthState(user, this.#accessToken!, this.#refreshToken!);
      return user;
    } catch (error) {
      if (generation === this.sessionGeneration) {
        this.clearAuthState();
      }
      throw error;
    }
  }

  private setAuthState(user: User, token: string, refreshToken: string): void {
    this._currentUser = user;
    this.#accessToken = token;
    this.#refreshToken = refreshToken;
    this.saveToStorage();
    this.notifySessionListeners();
    this.notifyListeners();
  }

  private async getCurrentUser(): Promise<User> {
    const user = await this.currentUserApi.me();
    return { ...user, tenantId: user.tenant.id };
  }

  private clearAuthState(): void {
    const hadAuthState = this._currentUser !== null
      || this.#accessToken !== null
      || this.#refreshToken !== null;
    this.invalidatePendingRefreshes();
    this._currentUser = null;
    this.#accessToken = null;
    this.#refreshToken = null;
    this.#allTokens = null;
    this.removeFromStorage();
    if (hadAuthState) {
      this.notifySessionListeners();
      this.notifyListeners();
    }
  }

  private invalidatePendingRefreshes(): void {
    this.sessionGeneration += 1;
    this.transientRefreshFailureGeneration = null;
  }

  private hasValidAppIdentity(): boolean {
    return (!this.#accessToken || this.belongsToConfiguredApp(this.#accessToken))
      && (!this.#refreshToken || this.belongsToConfiguredApp(this.#refreshToken));
  }

  private belongsToConfiguredApp(token: string): boolean {
    return belongsToApp(token, this.appId);
  }

  private notifySessionListeners(): void {
    const session = this.readSessionTokens();
    this.sessionListeners.forEach((callback) => {
      try {
        callback(session);
      } catch {
        // Internal session observers must not break authentication.
      }
    });
  }

  private notifyListeners(): void {
    this.listeners.forEach((callback) => {
      try {
        callback(this._currentUser);
      } catch (error) {
        console.error('Auth state change listener error:', error);
      }
    });
  }

  private saveToStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({
          user: this._currentUser,
          token: this.#accessToken,
          refreshToken: this.#refreshToken,
          // Omitted for apps without the extra tokens, keeping the stored shape unchanged.
          ...(this.#allTokens ? { allTokens: this.#allTokens } : {}),
        })
      );
    } catch {
      // Storage might be full or disabled
    }
  }

  private loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const { user, token, refreshToken, allTokens } = JSON.parse(stored);
        if (
          typeof token !== 'string'
          || (refreshToken !== null && refreshToken !== undefined && typeof refreshToken !== 'string')
          || !this.belongsToConfiguredApp(token)
          || (
            typeof refreshToken === 'string'
            && !this.belongsToConfiguredApp(refreshToken)
          )
        ) {
          this.clearAuthState();
          return;
        }
        this._currentUser = user;
        this.#accessToken = token;
        this.#refreshToken = refreshToken ?? null;
        this.#allTokens = discardEmptyAllTokens(normalizeAllTokens(allTokens));
        this.invalidatePendingRefreshes();
      }
    } catch {
      this.removeFromStorage();
    }
  }

  private removeFromStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      // Storage might be disabled
    }
  }
}
