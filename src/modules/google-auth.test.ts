import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetchSequence, mockLocalStorage, mockSessionStorage } from '../test-utils';
import { AuthModule } from './auth';
import { expectAuthTokenResponse } from './google-auth';

const APP_ID = '11111111-1111-1111-1111-111111111111';
const API_URL = 'https://api.mitra.io';
const IAM_URL = `${API_URL}/iam`;
const AUTH_PAGE_URL = `${API_URL}/sdk-auth.html`;
const TOKEN_RESPONSE = {
  accessToken: 'access-123',
  refreshToken: 'refresh-456',
  tokenType: 'Bearer',
};
const CURRENT_USER_RESPONSE = {
  id: 'u1',
  tenant: {
    id: 't1',
    shortId: 'AAAAAAAAAAAAAAAAAAAAEA',
    legacyId: null,
    slug: 'test-tenant',
    clusterType: 'SHARED',
    name: 'Test Tenant',
    description: null,
    hexColor: null,
    icon: null,
    infraStatus: 'ACTIVE',
    active: true,
  },
  email: 'user@test.com',
  name: 'Test User',
  imageUrl: null,
  planId: 'plan-1',
  onboardingCompleted: false,
  language: 'pt-BR',
};
const USER = { ...CURRENT_USER_RESPONSE, tenantId: 't1' };
const ALL_TOKENS = {
  platform: {
    accessToken: 'session-access',
    refreshToken: 'session-refresh',
    tokenType: 'Bearer',
  },
  mitraSpace: { token: 'space-token', tokenType: 'Bearer' },
};

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

interface BrowserHarness {
  popup: Window;
  window: Window & { __mitraEnv?: { authPageUrl?: unknown } };
  dispatchMessage(data: unknown, options?: { origin?: string; source?: MessageEventSource | null }): void;
  getStartUrl(): URL;
}

function mockBrowser(injectedAuthPageUrl?: unknown): BrowserHarness {
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const popup = {
    closed: false,
    close: vi.fn(function close(this: { closed: boolean }) {
      this.closed = true;
    }),
  } as unknown as Window;
  const location = {
    origin: 'https://app.example.com',
    href: 'https://app.example.com/orders?status=open',
    pathname: '/orders',
    search: '?status=open',
    hash: '',
    assign: vi.fn(),
  };
  const sessionStorage = mockSessionStorage();
  const browserWindow = {
    location,
    sessionStorage,
    history: { replaceState: vi.fn() },
    outerWidth: 1280,
    outerHeight: 720,
    screenX: 0,
    screenY: 0,
    screen: { width: 1280, height: 720 },
    open: vi.fn(() => popup),
    addEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
      if (type === 'message') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
      if (type === 'message') listeners.delete(listener);
    }),
    ...(injectedAuthPageUrl !== undefined
      ? { __mitraEnv: { authPageUrl: injectedAuthPageUrl } }
      : {}),
  } as unknown as BrowserHarness['window'];

  vi.stubGlobal('window', browserWindow);
  vi.stubGlobal('crypto', {
    getRandomValues: (bytes: Uint8Array) => {
      bytes.fill(7);
      return bytes;
    },
  });

  return {
    popup,
    window: browserWindow,
    dispatchMessage(data, options = {}) {
      const event = {
        data,
        origin: options.origin ?? API_URL,
        source: options.source === undefined ? popup : options.source,
      } as MessageEvent<unknown>;
      listeners.forEach((listener) => listener(event));
    },
    getStartUrl() {
      const [url] = vi.mocked(browserWindow.open).mock.calls[0];
      return new URL(url as string);
    },
  };
}

function popupResult(state: string, result: Record<string, unknown>) {
  return { type: 'mitra-oauth-result', success: true, state, ...result };
}

describe('Google SSO', () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('signs in with Microsoft through the same auth page and IAM exchange', async () => {
    mockLocalStorage();
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithMicrosoft({ mode: 'popup' });
    const startUrl = browser.getStartUrl();
    const state = startUrl.searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, { code: 'microsoft-code' }));

    await expect(signIn).resolves.toEqual(USER);
    expect(startUrl.origin + startUrl.pathname).toBe(AUTH_PAGE_URL);
    expect(startUrl.searchParams.get('provider')).toBe('microsoft');
    expect(fetchMock.mock.calls[0][0]).toBe(`${IAM_URL}/api/v1/auth/microsoft`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appId: APP_ID,
      code: 'microsoft-code',
      redirectUri: AUTH_PAGE_URL,
    });
    expect(auth.currentUser).toEqual(USER);
  });

  it('exchanges the popup code directly with IAM and hydrates the session', async () => {
    const storage = mockLocalStorage();
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
    const listener = vi.fn();
    auth.onAuthStateChange(listener);

    const signIn = auth.signInWithGoogle({ mode: 'popup' });
    const startUrl = browser.getStartUrl();
    const state = startUrl.searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, { code: 'google-code' }));

    await expect(signIn).resolves.toEqual(USER);
    expect(startUrl.origin + startUrl.pathname).toBe(AUTH_PAGE_URL);
    expect(startUrl.searchParams.get('provider')).toBe('google');
    expect(startUrl.searchParams.get('origin')).toBe('https://app.example.com');
    expect(startUrl.searchParams.get('responseType')).toBe('code');
    expect(startUrl.searchParams.has('lang')).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe(`${IAM_URL}/api/v1/auth/google`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appId: APP_ID,
      code: 'google-code',
      redirectUri: AUTH_PAGE_URL,
    });
    expect(auth.accessToken).toBe('access-123');
    expect(auth.currentUser).toEqual(USER);
    expect(auth.allTokens).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(USER);
    expect(JSON.parse(storage._store[`mitra_auth_${APP_ID}`])).toEqual({
      user: USER,
      token: 'access-123',
      refreshToken: 'refresh-456',
    });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('keeps and persists the extra tokens returned for an enabled app', async () => {
    const storage = mockLocalStorage();
    const browser = mockBrowser();
    mockFetchSequence([
      { body: { ...TOKEN_RESPONSE, allTokens: ALL_TOKENS } },
      { body: CURRENT_USER_RESPONSE },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle({ mode: 'popup' });
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, { code: 'google-code' }));

    await expect(signIn).resolves.toEqual(USER);
    expect(auth.allTokens).toEqual(ALL_TOKENS);
    expect(JSON.parse(storage._store[`mitra_auth_${APP_ID}`]).allTokens).toEqual(ALL_TOKENS);
  });

  it('drops the extra tokens of the previous session when the next login has none', async () => {
    const storage = mockLocalStorage();
    storage._store[`mitra_auth_${APP_ID}`] = JSON.stringify({
      user: USER,
      token: 'old-access',
      refreshToken: 'old-refresh',
      allTokens: ALL_TOKENS,
    });
    const browser = mockBrowser();
    mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
    expect(auth.allTokens).toEqual(ALL_TOKENS);

    const signIn = auth.signInWithGoogle({ mode: 'popup' });
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, { code: 'google-code' }));

    await expect(signIn).resolves.toEqual(USER);
    expect(auth.allTokens).toBeNull();
    expect(JSON.parse(storage._store[`mitra_auth_${APP_ID}`])).not.toHaveProperty('allTokens');
  });

  it('reads no extra tokens when the login response carries neither of them', async () => {
    const storage = mockLocalStorage();
    const browser = mockBrowser();
    mockFetchSequence([
      { body: { ...TOKEN_RESPONSE, allTokens: {} } },
      { body: CURRENT_USER_RESPONSE },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle({ mode: 'popup' });
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, { code: 'google-code' }));

    await expect(signIn).resolves.toEqual(USER);
    expect(auth.allTokens).toBeNull();
    expect(JSON.parse(storage._store[`mitra_auth_${APP_ID}`])).not.toHaveProperty('allTokens');
  });

  it('accepts the structurally valid token returned by the current main auth page', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([{ body: CURRENT_USER_RESPONSE }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle();
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, { token: TOKEN_RESPONSE }));

    await expect(signIn).resolves.toEqual(USER);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(`${IAM_URL}/api/v1/auth/me`);
  });

  it('rejects popup JWTs issued for another app before persisting or hydrating', async () => {
    const storage = mockLocalStorage();
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([{
      body: {
        accessToken: jwt({ app_id: 'other-app' }),
        refreshToken: jwt({ app_id: 'other-app' }),
        tokenType: 'Bearer',
      },
    }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle({ mode: 'popup' });
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, { code: 'google-code' }));

    await expect(signIn).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.accessToken).toBeNull();
    expect(storage._store[`mitra_auth_${APP_ID}`]).toBeUndefined();
  });

  it.each([
    ['wrong origin', { origin: 'https://evil.example.com' }],
    ['wrong source', { source: {} as MessageEventSource }],
  ])('ignores a result from the %s', async (_case, invalidEvent) => {
    const browser = mockBrowser();
    mockFetchSequence([{ body: CURRENT_USER_RESPONSE }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle();
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, { token: TOKEN_RESPONSE }), invalidEvent);
    browser.dispatchMessage(popupResult(state, { token: TOKEN_RESPONSE }));

    await expect(signIn).resolves.toEqual(USER);
  });

  it('rejects a popup response with a different CSRF state', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle();
    browser.dispatchMessage(popupResult('attacker-state', { token: TOKEN_RESPONSE }));

    await expect(signIn).rejects.toThrow('possible CSRF');
  });

  it('reports the error returned by the auth page', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle();
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage({
      type: 'mitra-oauth-result',
      success: false,
      state,
      error: 'Google denied access.',
    });

    await expect(signIn).rejects.toThrow('Google denied access.');
  });

  it('rejects malformed legacy token responses', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle();
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, { token: { accessToken: 'only-one-field' } }));

    await expect(signIn).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reports a blocked popup', async () => {
    const browser = mockBrowser();
    vi.mocked(browser.window.open).mockReturnValue(null);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    await expect(auth.signInWithGoogle()).rejects.toThrow('blocked by the browser');
  });

  it('reports popup cancellation', async () => {
    vi.useFakeTimers();
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const rejection = expect(auth.signInWithGoogle()).rejects.toThrow('was cancelled');
    Object.defineProperty(browser.popup, 'closed', { value: true, writable: true });
    await vi.advanceTimersByTimeAsync(500);

    await rejection;
  });

  it('reports popup timeout and closes it', async () => {
    vi.useFakeTimers();
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const rejection = expect(auth.signInWithGoogle()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

    await rejection;
    expect(browser.popup.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['explicit config', 'https://explicit.example.com/oauth.html', 'https://injected.example.com/auth.html'],
    ['injected env', undefined, 'https://injected.example.com/auth.html'],
    ['API origin fallback', undefined, undefined],
  ])('resolves authPageUrl from %s', async (_case, configured, injected) => {
    const browser = mockBrowser(injected);
    mockFetchSequence([{ body: CURRENT_USER_RESPONSE }]);
    const auth = new AuthModule(APP_ID, IAM_URL, {
      apiUrl: `${API_URL}/gateway/path`,
      ...(configured ? { authPageUrl: configured } : {}),
    });

    const signIn = auth.signInWithGoogle();
    const startUrl = browser.getStartUrl();
    browser.dispatchMessage(popupResult(startUrl.searchParams.get('state')!, { token: TOKEN_RESPONSE }), {
      origin: startUrl.origin,
    });
    await signIn;

    const expected = configured ?? injected ?? AUTH_PAGE_URL;
    expect(startUrl.origin + startUrl.pathname).toBe(expected);
  });

  it('rejects a non-web authPageUrl', async () => {
    mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, {
      apiUrl: API_URL,
      authPageUrl: 'javascript:alert(1)',
    });

    await expect(auth.signInWithGoogle()).rejects.toThrow('absolute HTTP or HTTPS URL');
  });

  it('persists redirect state and completes the code exchange from the fragment', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithGoogle({ mode: 'redirect' });
    const assignedUrl = new URL(vi.mocked(browser.window.location.assign).mock.calls[0][0] as string);
    const state = assignedUrl.searchParams.get('state')!;
    expect(assignedUrl.searchParams.get('responseType')).toBe('code');

    browser.window.location.hash = `#codeMitra=redirect-code&stateMitra=${state}`;
    await expect(auth.completeGoogleSignInRedirect()).resolves.toEqual(USER);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appId: APP_ID,
      code: 'redirect-code',
      redirectUri: AUTH_PAGE_URL,
    });
    expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders?status=open');
    expect(browser.window.sessionStorage.removeItem).toHaveBeenCalledWith(`mitra_google_redirect_${APP_ID}`);
  });

  it('rejects redirect JWTs issued for another app before persisting or hydrating', async () => {
    const storage = mockLocalStorage();
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([{
      body: {
        accessToken: jwt({ app_id: 'other-app' }),
        refreshToken: jwt({ app_id: 'other-app' }),
        tokenType: 'Bearer',
      },
    }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithGoogle({ mode: 'redirect' });
    const assignedUrl = new URL(vi.mocked(browser.window.location.assign).mock.calls[0][0] as string);
    browser.window.location.hash =
      `#codeMitra=redirect-code&stateMitra=${assignedUrl.searchParams.get('state')}`;

    await expect(auth.completeGoogleSignInRedirect()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.accessToken).toBeNull();
    expect(storage._store[`mitra_auth_${APP_ID}`]).toBeUndefined();
  });

  it('rejects a redirect with a different state without consuming its context', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
    const storageKey = `mitra_google_redirect_${APP_ID}`;

    void auth.signInWithGoogle({ mode: 'redirect' });
    browser.window.location.hash = '#codeMitra=redirect-code&stateMitra=attacker-state';

    await expect(auth.completeGoogleSignInRedirect()).rejects.toThrow('possible CSRF');
    expect(browser.window.sessionStorage.removeItem).not.toHaveBeenCalled();
    expect(browser.window.sessionStorage.getItem(storageKey)).not.toBeNull();
    expect(browser.window.history.replaceState).not.toHaveBeenCalled();
  });

  it('rejects a forged redirect error without a bound state or consuming context', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
    const storageKey = `mitra_google_redirect_${APP_ID}`;

    void auth.signInWithGoogle({ mode: 'redirect' });
    browser.window.location.hash = '#codeMitra=error&errorMitra=forged-provider-error';

    await expect(auth.completeGoogleSignInRedirect()).rejects.toThrow('missing state');
    expect(browser.window.sessionStorage.removeItem).not.toHaveBeenCalled();
    expect(browser.window.sessionStorage.getItem(storageKey)).not.toBeNull();
    expect(browser.window.history.replaceState).not.toHaveBeenCalled();
  });

  it('rejects a forged redirect error with a mismatched state without exposing it', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithGoogle({ mode: 'redirect' });
    browser.window.location.hash =
      '#codeMitra=error&errorMitra=forged-provider-error&stateMitra=attacker-state';

    await expect(auth.completeGoogleSignInRedirect()).rejects.toThrow('possible CSRF');
    expect(browser.window.sessionStorage.removeItem).not.toHaveBeenCalled();
    expect(browser.window.history.replaceState).not.toHaveBeenCalled();
  });

  it('exposes a redirect error only after validating and consuming its state', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithGoogle({ mode: 'redirect' });
    const assignedUrl = new URL(vi.mocked(browser.window.location.assign).mock.calls[0][0] as string);
    browser.window.location.hash =
      `#codeMitra=error&errorMitra=provider-denied&stateMitra=${assignedUrl.searchParams.get('state')}`;

    await expect(auth.completeGoogleSignInRedirect()).rejects.toThrow('provider-denied');
    expect(browser.window.sessionStorage.removeItem).toHaveBeenCalledWith(
      `mitra_google_redirect_${APP_ID}`
    );
    expect(browser.window.history.replaceState).toHaveBeenCalled();
  });

  it('returns null when the URL has no Google redirect result', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    await expect(auth.completeGoogleSignInRedirect()).resolves.toBeNull();
    expect(browser.window.history.replaceState).not.toHaveBeenCalled();
  });

  it('requires browser APIs', async () => {
    vi.stubGlobal('window', undefined);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    await expect(auth.signInWithGoogle()).rejects.toThrow('only available in a browser');
    await expect(auth.completeGoogleSignInRedirect()).rejects.toThrow('only available in a browser');
  });
});

describe('expectAuthTokenResponse', () => {
  it('keeps the extra tokens of an enabled app', () => {
    expect(expectAuthTokenResponse({ ...TOKEN_RESPONSE, allTokens: ALL_TOKENS })).toEqual({
      ...TOKEN_RESPONSE,
      allTokens: ALL_TOKENS,
    });
  });

  it('drops malformed parts of the extra tokens instead of failing the login', () => {
    const response = expectAuthTokenResponse({
      ...TOKEN_RESPONSE,
      allTokens: {
        platform: { accessToken: 'session-access', tokenType: 'Bearer' },
        mitraSpace: { token: 42, tokenType: 'Bearer' },
      },
    });

    expect(response.allTokens).toEqual({ platform: null, mitraSpace: null });
  });

  it('rejects blank strings inside the extra tokens', () => {
    const response = expectAuthTokenResponse({
      ...TOKEN_RESPONSE,
      allTokens: {
        platform: { ...ALL_TOKENS.platform, tokenType: '' },
        mitraSpace: { token: '   ', tokenType: 'Bearer' },
      },
    });

    expect(response.allTokens).toEqual({ platform: null, mitraSpace: null });
  });

  it.each([
    ['absent', {}],
    ['null', { allTokens: null }],
    ['not an object', { allTokens: 'nope' }],
    ['an array', { allTokens: [] }],
  ])('omits the extra tokens when the field is %s', (_case, extra) => {
    const response = expectAuthTokenResponse({ ...TOKEN_RESPONSE, ...extra });

    expect(response).toEqual(TOKEN_RESPONSE);
    expect(response.allTokens).toBeUndefined();
  });
});
