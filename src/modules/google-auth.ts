import { expectObject } from '@mitralab.io/sdk-core';
import { coreErrors } from '../core-errors';
import type { HttpClient } from '../utils/http-client';
import { resolveAuthPageUrl } from './auth-page-url';
import type { AuthTokenResponse, GoogleSignInOptions } from './auth.types';

const RESULT_TYPE = 'mitra-oauth-result';
const REDIRECT_STORAGE_PREFIX = 'mitra_google_redirect_';
const POPUP_WIDTH = 480;
const POPUP_HEIGHT = 600;
const POPUP_TIMEOUT_MS = 5 * 60 * 1_000;
const POPUP_CLOSED_POLL_MS = 500;

interface GoogleAuthFlowConfig {
  appId: string;
  apiUrl: string;
  authPageUrl?: string;
  client: HttpClient;
}

interface RedirectContext {
  state: string;
  redirectUri: string;
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

/** Coordinates the browser-only Google OAuth handshake and returns IAM tokens. */
export class GoogleAuthFlow {
  private readonly appId: string;
  private readonly apiUrl: string;
  private readonly configuredAuthPageUrl?: string;
  private readonly client: HttpClient;
  private readonly redirectStorageKey: string;
  private popupPromise: Promise<AuthTokenResponse> | null = null;

  constructor(config: GoogleAuthFlowConfig) {
    this.appId = config.appId;
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.configuredAuthPageUrl = config.authPageUrl;
    this.client = config.client;
    this.redirectStorageKey = `${REDIRECT_STORAGE_PREFIX}${config.appId}`;
  }

  signIn(options: GoogleSignInOptions = {}): Promise<AuthTokenResponse> {
    const browserWindow = this.requireBrowser();

    if (options.mode === 'redirect') {
      return this.startRedirect(browserWindow);
    }

    if (options.mode !== undefined && options.mode !== 'popup') {
      return Promise.reject(new Error(`Unsupported Google sign-in mode: ${String(options.mode)}`));
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
      throw new Error('Google sign-in redirect is missing state.');
    }
    if (!context || context.state !== state) {
      throw new Error('Invalid Google sign-in state (possible CSRF).');
    }

    const expectedRedirectUri = this.getRedirectUri(
      resolveAuthPageUrl(this.apiUrl, this.configuredAuthPageUrl, browserWindow)
    );
    if (context.redirectUri !== expectedRedirectUri) {
      throw new Error('Google sign-in redirect context is invalid.');
    }

    this.cleanRedirectFragment(browserWindow);
    this.clearRedirectContext(browserWindow);

    if (code === 'error' || error !== null) {
      throw new Error(error || 'Google sign-in failed.');
    }
    if (!code?.trim()) {
      throw new Error('Google sign-in redirect is missing code.');
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
    const response = await this.client.post<unknown>('/api/v1/auth/google', {
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
    startUrl.searchParams.set('provider', 'google');
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
      throw new Error('Google sign-in requires crypto.getRandomValues.');
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
      throw new Error('Google sign-in popup was blocked by the browser.');
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
        reject(new Error('Google sign-in timed out.'));
      }, POPUP_TIMEOUT_MS);
      const closedPoll = globalThis.setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject(new Error('Google sign-in was cancelled.'));
        }
      }, POPUP_CLOSED_POLL_MS);

      const onMessage = (event: MessageEvent<unknown>) => {
        if (event.origin !== expectedOrigin || event.source !== popup) return;
        if (!event.data || typeof event.data !== 'object') return;

        const data = event.data as Record<string, unknown>;
        if (data.type !== RESULT_TYPE) return;
        if (data.state !== expectedState) {
          cleanup();
          reject(new Error('Invalid Google sign-in state (possible CSRF).'));
          return;
        }
        if (data.success !== true) {
          cleanup();
          reject(new Error(typeof data.error === 'string' && data.error.trim()
            ? data.error
            : 'Google sign-in failed.'));
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
      throw new Error('Google sign-in redirect requires sessionStorage.');
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
      throw new Error('Google sign-in is only available in a browser.');
    }
    return globalThis.window as MitraWindow;
  }
}
