import { stripTrailingSlashes } from '../utils/url';
import { expectObject } from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import type { HttpClient } from '../utils/http-client';
import { resolveAuthPageUrl } from './auth-page-url';
import type { AuthPageSignInOptions, AuthTokenResponse } from './auth.types';

const RESULT_TYPE = 'mitra-oauth-result';

export type AuthPageProvider = 'google' | 'microsoft' | 'email';

interface AuthPageProviderProfile {
  /** Name of the provider in errors handed to the application. */
  label: string;
  /** IAM route that turns the single-use code into an app session. */
  exchangePath: string;
  /** Whether the exchange binds the code to the auth page that received it. */
  sendsRedirectUri: boolean;
  /** Where the pending request lives between the start of the flow and its completion. */
  redirectStorage: 'sessionStorage' | 'localStorage';
  /**
   * How long a pending request stays acceptable. Its presence is what says this
   * flow can also be finished in another tab: the message the platform emails
   * carries a link, that link opens a tab which never saw the popup this SDK
   * opened, so the request is written even for a popup and expires on its own.
   * Absent means the flow is finished only by the tab that started it, and the
   * pending request lives exactly as long as that tab does.
   */
  pendingRequestTtlMs?: number;
  /**
   * How long the popup may stay open before the sign-in is given up. The SSO
   * consent screen is over in a minute; the email code has to be read from a
   * mailbox first, and the challenge behind it lives for ten minutes.
   */
  popupTimeoutMs: number;
}

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const TEN_MINUTES_MS = 10 * 60 * 1_000;

const PROVIDERS: Record<AuthPageProvider, AuthPageProviderProfile> = {
  google: {
    label: 'Google',
    exchangePath: '/api/v1/auth/google',
    sendsRedirectUri: true,
    redirectStorage: 'sessionStorage',
    popupTimeoutMs: FIVE_MINUTES_MS,
  },
  microsoft: {
    label: 'Microsoft',
    exchangePath: '/api/v1/auth/microsoft',
    sendsRedirectUri: true,
    redirectStorage: 'sessionStorage',
    popupTimeoutMs: FIVE_MINUTES_MS,
  },
  email: {
    label: 'Email',
    exchangePath: '/api/v1/auth/magic-link/exchange',
    sendsRedirectUri: false,
    redirectStorage: 'localStorage',
    pendingRequestTtlMs: TEN_MINUTES_MS,
    popupTimeoutMs: TEN_MINUTES_MS,
  },
};
const POPUP_WIDTH = 480;
const POPUP_HEIGHT = 600;
const POPUP_CLOSED_POLL_MS = 500;

interface AuthPageFlowConfig {
  appId: string;
  apiUrl: string;
  authPageUrl?: string;
  client: HttpClient;
  /** Which provider the auth page starts. Defaults to Google. */
  provider?: AuthPageProvider;
}

interface RedirectContext {
  state: string;
  redirectUri: string;
  createdAt: number;
}

type MitraWindow = Window & { __mitraEnv?: { authPageUrl?: unknown } };

export function expectAuthTokenResponse(value: unknown): AuthTokenResponse {
  const response = expectObject<Record<string, unknown>>(
    value,
    'Authentication token response',
    coreErrors
  );

  for (const field of ['accessToken', 'refreshToken', 'tokenType'] as const) {
    if (typeof response[field] !== 'string' || !response[field].trim()) {
      throw coreErrors.invalidResponse(
        `Authentication token response has an invalid ${field} field`
      );
    }
  }

  return {
    accessToken: response.accessToken as string,
    refreshToken: response.refreshToken as string,
    tokenType: response.tokenType as string,
  };
}

/** Coordinates the browser-only handshake through the brand auth page (Google, Microsoft, or email) and returns IAM tokens. */
export class AuthPageFlow {
  private readonly appId: string;
  private readonly apiUrl: string;
  private readonly configuredAuthPageUrl?: string;
  private readonly client: HttpClient;
  private readonly provider: AuthPageProvider;
  private readonly profile: AuthPageProviderProfile;
  private readonly providerLabel: string;
  private readonly redirectStorageKey: string;
  private popupPromise: Promise<AuthTokenResponse> | null = null;

  constructor(config: AuthPageFlowConfig) {
    this.appId = config.appId;
    this.apiUrl = stripTrailingSlashes(config.apiUrl);
    this.configuredAuthPageUrl = config.authPageUrl;
    this.client = config.client;
    this.provider = config.provider ?? 'google';
    this.profile = PROVIDERS[this.provider];
    this.providerLabel = this.profile.label;
    this.redirectStorageKey = `mitra_${this.provider}_redirect_${config.appId}`;
  }

  signIn(options: AuthPageSignInOptions = {}): Promise<AuthTokenResponse> {
    const browserWindow = this.requireBrowser();

    if (options.mode === 'redirect') {
      return this.startRedirect(browserWindow);
    }

    if (options.mode !== undefined && options.mode !== 'popup') {
      return Promise.reject(new Error(`Unsupported ${this.providerLabel} sign-in mode: ${String(options.mode)}`));
    }

    if (this.popupPromise) return this.popupPromise;

    this.popupPromise = this.startPopup(browserWindow).finally(() => {
      this.popupPromise = null;
    });
    return this.popupPromise;
  }

  /**
   * Finishes a redirect this provider started, or returns `null` when the URL
   * carries no result or carries one that belongs to another provider's flow.
   *
   * The state generated at the start of every flow is prefixed with the provider
   * name, and the auth page echoes it verbatim, so a fragment identifies its own
   * flow. An application that offers several methods can call every completion
   * at startup, in any order, even while other methods have requests pending.
   *
   * A fragment of this flow is always consumed, including when it cannot be
   * completed, so a failure is reported once instead of on every reload. A
   * fragment of another flow is left exactly as it was found.
   */
  async completeRedirect(): Promise<AuthTokenResponse | null> {
    const browserWindow = this.requireBrowser();
    const params = new URLSearchParams(browserWindow.location.hash.replace(/^#/, ''));
    const code = params.get('codeMitra');
    const state = params.get('stateMitra');
    const error = params.get('errorMitra');

    if (code === null && state === null && error === null) return null;

    const context = this.readRedirectContext(browserWindow);
    // One fragment belongs to one flow, and the state says which one. A fragment
    // from another method is left untouched for its owner rather than reported as
    // forged, so every completion can run at startup whatever is pending.
    const hasState = state !== null && state.trim() !== '';
    if (hasState && !this.ownsState(state)) return null;
    if (!hasState && !context) return null;

    if (!hasState) {
      throw this.discardOwnRedirect(
        browserWindow,
        `${this.providerLabel} sign-in redirect is missing state.`
      );
    }
    if (context && this.hasExpired(context)) {
      this.clearRedirectContext(browserWindow);
      throw this.discardOwnRedirect(
        browserWindow,
        `${this.providerLabel} sign-in request expired before it was completed.`
      );
    }
    if (context?.state !== state) {
      throw this.discardOwnRedirect(
        browserWindow,
        `Invalid ${this.providerLabel} sign-in state (possible CSRF).`
      );
    }

    const expectedRedirectUri = this.getRedirectUri(
      resolveAuthPageUrl(this.apiUrl, this.configuredAuthPageUrl, browserWindow)
    );
    if (context.redirectUri !== expectedRedirectUri) {
      throw this.discardOwnRedirect(
        browserWindow,
        `${this.providerLabel} sign-in redirect context is invalid.`
      );
    }

    this.cleanRedirectFragment(browserWindow);
    this.clearRedirectContext(browserWindow);

    if (code === 'error' || error !== null) {
      throw new Error(error || `${this.providerLabel} sign-in failed.`);
    }
    if (!code?.trim()) {
      throw new Error(`${this.providerLabel} sign-in redirect is missing code.`);
    }

    return this.exchangeCode(code, context.redirectUri);
  }

  private async startPopup(browserWindow: MitraWindow): Promise<AuthTokenResponse> {
    const state = this.generateState();
    const authPageUrl = resolveAuthPageUrl(
      this.apiUrl,
      this.configuredAuthPageUrl,
      browserWindow
    );
    // A popup started here can still be finished in the tab the link opens, which
    // has no memory of this one, so the request is written down before it opens.
    // Best effort: without storage the popup itself still works, only that other
    // tab loses the way to finish the flow.
    const completedInAnotherTab = this.profile.pendingRequestTtlMs !== undefined;
    if (completedInAnotherTab) {
      this.writeRedirectContext(
        browserWindow,
        this.newRedirectContext(state, this.getRedirectUri(authPageUrl))
      );
    }
    const popup = this.openPopup(browserWindow, this.buildStartUrl(browserWindow, authPageUrl, state));
    const result = await this.waitForPopupResult(browserWindow, popup, authPageUrl.origin, state);
    if (completedInAnotherTab) this.clearRedirectContext(browserWindow);

    if (result.code) return this.exchangeCode(result.code, this.getRedirectUri(authPageUrl));

    return expectAuthTokenResponse(result.token);
  }

  private startRedirect(browserWindow: MitraWindow): Promise<never> {
    const state = this.generateState();
    const authPageUrl = resolveAuthPageUrl(
      this.apiUrl,
      this.configuredAuthPageUrl,
      browserWindow
    );

    const context = this.newRedirectContext(state, this.getRedirectUri(authPageUrl));
    if (!this.writeRedirectContext(browserWindow, context)) {
      throw new Error(
        `${this.providerLabel} sign-in redirect requires ${this.profile.redirectStorage}.`
      );
    }
    const startUrl = this.buildStartUrl(browserWindow, authPageUrl, state);
    browserWindow.location.assign(startUrl.toString());

    return new Promise<never>(() => undefined);
  }

  /**
   * A one-time state for a request that is finished somewhere other than here:
   * the tab a link in a message opens, or a code typed into the application
   * itself. Generating it changes nothing, so a request that is never accepted
   * leaves the one pending here alone.
   *
   * @internal
   */
  newRequestState(): string {
    this.requireBrowser();
    return this.generateState();
  }

  /**
   * Writes down a request whoever finishes it will need, replacing the one
   * pending here.
   *
   * Writing it is best effort. Without storage only the completion from the link
   * is lost, and the code typed into the application still finishes the sign-in.
   *
   * @internal
   */
  rememberPendingRequest(state: string, redirectUri: string): void {
    const browserWindow = this.requireBrowser();
    this.writeRedirectContext(browserWindow, this.newRedirectContext(state, redirectUri));
  }

  /**
   * The one-time state of the request pending in this browser, or `null` when
   * there is none or it is too old to be finished.
   *
   * @internal
   */
  pendingRequestState(): string | null {
    const context = this.readRedirectContext(this.requireBrowser());
    if (!context || this.hasExpired(context)) return null;
    return context.state;
  }

  /** @internal */
  discardPendingRequest(): void {
    this.clearRedirectContext(this.requireBrowser());
  }

  /**
   * Redeems a single-use exchange code for an app session, through the same IAM
   * route this provider's auth page handshake uses. For a provider that binds
   * the code to the page that received it, use that handshake instead: this one
   * has no page to name.
   *
   * @internal
   */
  redeemExchangeCode(code: string): Promise<AuthTokenResponse> {
    return this.exchangeCode(code, null);
  }

  private async exchangeCode(
    code: string,
    redirectUri: string | null
  ): Promise<AuthTokenResponse> {
    const response = await this.client.post<unknown>(this.profile.exchangePath, {
      appId: this.appId,
      code,
      ...(this.profile.sendsRedirectUri && redirectUri !== null ? { redirectUri } : {}),
    });

    return expectAuthTokenResponse(response);
  }

  private buildStartUrl(
    browserWindow: MitraWindow,
    authPageUrl: URL,
    state: string
  ): URL {
    const startUrl = new URL(authPageUrl);
    startUrl.searchParams.set('provider', this.provider);
    startUrl.searchParams.set('state', state);
    startUrl.searchParams.set('appId', this.appId);
    startUrl.searchParams.set('apiUrl', this.apiUrl);
    startUrl.searchParams.set('origin', browserWindow.location.origin);
    startUrl.searchParams.set('responseType', 'code');
    return startUrl;
  }

  private getRedirectUri(authPageUrl: URL): string {
    return `${authPageUrl.origin}${authPageUrl.pathname}`;
  }

  private newRedirectContext(state: string, redirectUri: string): RedirectContext {
    return {
      state,
      redirectUri,
      createdAt: Date.now(),
    };
  }

  /**
   * Reports a fragment of this flow that cannot be completed, dropping it from the
   * URL first. Nobody else claims a fragment that names this flow, so leaving it
   * there would make the application fail again on every reload.
   */
  private discardOwnRedirect(browserWindow: MitraWindow, message: string): Error {
    this.cleanRedirectFragment(browserWindow);
    return new Error(message);
  }

  /** Whether a state echoed by the auth page was generated by this provider's flow. */
  private ownsState(state: string): boolean {
    return state.startsWith(`${this.provider}.`);
  }

  private hasExpired(context: RedirectContext): boolean {
    const ttlMs = this.profile.pendingRequestTtlMs;
    if (ttlMs === undefined) return false;
    if (!Number.isFinite(context.createdAt)) return true;
    return Date.now() - context.createdAt > ttlMs;
  }

  /** A one-time state that names the flow that created it, so its fragment is recognizable. */
  private generateState(): string {
    if (!globalThis.crypto?.getRandomValues) {
      throw new Error(`${this.providerLabel} sign-in requires crypto.getRandomValues.`);
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${this.provider}.${random}`;
  }

  private openPopup(browserWindow: MitraWindow, url: URL): Window {
    const outerWidth = browserWindow.outerWidth || browserWindow.screen.width;
    const outerHeight = browserWindow.outerHeight || browserWindow.screen.height;
    const left = Math.max(0, (browserWindow.screenX || 0) + (outerWidth - POPUP_WIDTH) / 2);
    const top = Math.max(0, (browserWindow.screenY || 0) + (outerHeight - POPUP_HEIGHT) / 2);
    const popup = browserWindow.open(
      url.toString(),
      `mitra-${this.provider}-auth`,
      `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},menubar=no,toolbar=no,status=no`
    );
    if (!popup) {
      throw new Error(`${this.providerLabel} sign-in popup was blocked by the browser.`);
    }
    return popup;
  }

  private waitForPopupResult(
    browserWindow: MitraWindow,
    popup: Window,
    expectedOrigin: string,
    expectedState: string
  ): Promise<{ code?: string; token?: unknown }> {
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        cleanup();
        reject(new Error(`${this.providerLabel} sign-in timed out.`));
      }, this.profile.popupTimeoutMs);
      const closedPoll = globalThis.setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject(new Error(`${this.providerLabel} sign-in was cancelled.`));
        }
      }, POPUP_CLOSED_POLL_MS);

      const onMessage = (event: MessageEvent<unknown>) => {
        if (event.origin !== expectedOrigin || event.source !== popup) return;
        if (!event.data || typeof event.data !== 'object') return;

        const data = event.data as Record<string, unknown>;
        if (data.type !== RESULT_TYPE) return;
        if (data.state !== expectedState) {
          cleanup();
          reject(new Error(`Invalid ${this.providerLabel} sign-in state (possible CSRF).`));
          return;
        }
        if (data.success !== true) {
          cleanup();
          reject(new Error(typeof data.error === 'string' && data.error.trim()
            ? data.error
            : `${this.providerLabel} sign-in failed.`));
          return;
        }

        const code = typeof data.code === 'string' && data.code.trim() ? data.code : undefined;
        if (!code && data.token === undefined) {
          cleanup();
          reject(new Error(`${this.providerLabel} auth page returned neither code nor token.`));
          return;
        }

        cleanup();
        resolve({ ...(code ? { code } : {}), ...(data.token !== undefined ? { token: data.token } : {}) });
      };

      const cleanup = () => {
        globalThis.clearTimeout(timeout);
        globalThis.clearInterval(closedPoll);
        browserWindow.removeEventListener('message', onMessage);
        if (!popup.closed) popup.close();
      };

      browserWindow.addEventListener('message', onMessage);
    });
  }

  /** Writes the pending request, reporting whether storage accepted it. */
  private writeRedirectContext(browserWindow: MitraWindow, context: RedirectContext): boolean {
    try {
      browserWindow[this.profile.redirectStorage].setItem(
        this.redirectStorageKey,
        JSON.stringify(context)
      );
      return true;
    } catch {
      return false;
    }
  }

  private readRedirectContext(browserWindow: MitraWindow): RedirectContext | null {
    try {
      const raw = browserWindow[this.profile.redirectStorage].getItem(this.redirectStorageKey);
      if (!raw) return null;
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (typeof value.state !== 'string' || typeof value.redirectUri !== 'string') return null;
      return {
        state: value.state,
        redirectUri: value.redirectUri,
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : Number.NaN,
      };
    } catch {
      return null;
    }
  }

  private clearRedirectContext(browserWindow: MitraWindow): void {
    try {
      browserWindow[this.profile.redirectStorage].removeItem(this.redirectStorageKey);
    } catch {
      // The context is already unusable when storage is unavailable.
    }
  }

  private cleanRedirectFragment(browserWindow: MitraWindow): void {
    browserWindow.history.replaceState(
      {},
      '',
      `${browserWindow.location.pathname}${browserWindow.location.search}`
    );
  }

  private requireBrowser(): MitraWindow {
    if (globalThis.window === undefined) {
      throw new Error(`${this.providerLabel} sign-in is only available in a browser.`);
    }
    return globalThis.window as MitraWindow;
  }
}
