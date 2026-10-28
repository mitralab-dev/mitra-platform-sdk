import { stripTrailingSlashes } from '../utils/url';
import { createAuthModule, expectObject, type AuthModule as CoreAuthModule } from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import { HttpClient, MitraApiError } from '../utils/http-client';
import { assertServerRuntime, resolveApiKeySession } from './api-key-auth';
import {
  expectAuthTokenResponse,
  AuthPageFlow,
  normalizeAllTokens,
  PASSWORD_CHANGED_SIGN_IN_AGAIN,
} from './auth-page-flow';
import { EmailCodeFlow, resolveLanguage } from './email-code-flow';
import { IdentityConnectionFlow } from './identity-connection-flow';
import { PasswordFormFlow, passwordChangedSignInAgain } from './password-form-flow';
import type {
  User,
  SignInCredentials,
  SignUpData,
  AllTokens,
  BackofficeToken,
  AuthSession,
  AuthTokenResponse,
  AuthStateChangeCallback,
  EmailCodeRequest,
  EmailCodeRequestResult,
  EmailCodeVerification,
  EmailSignInOptions,
  GoogleSignInOptions,
  MicrosoftSignInOptions,
  PasswordChange,
  PasswordResetConfirmation,
  PasswordResetOptions,
  PasswordResetRequestResult,
  PasswordSignUpCompletion,
  PasswordSignUpRequest,
  PasswordSignUpRequestResult,
} from './auth.types';

export type {
  User,
  SignInCredentials,
  SignUpData,
  AllTokens,
  BackofficeToken,
  MitraSpaceToken,
  PlatformSessionTokens,
  AuthSession,
  AuthStateChangeCallback,
  AuthPageSignInOptions,
  EmailCodeLanguage,
  EmailCodeRequest,
  EmailCodeRequestResult,
  EmailCodeVerification,
  EmailSignInOptions,
  GoogleSignInOptions,
  MicrosoftSignInOptions,
  PasswordChange,
  PasswordResetConfirmation,
  PasswordResetOptions,
  PasswordResetRequestResult,
  PasswordSignUpCompletion,
  PasswordSignUpRequest,
  PasswordSignUpRequestResult,
} from './auth.types';

interface AuthModuleOptions {
  apiUrl?: string;
  authPageUrl?: string;
  /** Default api key for `signInWithApiKey`, taken from the client configuration. */
  apiKey?: string;
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
const LOGOUT_PATH = '/api/v1/auth/logout';
const PASSWORD_RESET_PATH = '/api/v1/auth/password/reset';

/**
 * Twice the app session's margin because there is no second chance here: the
 * backoffice token is spent on a request to another service, which this SDK
 * never sees, so one that expires in flight becomes a `401` no reactive refresh
 * can retry. The margin has to cover the request, not just its dispatch.
 */
const DEFAULT_BACKOFFICE_TOKEN_VALIDITY_MS = 60_000;

export interface AuthSessionPort {
  readonly accessToken: string | null;
  ensureFreshSession(minValidityMs?: number): Promise<boolean>;
  handleUnauthorized(requestToken: string | null): Promise<boolean>;
  readSessionTokens(): AuthSessionTokens;
  /** Whether the current session is kept for its tab only (`sessionStorage`). */
  isTabScoped(): boolean;
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

function subjectOf(token: string): string | null {
  const sub = decodeJwtPayload(token)?.sub;
  return typeof sub === 'string' && sub !== '' ? sub : null;
}

/**
 * Whether a refresh token is the session of an exclusive app account, the only
 * kind IAM ends at `/auth/logout`. In a shared app the session is the person's
 * platform session, which that route leaves alone while still answering 204,
 * so the request would only cost a round trip.
 */
function isExclusiveAppSession(refreshToken: string): boolean {
  return decodeJwtPayload(refreshToken)?.login_mode === 'exclusive';
}

function expectPasswordResetRequestResult(value: unknown): PasswordResetRequestResult {
  const response = expectObject<Record<string, unknown>>(
    value,
    'Password reset request response',
    coreErrors
  );
  if (typeof response.resendAfterSeconds !== 'number' || !Number.isFinite(response.resendAfterSeconds)) {
    throw coreErrors.invalidResponse(
      'Password reset request response has an invalid resendAfterSeconds field'
    );
  }
  return { resendAfterSeconds: response.resendAfterSeconds };
}

function isTokenExpiring(token: string, minValidityMs: number): boolean {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  return exp * 1_000 - Date.now() < minValidityMs;
}

/** A value carrying none of the tokens says nothing, so it reads as no field at all. */
function discardEmptyAllTokens(tokens: AllTokens | null | undefined): AllTokens | null {
  if (!tokens || (!tokens.platform && !tokens.mitraSpace && !tokens.b2bToken && !tokens.backoffice)) {
    return null;
  }
  return tokens;
}

/**
 * IAM recomputes `platform` and `backoffice` on every app refresh, so they are
 * taken as sent, `null` included: a `null` is how a revoked backoffice grant
 * arrives. It sends `mitraSpace` and `b2bToken` as `null` on refresh on purpose:
 * the Space token is long-lived and the peer session is renewed by the app
 * itself, so a `null` there keeps what the login issued. IAM omits the field
 * whenever the app is not entitled to these tokens, so a refresh without it
 * clears everything instead of keeping one-hour pairs that would expire unseen.
 */
function mergeAllTokens(current: AllTokens | null, incoming: AllTokens | undefined): AllTokens | null {
  if (!incoming) return null;
  return discardEmptyAllTokens(Object.freeze({
    platform: incoming.platform,
    mitraSpace: incoming.mitraSpace ?? current?.mitraSpace ?? null,
    b2bToken: incoming.b2bToken ?? current?.b2bToken ?? null,
    backoffice: incoming.backoffice,
  }));
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
 * Handles Google and Microsoft SSO, email and password sign-in, trusted session adoption, sign-out,
 * and automatic token refresh.
 * Auth state is persisted to localStorage with key `mitra_auth_{appId}`
 * and restored on page reload; a session from an identity connection is kept
 * in sessionStorage under the same key instead, so it lives in its tab only.
 *
 * @example
 * ```typescript
 * await mitra.auth.signInWithGoogle({ mode: 'popup' });
 * console.log(mitra.auth.currentUser);
 * ```
 */
export class AuthModule {
  private readonly appId: string;
  private readonly defaultApiKey: string | undefined;
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
  private readonly googleAuth: AuthPageFlow;
  private readonly microsoftAuth: AuthPageFlow;
  private readonly emailAuth: AuthPageFlow;
  private readonly passwordAuth: AuthPageFlow;
  private readonly emailCode: EmailCodeFlow;
  private readonly passwordForm: PasswordFormFlow;
  private readonly identityConnection: IdentityConnectionFlow;
  private brand: string | null = null;
  /**
   * Whether the session lives in `sessionStorage`, scoped to its tab, rather
   * than in `localStorage`. Set for a session from an identity connection: the
   * host system opens one app per account it signed in, and two of them in one
   * browser (two Sankhya demo bases, for instance) sharing `localStorage` would
   * hand each other's session, and identity attributes, to the next reload.
   */
  private sessionScoped = false;

  constructor(appId: string, iamBaseUrl: string, options: AuthModuleOptions = {}) {
    this.appId = appId;
    const trimmedIamBaseUrl = stripTrailingSlashes(iamBaseUrl);
    const apiUrl = stripTrailingSlashes(
      options.apiUrl ??
        (trimmedIamBaseUrl.endsWith('/iam')
          ? trimmedIamBaseUrl.slice(0, -'/iam'.length)
          : trimmedIamBaseUrl)
    );
    this.defaultApiKey = options.apiKey;
    this.storageKey = `mitra_auth_${appId}`;
    this.publicClient = new HttpClient({ baseUrl: iamBaseUrl, getToken: () => null });
    this.authedClient = new HttpClient({
      baseUrl: iamBaseUrl,
      getToken: () => this.#accessToken,
      beforeAuthenticatedRequest: () => this.ensureFreshSession().then(() => undefined),
      onUnauthorized: (requestToken) => this.handleUnauthorized(requestToken),
    });
    this.currentUserApi = createAuthModule(this.authedClient, coreErrors);
    this.googleAuth = new AuthPageFlow({
      appId,
      apiUrl,
      authPageUrl: options.authPageUrl,
      client: this.publicClient,
    });
    this.microsoftAuth = new AuthPageFlow({
      appId,
      apiUrl,
      authPageUrl: options.authPageUrl,
      client: this.publicClient,
      provider: 'microsoft',
    });
    this.emailAuth = new AuthPageFlow({
      appId,
      apiUrl,
      authPageUrl: options.authPageUrl,
      client: this.publicClient,
      provider: 'email',
    });
    this.passwordAuth = new AuthPageFlow({
      appId,
      apiUrl,
      authPageUrl: options.authPageUrl,
      client: this.publicClient,
      provider: 'password',
    });
    this.emailCode = new EmailCodeFlow({
      appId,
      client: this.publicClient,
      pendingRequest: this.emailAuth,
    });
    this.passwordForm = new PasswordFormFlow({
      appId,
      client: this.publicClient,
      exchange: this.passwordAuth,
    });
    this.identityConnection = new IdentityConnectionFlow({ appId, client: this.publicClient });
    this.loadFromStorage();
    const readAccessToken = () => this.#accessToken;
    sessionPorts.set(this, {
      get accessToken() {
        return readAccessToken();
      },
      ensureFreshSession: (minValidityMs) => this.ensureFreshSession(minValidityMs),
      handleUnauthorized: (requestToken) => this.handleUnauthorized(requestToken),
      readSessionTokens: () => this.readSessionTokens(),
      isTabScoped: () => this.sessionScoped,
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
   * Extra tokens IAM issues at login for apps enabled server-side, or `null`
   * when IAM did not send them. They are reset by every new session and updated
   * on each app refresh, and these changes are not announced to auth-state
   * listeners, so read them here right before use instead of caching them.
   *
   * The `backoffice` token is read through {@link ensureFreshBackofficeToken}
   * instead, which renews it: it expires well before the app session that
   * carries it.
   *
   * @example
   * ```typescript
   * const b2bAccessToken = mitra.auth.allTokens?.b2bToken?.accessToken;
   * ```
   */
  get allTokens(): AllTokens | null {
    return this.#allTokens;
  }

  /** Whether a user is currently authenticated (local check, not server-validated). */
  get isAuthenticated(): boolean {
    return this._currentUser !== null && this.#accessToken !== null;
  }

  /**
   * @deprecated Use signInWithPassword(), which opens the Mitra auth page,
   * signInWithPasswordForm() in an app with the form mode on, signInWithEmail() or SSO.
   */
  signIn(_credentials: SignInCredentials): Promise<User> {
    return Promise.reject(
      new MitraApiError(
        'Email/password authentication is not available. Use signInWithPassword(), signInWithEmail(), signInWithGoogle() or signInWithMicrosoft().',
        0,
        'UNSUPPORTED_AUTH_METHOD'
      )
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
   * Signs in as a process, with an api key instead of a person's SSO session.
   *
   * Use this where nobody can complete a redirect: a cron, a background collector, another
   * service. Create the key in Settings -> API keys. A Business key reaches the published
   * product, a Developer key adds authoring, and an Administrator key belongs to a workspace -
   * from that one the platform issues this app's token, deciding then and there what the key's
   * owner actually reaches here.
   *
   * The session is not written to storage and carries no refresh token: the key does not
   * expire and is revoked by deleting it, so renewing means signing in again.
   *
   * Server runtimes only. In a browser the key would ship inside the bundle, so this method
   * refuses to run there.
   *
   * @param apiKey - The key to use. Defaults to `apiKey` from the client configuration.
   * @returns The user the key belongs to.
   *
   * @example
   * ```typescript
   * const mitra = createClient({ appId, apiUrl, apiKey: process.env.MITRA_API_KEY });
   * await mitra.auth.signInWithApiKey();
   * ```
   */
  async signInWithApiKey(apiKey: string | undefined = this.defaultApiKey): Promise<User> {
    assertServerRuntime();

    if (!apiKey?.trim()) {
      throw new MitraApiError(
        'No api key was given. Pass one to signInWithApiKey, or set apiKey when creating the client.',
        400
      );
    }

    const token = await resolveApiKeySession(this.publicClient, this.appId, apiKey);
    if (!this.belongsToConfiguredApp(token)) {
      throw new MitraApiError('This api key does not reach the app this client is configured for.', 403);
    }

    this.invalidatePendingRefreshes();
    this.#accessToken = token;
    this.#refreshToken = null;
    this.#allTokens = null;

    const user = await this.getCurrentUser();
    this._currentUser = user;
    this.notifySessionListeners();
    this.notifyListeners();
    return user;
  }

  /**
   * Completes a Google redirect response from `#codeMitra` and `#stateMitra`.
   *
   * The method consumes and clears the fragment and stored CSRF context, sends
   * the single-use code directly to IAM, persists both tokens, calls `auth.me()`,
   * and notifies auth-state listeners. It returns `null` when the current URL
   * carries no redirect result, and also when it carries one this flow never
   * started, so an application that offers several methods can call every
   * completion at startup. Redirect errors must carry the same `stateMitra`
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

  /**
   * Signs in with a one-time code sent by email: the same auth-page handshake as
   * SSO, where the platform page collects the address and the code, and IAM
   * hands back a single-use exchange code redeemed at `/auth/magic-link/exchange`.
   * Popup by default; redirect mode navigates away.
   *
   * The message also carries a link. Because that link opens a new tab, the
   * pending request is kept in `localStorage` for 10 minutes - the one-time state
   * and the auth page URL, never a token - so
   * {@link completeEmailSignInRedirect} can finish the flow in that tab.
   *
   * @param options - Popup or redirect mode.
   * @returns The authenticated and hydrated user in popup mode.
   * @throws {MitraApiError} When IAM rejects the exchange code.
   * @throws {Error} When the browser blocks or cancels the popup, the flow times
   * out, or the response fails origin, source, state, or shape validation. A
   * person who finishes through the link instead of the popup leaves this call
   * to time out, which the application should treat as a cancelled popup.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.signInWithEmail();
   * ```
   */
  async signInWithEmail(options: EmailSignInOptions = {}): Promise<User> {
    return this.establishSession(await this.emailAuth.signIn(options));
  }

  /**
   * Publishes the brand `init()` read from the app info, which IAM needs to
   * choose the message it sends for {@link requestEmailCode}.
   *
   * @internal
   */
  setBrand(brand: string): void {
    this.brand = brand;
  }

  /**
   * Asks IAM to email a six-digit code, without any platform screen: the
   * application renders its own address and code fields, and the message is
   * branded as the app. Answer it with {@link verifyEmailCode}.
   *
   * The same message also carries a link back to this application's own origin.
   * Sign-in continues there through {@link completeEmailSignInRedirect}, so the
   * request is written to `localStorage` under `mitra_email_redirect_{appId}` -
   * the one-time state and this origin, never a token - for 10 minutes. Only the
   * browser that asked can finish through the link.
   *
   * Resending is calling this again: the new request replaces the pending one,
   * and `resendAfterSeconds` says how long the application should wait before
   * offering that.
   *
   * @param request - Address to send to, and the language to write in.
   * @returns The receipt that names this request, and the resend delay.
   * @throws {MitraApiError} `INVALID_CONFIGURATION` before `init()` resolved the
   * app info, `RATE_LIMITED` (with `retryAfterSeconds`) when IAM asks the person
   * to wait, and the app access codes when this app refuses the address.
   *
   * @example
   * ```typescript
   * const { receipt, resendAfterSeconds } = await mitra.auth.requestEmailCode({
   *   email: 'person@example.com',
   * });
   * ```
   */
  async requestEmailCode(request: EmailCodeRequest): Promise<EmailCodeRequestResult> {
    return this.emailCode.requestCode(request, this.requireBrand());
  }

  /**
   * Turns the code from the message into a session, hydrating and persisting it
   * exactly like SSO does.
   *
   * @param verification - The receipt from {@link requestEmailCode} and the code
   * the person typed.
   * @returns The authenticated and hydrated user.
   * @throws {MitraApiError} `INVALID_CODE` when the code does not match,
   * `MAGIC_LINK_EXPIRED` or `MAGIC_LINK_USED` when the request is over.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.verifyEmailCode({ receipt, code: '123456' });
   * ```
   */
  async verifyEmailCode(verification: EmailCodeVerification): Promise<User> {
    return this.establishSession(await this.emailCode.verifyCode(verification));
  }

  /**
   * Completes an email sign-in during application startup, like
   * {@link completeGoogleSignInRedirect}.
   *
   * It covers every way the flow comes back. The link in the message lands on
   * this application's own origin as `#emailToken=`, and that is the headless
   * flow: the link is inspected before it is spent, and it is only spent when
   * IAM reports the same origin the page is on and the one-time state of the
   * request pending in this browser. A browser without that request - another
   * device, or a scanner opening links on the way to a mailbox - consumes
   * nothing and leaves the link valid for the person who asked for it.
   *
   * The platform auth page instead comes back as `#codeMitra` and `#stateMitra`,
   * from the redirect in the tab that started it or from the tab the older link
   * opened, and is completed by the same state check.
   *
   * From the link, only `emailToken` leaves the URL, so a fragment the
   * application routes on is left as it was. Coming back from the platform auth
   * page, the fragment is removed whole.
   *
   * @returns The authenticated user, or `null` when the URL carries no result,
   * carries one that belongs to another sign-in method's flow, or carries a link
   * this browser cannot claim.
   * @throws {MitraApiError} `MAGIC_LINK_EXPIRED`, `MAGIC_LINK_USED`, or
   * `MAGIC_LINK_INVALID` when the link belongs here but cannot be used.
   */
  async completeEmailSignInRedirect(): Promise<User | null> {
    const linkResponse = await this.emailCode.completeLink();
    if (linkResponse) return this.establishSession(linkResponse);

    const tokenResponse = await this.emailAuth.completeRedirect();
    return tokenResponse ? this.establishSession(tokenResponse) : null;
  }

  /**
   * Completes a sign-in made through an identity connection, such as Sankhya
   * Pass, from the single-use code the platform bridge page leaves in the
   * fragment (`#codeMitra`, `#stateMitra=connection.*`, `#connectionMitra`).
   *
   * `init()` already calls it, so an application only calls it itself when it
   * does not call `init()`. The session is kept in `sessionStorage`, not
   * `localStorage`, and so lives only as long as its tab.
   *
   * @returns The authenticated user, or `null` when the URL carries no
   * identity connection result. A fragment of another sign-in method is left
   * untouched.
   * @throws When the fragment belongs to an identity connection but cannot be
   * redeemed: outside an iframe, with an invalid connection, an error from the
   * bridge, no code, or a code IAM refuses. The fragment is removed first, and
   * the session this page held is dropped from memory, though not from storage.
   */
  async completeIdentityConnectionSignInRedirect(): Promise<User | null> {
    let tokenResponse: AuthTokenResponse | null;
    try {
      tokenResponse = await this.identityConnection.completeRedirect();
    } catch (error) {
      // The host system signed someone in here and it was refused. The session
      // restored at startup may be another person's, so it stops being used in
      // this page; it stays stored for the tabs it belongs to. This covers every
      // failure of a fragment of this flow on purpose, a forged one in a
      // top-level tab included, not only a code IAM refused.
      this.clearAuthState({ keepStorage: true });
      throw error;
    }
    return tokenResponse ? this.establishSession(tokenResponse, true) : null;
  }

  /**
   * @deprecated Use signUpWithPassword(), which opens the Mitra auth page,
   * startPasswordSignUp() in an app with the form mode on, signInWithEmail() or SSO.
   */
  signUp(_data: SignUpData): Promise<User> {
    return Promise.reject(
      new MitraApiError(
        'Email/password registration is not available. Use signUpWithPassword(), signInWithEmail(), signInWithGoogle() or signInWithMicrosoft().',
        0,
        'UNSUPPORTED_AUTH_METHOD'
      )
    );
  }

  /**
   * Signs in with email and password, typed into the Mitra auth page in a popup.
   * The password never reaches the app's code: the page sends it to IAM and
   * hands back a single-use exchange code, redeemed like the email sign-in.
   *
   * Offer it only when `mitra.passwordLoginEnabled` is `true`, which needs an
   * app whose accounts are its own (exclusive login mode). Call it straight
   * from the click handler, before any `await`, or the browser blocks the popup.
   *
   * @returns The authenticated and hydrated user.
   * @throws {MitraApiError} When IAM rejects the exchange code.
   * @throws {Error} When the browser blocks or cancels the popup, the flow times
   * out, or the response fails origin, source, state, or shape validation. Wrong
   * credentials are answered on the auth page itself, not here.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.signInWithPassword();
   * ```
   */
  async signInWithPassword(): Promise<User> {
    return this.establishSession(await this.passwordAuth.signInWithPopup({ view: 'login' }));
  }

  /**
   * Creates a password for an app account, on the Mitra auth page in a popup:
   * the page asks for the address, sends a code to it to prove the mailbox is
   * the person's, and takes the password with that code. The person ends signed
   * in, as with {@link signInWithPassword}.
   *
   * @returns The authenticated and hydrated user.
   * @throws The same errors as {@link signInWithPassword}.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.signUpWithPassword();
   * ```
   */
  async signUpWithPassword(): Promise<User> {
    return this.establishSession(await this.passwordAuth.signInWithPopup({ view: 'signup' }));
  }

  /**
   * Changes the password of the signed-in person, on the Mitra auth page in a
   * popup. The page asks for the current and the new password itself, so the
   * app never sees either one.
   *
   * The page acts on this session, so it asks for the access token once it
   * loads, and the SDK answers with `postMessage` to the auth page origin only:
   * the token never goes in the popup URL.
   *
   * IAM ends every session of the account when the password changes, this one
   * included, so the page signs in again with the new password and hands back a
   * new session, which replaces the current one.
   *
   * When the change goes through but that new sign-in fails, the call rejects
   * with `PASSWORD_CHANGED_SIGN_IN_AGAIN` and the local session is cleared,
   * since IAM already ended it: send the person to sign in with the new password.
   *
   * @returns The user of the new session.
   * @throws {MitraApiError} `401` when nobody is signed in, and
   * `PASSWORD_CHANGED_SIGN_IN_AGAIN` (status `401`) as above.
   * @throws The same errors as {@link signInWithPassword}, and an error when the
   * session ends while the popup is open.
   *
   * @example
   * ```typescript
   * await mitra.auth.changePassword();
   * ```
   */
  async changePassword(): Promise<User> {
    if (!this.#accessToken) {
      throw new MitraApiError('Sign in before changing the password.', 401);
    }
    // Read when the page asks, not now: the popup has to open within the click,
    // and the token may be renewed while the person types.
    const sessionToken = async () => {
      await this.ensureFreshSession();
      return this.#accessToken;
    };
    const generation = this.sessionGeneration;
    let tokenResponse: AuthTokenResponse;
    try {
      tokenResponse = await this.passwordAuth.signInWithPopup({ view: 'change', sessionToken });
    } catch (error) {
      // A session that replaced this one meanwhile is not the one IAM ended.
      if (
        error instanceof MitraApiError
        && error.code === PASSWORD_CHANGED_SIGN_IN_AGAIN
        && generation === this.sessionGeneration
      ) {
        this.clearAuthState();
      }
      throw error;
    }
    return this.establishSession(tokenResponse);
  }

  /**
   * Asks IAM to email a link to set a new password. Only the address goes.
   * Where the link opens depends on the app's mode of the password login: with
   * the Mitra auth page, the default, the new password is typed there; with the
   * form in the app itself, the link opens `/reset-password` on this app's
   * origin, which reads it with {@link readPasswordResetToken} and finishes
   * with {@link confirmPasswordReset}.
   *
   * IAM answers the same whether or not the address has an account, so this
   * resolves without saying which.
   *
   * @param email - The address of the account.
   * @param options - The language of the message.
   * @returns How long the application should wait before offering to resend.
   * @throws {MitraApiError} `RATE_LIMITED` when this address asked too often,
   * and `RATE_LIMIT_EXCEEDED` when this network did, both with
   * `retryAfterSeconds` when IAM sends it.
   *
   * @example
   * ```typescript
   * const { resendAfterSeconds } = await mitra.auth.requestPasswordReset('person@example.com');
   * ```
   */
  async requestPasswordReset(
    email: string,
    options: PasswordResetOptions = {}
  ): Promise<PasswordResetRequestResult> {
    if (globalThis.window === undefined) {
      throw new Error('Password reset is only available in a browser.');
    }
    const browserWindow = globalThis.window;
    return expectPasswordResetRequestResult(
      await this.publicClient.post<unknown>(PASSWORD_RESET_PATH, {
        email,
        appId: this.appId,
        origin: browserWindow.location.origin,
        language: resolveLanguage(options.language, browserWindow),
      })
    );
  }

  /**
   * The password goes through the app's code. Do not store it, do not log it
   * and do not send it anywhere other than this method. The safer default is
   * signInWithPassword(), which uses the Mitra auth page.
   *
   * Works only when the app has the "form in the app itself" mode of the
   * password login turned on. Otherwise IAM refuses it with
   * `PASSWORD_FORM_NOT_ENABLED` (status `403`). Browser only.
   *
   * Signs in with the address and password typed into the app's own form.
   *
   * @returns The authenticated and hydrated user.
   * @throws {MitraApiError} `INVALID_CREDENTIALS` (status `401`) for a wrong
   * address or password, a locked account or one without a password, all
   * answered alike, `SIGNUP_NOT_ALLOWED` (status `403`) when the account lost
   * its access to an app that takes no new accounts, `RATE_LIMIT_EXCEEDED`
   * (status `429`, with `retryAfterSeconds` when IAM sends it) when this
   * network called the password routes too often or IAM is at its limit of
   * passwords being hashed, so wait `retryAfterSeconds`, and
   * `PASSWORD_FORM_NOT_ENABLED` as above.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.signInWithPasswordForm({ email, password });
   * ```
   */
  async signInWithPasswordForm(credentials: SignInCredentials): Promise<User> {
    return this.establishSession(await this.passwordForm.signIn(credentials));
  }

  /**
   * The password goes through the app's code. Do not store it, do not log it
   * and do not send it anywhere other than this method. The safer default is
   * signInWithPassword(), which uses the Mitra auth page.
   *
   * First step of creating a password from the app's own form: IAM emails a
   * six-digit code to the address, to prove the mailbox is the person's. No
   * password goes in this step, which IAM takes in either mode of the app; the
   * "form in the app itself" mode is required at {@link completePasswordSignUp},
   * where the password goes. Browser only.
   *
   * IAM answers the same whether or not the address has an account, so this
   * resolves without saying which.
   *
   * @param request - The address, and the language of the message.
   * @returns The receipt that names this request, and the resend delay.
   * @throws {MitraApiError} `RATE_LIMITED` (with `retryAfterSeconds`) when this
   * address asked too often, and `RATE_LIMIT_EXCEEDED` (status `429`, with
   * `retryAfterSeconds` when IAM sends it) when this network called the
   * password routes too often.
   *
   * @example
   * ```typescript
   * const { receipt, resendAfterSeconds } = await mitra.auth.startPasswordSignUp({ email });
   * ```
   */
  async startPasswordSignUp(request: PasswordSignUpRequest): Promise<PasswordSignUpRequestResult> {
    return this.passwordForm.startSignUp(request);
  }

  /**
   * The password goes through the app's code. Do not store it, do not log it
   * and do not send it anywhere other than this method. The safer default is
   * signInWithPassword(), which uses the Mitra auth page.
   *
   * Works only when the app has the "form in the app itself" mode of the
   * password login turned on. Otherwise IAM refuses it with
   * `PASSWORD_FORM_NOT_ENABLED` (status `403`). Browser only.
   *
   * Second step of {@link startPasswordSignUp}: the code from the message and
   * the chosen password. The person ends signed in, as with
   * {@link signInWithPasswordForm}.
   *
   * @param completion - The receipt, the code and the password.
   * @returns The authenticated and hydrated user.
   * @throws {MitraApiError} `INVALID_CODE` when the code does not match or the
   * request expired, `MAGIC_LINK_USED` when it was already completed,
   * `PASSWORD_ALREADY_SET` when the account has a password (the way to replace
   * it is the reset), `SSO_ACCOUNT` (status `409`) when the account signs in
   * with Google or Microsoft, `SIGNUP_NOT_ALLOWED` when the app takes no new
   * accounts, `WEAK_PASSWORD` (status `400`) with the rule the password broke,
   * `RATE_LIMIT_EXCEEDED` (status `429`, with `retryAfterSeconds` when IAM
   * sends it) when this network called the password routes too often or IAM is
   * at its limit of passwords being hashed, so wait `retryAfterSeconds`, and
   * `PASSWORD_FORM_NOT_ENABLED` as above.
   *
   * @example
   * ```typescript
   * const user = await mitra.auth.completePasswordSignUp({ receipt, code, password });
   * ```
   */
  async completePasswordSignUp(completion: PasswordSignUpCompletion): Promise<User> {
    return this.establishSession(await this.passwordForm.completeSignUp(completion));
  }

  /**
   * The password goes through the app's code. Do not store it, do not log it
   * and do not send it anywhere other than this method. The safer default is
   * signInWithPassword(), which uses the Mitra auth page.
   *
   * Works only when the app has the "form in the app itself" mode of the
   * password login turned on. Otherwise IAM refuses it with
   * `PASSWORD_FORM_NOT_ENABLED` (status `403`). Browser only.
   *
   * Changes the password of the signed-in person from the app's own form. IAM
   * ends every session of the account when the password changes, this one
   * included, so the SDK signs in again with the address of this session and
   * the new password, and that session replaces the current one.
   *
   * When the change goes through but that new sign-in fails, the call rejects
   * with `PASSWORD_CHANGED_SIGN_IN_AGAIN` and the local session is cleared,
   * since IAM already ended it: send the person to sign in with the new password.
   *
   * @param change - The current password, required whenever the account
   * already has one, and the new one.
   * @returns The user of the new session.
   * @throws {MitraApiError} `401` when nobody is signed in,
   * `PASSWORD_CHANGED_SIGN_IN_AGAIN` (status `401`) as above,
   * `INVALID_CREDENTIALS` (status `401`) for a wrong current password,
   * `CURRENT_PASSWORD_REQUIRED` and `WEAK_PASSWORD` (status `400`),
   * `SSO_ACCOUNT` (status `409`) when the account signs in with Google or
   * Microsoft, `RATE_LIMIT_EXCEEDED` (status `429`, with `retryAfterSeconds`
   * when IAM sends it) when this network called the password routes too often
   * or IAM is at its limit of passwords being hashed, so wait
   * `retryAfterSeconds`, and `PASSWORD_FORM_NOT_ENABLED` as above.
   *
   * @example
   * ```typescript
   * await mitra.auth.changePasswordForm({ currentPassword, newPassword });
   * ```
   */
  async changePasswordForm(change: PasswordChange): Promise<User> {
    if (!this.#accessToken) {
      throw new MitraApiError('Sign in before changing the password.', 401);
    }
    // Read before the change: once IAM ends the sessions, this one may no longer be able to ask for it.
    const email = this._currentUser?.email ?? (await this.getCurrentUser()).email;
    await this.ensureFreshSession();
    const accessToken = this.#accessToken;
    if (!accessToken) {
      throw new MitraApiError('Sign in before changing the password.', 401);
    }
    const generation = this.sessionGeneration;
    await this.passwordForm.changePassword(change, accessToken);

    try {
      return await this.signInWithPasswordForm({ email, password: change.newPassword });
    } catch (error) {
      // A session that replaced this one meanwhile is not the one IAM ended.
      if (generation === this.sessionGeneration) {
        this.clearAuthState();
      }
      throw passwordChangedSignInAgain(error);
    }
  }

  /**
   * The password goes through the app's code. Do not store it, do not log it
   * and do not send it anywhere other than this method. The safer default is
   * signInWithPassword(), which uses the Mitra auth page.
   *
   * The reset token is single use and works as a credential until it is spent:
   * do not log it either.
   *
   * Reads the token of a password reset link that landed on this app, and
   * removes the fragment from the URL so the token does not stay in the
   * history. With the form in the app itself turned on, IAM sends the link to
   * `/reset-password#resetToken=...` on the origin the reset was asked from:
   * call this when that route loads, then {@link confirmPasswordReset}.
   *
   * Nothing is sent to IAM here, and a URL without the link is left as it is.
   * Browser only.
   *
   * @returns The token, or `null` when the URL carries none.
   *
   * @example
   * ```typescript
   * const token = mitra.auth.readPasswordResetToken();
   * ```
   */
  readPasswordResetToken(): string | null {
    return this.passwordForm.readResetToken();
  }

  /**
   * The password goes through the app's code. Do not store it, do not log it
   * and do not send it anywhere other than this method. The safer default is
   * signInWithPassword(), which uses the Mitra auth page.
   *
   * Works only when the app has the "form in the app itself" mode of the
   * password login turned on. Otherwise IAM refuses it with
   * `PASSWORD_FORM_NOT_ENABLED` (status `403`). Browser only.
   *
   * Sets the new password with the token from the reset link. The link is
   * single use, and IAM ends every session of the account, so the person signs
   * in afterwards with the new password; this method signs nobody in.
   *
   * @param confirmation - The token from {@link readPasswordResetToken} and the
   * new password.
   * @throws {MitraApiError} `RESET_TOKEN_USED` or `RESET_TOKEN_EXPIRED` (status
   * `409`) when the link can no longer be used; a token IAM does not know also
   * answers `RESET_TOKEN_EXPIRED`. Also `WEAK_PASSWORD` (status `400`),
   * `SSO_ACCOUNT` (status `409`) when the account signs in with Google or
   * Microsoft, `RATE_LIMIT_EXCEEDED` (status `429`, with `retryAfterSeconds`
   * when IAM sends it) when this network called the password routes too often
   * or IAM is at its limit of passwords being hashed, so wait
   * `retryAfterSeconds`, and `PASSWORD_FORM_NOT_ENABLED` as above.
   *
   * @example
   * ```typescript
   * await mitra.auth.confirmPasswordReset({ token, newPassword });
   * ```
   */
  async confirmPasswordReset(confirmation: PasswordResetConfirmation): Promise<void> {
    return this.passwordForm.confirmReset(confirmation);
  }

  /**
   * Signs out the current user, clearing all auth state and the stored session.
   *
   * In an app whose accounts are its own, the session also ends on the server:
   * the refresh token is sent to IAM's logout, so it can no longer be renewed.
   * The local state is cleared right away whatever IAM answers, and the request
   * survives a navigation to `redirectUrl`. The access token already issued
   * stays valid until it expires.
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
    const refreshToken = this.#refreshToken;
    this.clearAuthState();
    if (refreshToken && isExclusiveAppSession(refreshToken)) {
      this.endServerSession(refreshToken);
    }

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
   * Call `me()` afterwards to fetch the associated user data. {@link allTokens}
   * goes back to `null`, because it belongs to the session being replaced.
   * The token starts a session of its own, so it is kept in `localStorage`
   * even when the one it replaces lived in its tab, and that tab copy is
   * removed in any case.
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
    // A token set by hand is a new session, not the identity connection's one,
    // and the tab copy of that one would come back on the next reload.
    this.sessionScoped = false;
    removeItem(sessionStorageOrNull(), this.storageKey);
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
   * {@link allTokens} goes back to `null`, because it belongs to the session
   * being replaced.
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
   * The backoffice token of {@link allTokens}, renewed when it is close to
   * expiring.
   *
   * Renewing it means refreshing the app session, which this method does when
   * the token is within `minValidityMs` of its expiry. Call it before each
   * backoffice request: refreshes are shared with every other caller, so it
   * costs one request per expiry, not one per call. The expiry is read from the
   * JWT as a scheduling heuristic, the same as {@link ensureFreshSession}, so a
   * token whose `exp` cannot be read is used as it is.
   *
   * @param minValidityMs - Minimum remaining token lifetime. Defaults to 60 seconds.
   * @returns The token to use, or `null` when this session has none, when the
   * refresh reports the grant is gone, or when another person signed in while
   * the refresh was in flight. A refresh that fails transiently keeps the
   * session, so the token in hand is returned and the receiving service decides.
   *
   * @example
   * ```typescript
   * const backoffice = await mitra.auth.ensureFreshBackofficeToken();
   * if (!backoffice) return renderWithoutAdminArea();
   * const authorization = `${backoffice.tokenType} ${backoffice.accessToken}`;
   * await fetch(url, { headers: { Authorization: authorization } });
   * ```
   */
  async ensureFreshBackofficeToken(
    minValidityMs: number = DEFAULT_BACKOFFICE_TOKEN_VALIDITY_MS
  ): Promise<BackofficeToken | null> {
    if (!Number.isFinite(minValidityMs) || minValidityMs < 0) {
      throw new RangeError('minValidityMs must be a finite non-negative number');
    }
    const current = this.#allTokens?.backoffice ?? null;
    if (!current) return null;
    if (!isTokenExpiring(current.accessToken, minValidityMs)) return current;

    // Another person can sign in to this app while the refresh is in flight;
    // answering then would hand their grant to whoever asked for the first.
    const generation = this.sessionGeneration;
    await this.refreshSession();
    if (generation !== this.sessionGeneration) return null;
    return this.#allTokens?.backoffice ?? null;
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
   * legacy SDK does not return one; call `me()` to hydrate it. It is a new
   * session, so the extra login tokens of the previous one are dropped.
   *
   * @param session - Access token and, when the issuer returned one, refresh token.
   *
   * @internal
   */
  private adoptSession(session: { token: string; refreshToken?: string | null }): boolean {
    return this.applySession(session, { keepAllTokens: false, replacesSession: true });
  }

  /**
   * Stores tokens another issuer rotated for the session already in place, such
   * as a silent refresh performed by the legacy SDK. The extra login tokens are
   * kept only when the rotated token belongs to the same person.
   *
   * @internal
   */
  private rotateSession(session: { token: string; refreshToken?: string | null }): boolean {
    // A legacy refresh started for one person can land after another person
    // signed in to the same app; keeping allTokens then would mix the two.
    return this.applySession(session, {
      keepAllTokens: this.isSamePerson(session.token),
      replacesSession: false,
    });
  }

  private isSamePerson(token: string): boolean {
    const current = this.#accessToken ? subjectOf(this.#accessToken) : null;
    return current !== null && current === subjectOf(token);
  }

  private applySession(
    session: { token: string; refreshToken?: string | null },
    { keepAllTokens, replacesSession }: { keepAllTokens: boolean; replacesSession: boolean }
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
    // An adopted session is not the identity connection's one, so it goes to
    // the shared storage; a rotation renews the session in place, wherever it is.
    if (replacesSession) this.sessionScoped = false;
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

  /** Best effort: the person asked to leave, and that already happened locally. */
  private endServerSession(refreshToken: string): void {
    this.publicClient
      .request<unknown>(LOGOUT_PATH, { method: 'POST', body: { refreshToken }, keepalive: true })
      .catch(() => undefined);
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

  private async establishSession(
    tokenResponse: AuthTokenResponse,
    sessionScoped: boolean = false
  ): Promise<User> {
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
    this.sessionScoped = sessionScoped;

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

  private clearAuthState({ keepStorage = false }: { keepStorage?: boolean } = {}): void {
    const hadAuthState = this._currentUser !== null
      || this.#accessToken !== null
      || this.#refreshToken !== null;
    this.invalidatePendingRefreshes();
    this._currentUser = null;
    this.#accessToken = null;
    this.#refreshToken = null;
    this.#allTokens = null;
    if (!keepStorage) this.removeFromStorage();
    this.sessionScoped = false;
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

  /**
   * The brand IAM needs to brand the message. It arrives with the app info, so
   * asking before `init()` is a configuration mistake rather than something to
   * guess a default for: the wrong brand sends the wrong message.
   */
  private requireBrand(): string {
    if (!this.brand) {
      throw coreErrors.configuration(
        'Email sign-in needs the app info resolved by init(). Call init() before requestEmailCode().'
      );
    }
    return this.brand;
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
    const target = this.sessionScoped ? sessionStorageOrNull() : localStorageOrNull();
    if (!target) return;

    try {
      target.setItem(
        this.storageKey,
        JSON.stringify({
          user: this._currentUser,
          token: this.#accessToken,
          refreshToken: this.#refreshToken,
          // Persisted with the session on purpose: IAM issues mitraSpace and
          // b2bToken only at login, so keeping them in memory alone would lose
          // them on the first reload.
          ...(this.#allTokens ? { allTokens: this.#allTokens } : {}),
        })
      );
    } catch {
      // Storage might be full or disabled
      return;
    }
    // A tab session left behind would win over this one on the next reload.
    // The other way round the shared copy stays: it belongs to the other tabs
    // of this app, signed in their usual way.
    if (!this.sessionScoped) removeItem(sessionStorageOrNull(), this.storageKey);
  }

  private loadFromStorage(): void {
    // The tab's own session wins over the one every tab shares.
    if (this.restoreFrom(sessionStorageOrNull(), true)) return;
    this.restoreFrom(localStorageOrNull(), false);
  }

  /**
   * Restores the session kept in one storage, reporting whether it did. An
   * unusable entry is removed from that storage only, so a broken tab session
   * does not take the shared one with it.
   */
  private restoreFrom(storage: Storage | null, sessionScoped: boolean): boolean {
    const stored = readItem(storage, this.storageKey);
    if (!stored) return false;

    try {
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
        removeItem(storage, this.storageKey);
        return false;
      }
      this._currentUser = user;
      this.#accessToken = token;
      this.#refreshToken = refreshToken ?? null;
      this.#allTokens = discardEmptyAllTokens(normalizeAllTokens(allTokens));
      this.sessionScoped = sessionScoped;
      this.invalidatePendingRefreshes();
      return true;
    } catch {
      removeItem(storage, this.storageKey);
      return false;
    }
  }

  private removeFromStorage(): void {
    // Ending a tab session leaves the shared one to the tabs it belongs to.
    removeItem(sessionStorageOrNull(), this.storageKey);
    if (!this.sessionScoped) removeItem(localStorageOrNull(), this.storageKey);
  }
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readItem(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function removeItem(storage: Storage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Storage might be disabled
  }
}
