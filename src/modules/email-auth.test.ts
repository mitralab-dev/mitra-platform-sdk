import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetchSequence, mockLocalStorage, mockSessionStorage } from '../test-utils';
import { AuthModule } from './auth';

const APP_ID = '11111111-1111-1111-1111-111111111111';
const API_URL = 'https://api.mitra.io';
const IAM_URL = `${API_URL}/iam`;
const AUTH_PAGE_URL = `${API_URL}/sdk-auth.html`;
const EXCHANGE_URL = `${IAM_URL}/api/v1/auth/magic-link/exchange`;
const PENDING_KEY = `mitra_email_redirect_${APP_ID}`;
const SESSION_KEY = `mitra_auth_${APP_ID}`;
const TEN_MINUTES_MS = 10 * 60 * 1_000;
const OTHER_TAB_STATE = 'email.0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
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

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

interface BrowserHarness {
  popup: Window;
  window: Window;
  localStorage: ReturnType<typeof mockLocalStorage>;
  dispatchMessage(data: unknown): void;
  getStartUrl(): URL;
  getRedirectUrl(): URL;
}

function mockBrowser(): BrowserHarness {
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const popup = { closed: false, close: vi.fn() } as unknown as Window;
  const location = {
    origin: 'https://app.example.com',
    href: 'https://app.example.com/orders?status=open',
    pathname: '/orders',
    search: '?status=open',
    hash: '',
    assign: vi.fn(),
  };
  const localStorageMock = mockLocalStorage();
  const browserWindow = {
    location,
    localStorage: localStorageMock,
    sessionStorage: mockSessionStorage(),
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
  } as unknown as Window;

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
    localStorage: localStorageMock,
    dispatchMessage(data) {
      const event = { data, origin: API_URL, source: popup } as MessageEvent<unknown>;
      listeners.forEach((listener) => listener(event));
    },
    getStartUrl() {
      const [url] = vi.mocked(browserWindow.open).mock.calls[0];
      return new URL(url as string);
    },
    getRedirectUrl() {
      return new URL(vi.mocked(browserWindow.location.assign).mock.calls[0][0] as string);
    },
  };
}

function popupResult(state: string, code: string) {
  return { type: 'mitra-oauth-result', success: true, state, code };
}

function pendingRequest(browser: BrowserHarness, state: string, createdAt: number): void {
  browser.localStorage._store[PENDING_KEY] = JSON.stringify({
    state,
    redirectUri: AUTH_PAGE_URL,
    createdAt,
  });
}

function readPendingRequest(browser: BrowserHarness): Record<string, unknown> {
  return JSON.parse(
    vi.mocked(browser.localStorage.setItem).mock.calls
      .filter(([key]) => key === PENDING_KEY)
      .map(([, value]) => value)
      .at(-1)!
  );
}

describe('Email sign-in', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exchanges the popup code at the magic link route and hydrates the session', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithEmail({ mode: 'popup' });
    const startUrl = browser.getStartUrl();
    const state = startUrl.searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, 'exchange-code'));

    await expect(signIn).resolves.toEqual(USER);
    expect(startUrl.origin + startUrl.pathname).toBe(AUTH_PAGE_URL);
    expect(startUrl.searchParams.get('provider')).toBe('email');
    expect(startUrl.searchParams.get('appId')).toBe(APP_ID);
    expect(startUrl.searchParams.get('apiUrl')).toBe(API_URL);
    expect(startUrl.searchParams.get('origin')).toBe('https://app.example.com');
    expect(startUrl.searchParams.get('responseType')).toBe('code');
    expect(fetchMock.mock.calls[0][0]).toBe(EXCHANGE_URL);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appId: APP_ID,
      code: 'exchange-code',
    });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    expect(auth.currentUser).toEqual(USER);
    expect(JSON.parse(browser.localStorage._store[SESSION_KEY])).toEqual({
      user: USER,
      token: 'access-123',
      refreshToken: 'refresh-456',
    });
  });

  it('keeps the popup request pending for the link and drops it once the popup wins', async () => {
    const browser = mockBrowser();
    mockFetchSequence([{ body: TOKEN_RESPONSE }, { body: CURRENT_USER_RESPONSE }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithEmail();
    const state = browser.getStartUrl().searchParams.get('state')!;
    expect(readPendingRequest(browser)).toEqual({
      state,
      redirectUri: AUTH_PAGE_URL,
      createdAt: expect.any(Number),
    });

    browser.dispatchMessage(popupResult(state, 'exchange-code'));
    await signIn;

    expect(browser.localStorage.removeItem).toHaveBeenCalledWith(PENDING_KEY);
    expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
    expect(browser.window.sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('persists the redirect request in localStorage and completes it from the fragment', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithEmail({ mode: 'redirect' });
    const redirectUrl = browser.getRedirectUrl();
    expect(redirectUrl.searchParams.get('provider')).toBe('email');
    expect(browser.window.sessionStorage.setItem).not.toHaveBeenCalled();

    browser.window.location.hash =
      `#codeMitra=redirect-code&stateMitra=${redirectUrl.searchParams.get('state')}`;
    await expect(auth.completeEmailSignInRedirect()).resolves.toEqual(USER);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appId: APP_ID,
      code: 'redirect-code',
    });
    expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders?status=open');
    expect(browser.localStorage.removeItem).toHaveBeenCalledWith(PENDING_KEY);
  });

  it('rejects a redirect with a different state without consuming the pending request', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithEmail({ mode: 'redirect' });
    browser.window.location.hash = '#codeMitra=redirect-code&stateMitra=email.attacker';

    await expect(auth.completeEmailSignInRedirect()).rejects.toThrow('possible CSRF');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.localStorage.removeItem).not.toHaveBeenCalled();
    expect(browser.localStorage._store[PENDING_KEY]).toBeDefined();
    expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders?status=open');
  });

  it('drops its own fragment from the URL when it cannot be completed', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithEmail({ mode: 'redirect' });
    browser.window.location.hash = '#codeMitra=redirect-code&stateMitra=email.attacker';

    await expect(auth.completeEmailSignInRedirect()).rejects.toThrow('possible CSRF');
    expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders?status=open');
  });

  it('completes the tab opened by the link from the request another tab left pending', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    pendingRequest(browser, OTHER_TAB_STATE, Date.now());
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    browser.window.location.hash = `#codeMitra=link-code&stateMitra=${OTHER_TAB_STATE}`;
    await expect(auth.completeEmailSignInRedirect()).resolves.toEqual(USER);

    expect(fetchMock.mock.calls[0][0]).toBe(EXCHANGE_URL);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appId: APP_ID,
      code: 'link-code',
    });
    expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
    expect(browser.window.history.replaceState).toHaveBeenCalled();
  });

  it('refuses an email fragment when no request is pending in this browser', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    browser.window.location.hash = `#codeMitra=link-code&stateMitra=${OTHER_TAB_STATE}`;

    await expect(auth.completeEmailSignInRedirect()).rejects.toThrow('possible CSRF');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.window.history.replaceState).toHaveBeenCalled();
  });

  it('refuses an email fragment whose state is not the pending one', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([]);
    pendingRequest(browser, OTHER_TAB_STATE, Date.now());
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    browser.window.location.hash = '#codeMitra=attacker-code&stateMitra=email.deadbeef';

    await expect(auth.completeEmailSignInRedirect()).rejects.toThrow('possible CSRF');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.localStorage._store[PENDING_KEY]).toBeDefined();
    expect(browser.window.history.replaceState).toHaveBeenCalled();
  });

  it('keeps the request pending when the popup is cancelled, so the link can still finish it', async () => {
    vi.useFakeTimers();
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const rejection = expect(auth.signInWithEmail()).rejects.toThrow('was cancelled');
    Object.defineProperty(browser.popup, 'closed', { value: true, writable: true });
    await vi.advanceTimersByTimeAsync(500);

    await rejection;
    expect(browser.localStorage._store[PENDING_KEY]).toBeDefined();
    expect(browser.localStorage.removeItem).not.toHaveBeenCalledWith(PENDING_KEY);
  });

  it('refuses and discards a pending request that carries no creation time', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([]);
    browser.localStorage._store[PENDING_KEY] = JSON.stringify({
      state: OTHER_TAB_STATE,
      redirectUri: AUTH_PAGE_URL,
    });
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    browser.window.location.hash = `#codeMitra=link-code&stateMitra=${OTHER_TAB_STATE}`;

    await expect(auth.completeEmailSignInRedirect()).rejects.toThrow('expired');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
    expect(browser.window.history.replaceState).toHaveBeenCalled();
  });

  it('refuses and discards a pending request older than ten minutes', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([]);
    pendingRequest(browser, OTHER_TAB_STATE, Date.now() - TEN_MINUTES_MS - 1);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    browser.window.location.hash = `#codeMitra=link-code&stateMitra=${OTHER_TAB_STATE}`;

    await expect(auth.completeEmailSignInRedirect()).rejects.toThrow('expired');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
    expect(browser.window.history.replaceState).toHaveBeenCalled();
  });

  it('refuses an exchanged token issued for another app before persisting or hydrating', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([{
      body: {
        accessToken: jwt({ app_id: 'other-app' }),
        refreshToken: jwt({ app_id: 'other-app' }),
        tokenType: 'Bearer',
      },
    }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithEmail();
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, 'exchange-code'));

    await expect(signIn).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.accessToken).toBeNull();
    expect(browser.localStorage._store[SESSION_KEY]).toBeUndefined();
  });

  it('surfaces the IAM error code when the exchange code is refused', async () => {
    const browser = mockBrowser();
    mockFetchSequence([{
      status: 400,
      body: { message: 'Exchange code is invalid.', error_code: 'INVALID_EXCHANGE_CODE' },
    }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithEmail();
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, 'used-code'));

    await expect(signIn).rejects.toMatchObject({
      name: 'MitraApiError',
      status: 400,
      code: 'INVALID_EXCHANGE_CODE',
      message: 'Exchange code is invalid.',
    });
    expect(auth.accessToken).toBeNull();
  });

  it('validates the exchange response with the same contract as the SSO exchange', async () => {
    const browser = mockBrowser();
    mockFetchSequence([{ body: { accessToken: 'access-123', tokenType: 'Bearer' } }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithEmail();
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, 'exchange-code'));

    await expect(signIn).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('finishes the email fragment at a startup that chains every completion', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    pendingRequest(browser, OTHER_TAB_STATE, Date.now());
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    browser.window.location.hash = `#codeMitra=link-code&stateMitra=${OTHER_TAB_STATE}`;
    const user =
      (await auth.completeGoogleSignInRedirect())
      ?? (await auth.completeMicrosoftSignInRedirect())
      ?? (await auth.completeEmailSignInRedirect());

    expect(user).toEqual(USER);
    expect(fetchMock.mock.calls[0][0]).toBe(EXCHANGE_URL);
    expect(browser.window.history.replaceState).toHaveBeenCalledOnce();
  });

  it.each([
    ['a recent email request pending', 0],
    ['an expired email request pending', TEN_MINUTES_MS + 1],
    ['no email request pending', null],
  ])('finishes the Google fragment at a startup with %s', async (_case, pendingAge) => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    if (pendingAge !== null) pendingRequest(browser, OTHER_TAB_STATE, Date.now() - pendingAge);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithGoogle({ mode: 'redirect' });
    const googleState = browser.getRedirectUrl().searchParams.get('state')!;
    browser.window.location.hash = `#codeMitra=google-code&stateMitra=${googleState}`;
    const user =
      (await auth.completeEmailSignInRedirect())
      ?? (await auth.completeMicrosoftSignInRedirect())
      ?? (await auth.completeGoogleSignInRedirect());

    expect(user).toEqual(USER);
    expect(fetchMock.mock.calls[0][0]).toBe(`${IAM_URL}/api/v1/auth/google`);
    expect(browser.localStorage.removeItem).not.toHaveBeenCalledWith(PENDING_KEY);
    if (pendingAge !== null) expect(browser.localStorage._store[PENDING_KEY]).toBeDefined();
    expect(browser.window.history.replaceState).toHaveBeenCalledOnce();
  });

  it('fails the redirect when localStorage refuses the pending request', async () => {
    const browser = mockBrowser();
    browser.localStorage.setItem.mockImplementation(() => {
      throw new Error('storage is disabled');
    });
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    await expect(auth.signInWithEmail({ mode: 'redirect' })).rejects.toThrow(
      'requires localStorage'
    );
    expect(browser.window.location.assign).not.toHaveBeenCalled();
  });

  it('signs in through the popup even when localStorage refuses the pending request', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    browser.localStorage.setItem.mockImplementation(() => {
      throw new Error('storage is disabled');
    });
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithEmail();
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(popupResult(state, 'exchange-code'));

    await expect(signIn).resolves.toEqual(USER);
    expect(fetchMock.mock.calls[0][0]).toBe(EXCHANGE_URL);
    expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
  });

  it('requires browser APIs', async () => {
    vi.stubGlobal('window', undefined);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    await expect(auth.signInWithEmail()).rejects.toThrow('only available in a browser');
    await expect(auth.completeEmailSignInRedirect()).rejects.toThrow('only available in a browser');
  });
});
