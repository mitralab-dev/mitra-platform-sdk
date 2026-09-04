import { stripTrailingSlashes } from '../utils/url';
import { expectObject } from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import type { HttpClient } from '../utils/http-client';
import { resolveAuthPageUrl } from './auth-page-url';
import type {
  AllTokens,
  AuthTokenResponse,
  GoogleSignInOptions,
  MitraSpaceToken,
  PlatformSessionTokens,
} from './auth.types';

const RESULT_TYPE = 'mitra-oauth-result';

export type AuthPageProvider = 'google' | 'microsoft';

const PROVIDER_LABELS: Record<AuthPageProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};
const POPUP_WIDTH = 480;
const POPUP_HEIGHT = 600;
const POPUP_TIMEOUT_MS = 5 * 60 * 1_000;
const POPUP_CLOSED_POLL_MS = 500;

interface GoogleAuthFlowConfig {
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
}

type MitraWindow = Window & { __mitraEnv?: { authPageUrl?: unknown } };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function readPlatformTokens(value: unknown): PlatformSessionTokens | null {
  if (!isPlainObject(value)) return null;
  const { accessToken, refreshToken, tokenType } = value;
  if (!isNonEmptyString(accessToken) || !isNonEmptyString(refreshToken) || !isNonEmptyString(tokenType)) {
    return null;
  }
  return { accessToken, refreshToken, tokenType };
}

function readMitraSpaceToken(value: unknown): MitraSpaceToken | null {
  if (!isPlainObject(value)) return null;
  const { token, tokenType } = value;
  if (!isNonEmptyString(token) || !isNonEmptyString(tokenType)) return null;
  return { token, tokenType };
}

/**
 * Normalizes the optional `allTokens` field. Only apps enabled server-side receive
 * it, so anything absent or malformed is dropped instead of failing the login.
 *
 * @internal
 */
export function normalizeAllTokens(value: unknown): AllTokens | undefined {
  if (!isPlainObject(value)) return undefined;
  return {
    platform: readPlatformTokens(value.platform),
    mitraSpace: readMitraSpaceToken(value.mitraSpace),
  };
}

export function expectAuthTokenResponse(value: unknown): AuthTokenResponse {
  const response = expectObject<Record<string, unknown>>(
    value,
    'Authentication token response',
    coreErrors
  );

  for (const field of ['accessToken', 'refreshToken', 'tokenType'] as const) {
    if (!isNonEmptyString(response[field])) {
      throw coreErrors.invalidResponse(
        `Authentication token response has an invalid ${field} field`
      );
    }
  }

  const allTokens = normalizeAllTokens(response.allTokens);

  return {
    accessToken: response.accessToken as string,
    refreshToken: response.refreshToken as string,
    tokenType: response.tokenType as string,
    ...(allTokens ? { allTokens } : {}),
  };
}

/** Coordinates the browser-only OAuth handshake through the brand auth page (Google or Microsoft) and returns IAM tokens. */
export class GoogleAuthFlow {
  private readonly appId: string;
  private readonly apiUrl: string;
  private readonly configuredAuthPageUrl?: string;
  private readonly client: HttpClient;
  private readonly provider: AuthPageProvider;
  private readonly providerLabel: string;
  private readonly redirectStorageKey: string;
  private popupPromise: Promise<AuthTokenResponse> | null = null;

  constructor(config: GoogleAuthFlowConfig) {
    this.appId = config.appId;
    this.apiUrl = stripTrailingSlashes(config.apiUrl);
    this.configuredAuthPageUrl = config.authPageUrl;
    this.client = config.client;
    this.provider = config.provider ?? 'google';
    this.providerLabel = PROVIDER_LABELS[this.provider];
    this.redirectStorageKey = `mitra_${this.provider}_redirect_${config.appId}`;
  }

  signIn(options: GoogleSignInOptions = {}): Promise<AuthTokenResponse> {
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

  async completeRedirect(): Promise<AuthTokenResponse | null> {
    const browserWindow = this.requireBrowser();
    const params = new URLSearchParams(browserWindow.location.hash.replace(/^#/, ''));
    const code = params.get('codeMitra');
    const state = params.get('stateMitra');
    const error = params.get('errorMitra');

    if (code === null && state === null && error === null) return null;

    const context = this.readRedirectContext(browserWindow);
    if (!state?.trim()) {
      throw new Error(`${this.providerLabel} sign-in redirect is missing state.`);
    }
    if (context?.state !== state) {
      throw new Error(`Invalid ${this.providerLabel} sign-in state (possible CSRF).`);
    }

    const expectedRedirectUri = this.getRedirectUri(
      resolveAuthPageUrl(this.apiUrl, this.configuredAuthPageUrl, browserWindow)
    );
    if (context.redirectUri !== expectedRedirectUri) {
      throw new Error(`${this.providerLabel} sign-in redirect context is invalid.`);
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
    const popup = this.openPopup(browserWindow, this.buildStartUrl(browserWindow, authPageUrl, state));
    const result = await this.waitForPopupResult(browserWindow, popup, authPageUrl.origin, state);

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
    const context: RedirectContext = {
      state,
      redirectUri: this.getRedirectUri(authPageUrl),
    };

    this.persistRedirectContext(browserWindow, context);
    const startUrl = this.buildStartUrl(browserWindow, authPageUrl, state);
    browserWindow.location.assign(startUrl.toString());

    return new Promise<never>(() => undefined);
  }

  private async exchangeCode(
    code: string,
    redirectUri: string
  ): Promise<AuthTokenResponse> {
    const response = await this.client.post<unknown>(`/api/v1/auth/${this.provider}`, {
      appId: this.appId,
      code,
      redirectUri,
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

  private generateState(): string {
    if (!globalThis.crypto?.getRandomValues) {
      throw new Error(`${this.providerLabel} sign-in requires crypto.getRandomValues.`);
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private openPopup(browserWindow: MitraWindow, url: URL): Window {
    const outerWidth = browserWindow.outerWidth || browserWindow.screen.width;
    const outerHeight = browserWindow.outerHeight || browserWindow.screen.height;
    const left = Math.max(0, (browserWindow.screenX || 0) + (outerWidth - POPUP_WIDTH) / 2);
    const top = Math.max(0, (browserWindow.screenY || 0) + (outerHeight - POPUP_HEIGHT) / 2);
    const popup = browserWindow.open(
      url.toString(),
      'mitra-google-oauth',
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
      }, POPUP_TIMEOUT_MS);
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
          reject(new Error('Google auth page returned neither code nor token.'));
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

  private persistRedirectContext(browserWindow: MitraWindow, context: RedirectContext): void {
    try {
      browserWindow.sessionStorage.setItem(this.redirectStorageKey, JSON.stringify(context));
    } catch {
      throw new Error(`${this.providerLabel} sign-in redirect requires sessionStorage.`);
    }
  }

  private readRedirectContext(browserWindow: MitraWindow): RedirectContext | null {
    try {
      const raw = browserWindow.sessionStorage.getItem(this.redirectStorageKey);
      if (!raw) return null;
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (typeof value.state !== 'string' || typeof value.redirectUri !== 'string') return null;
      return {
        state: value.state,
        redirectUri: value.redirectUri,
      };
    } catch {
      return null;
    }
  }

  private clearRedirectContext(browserWindow: MitraWindow): void {
    try {
      browserWindow.sessionStorage.removeItem(this.redirectStorageKey);
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
