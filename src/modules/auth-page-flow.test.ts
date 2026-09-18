import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOCK_API_URL as API_URL,
  authPageResult,
  mockBrowser,
  mockFetchSequence,
  mockLocalStorage,
  type BrowserHarness,
} from '../test-utils';
import { AuthModule } from './auth';

const APP_ID = '11111111-1111-1111-1111-111111111111';
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

describe('Auth page flow', () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('signs in with Microsoft through the same auth page and IAM exchange', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([
      { body: TOKEN_RESPONSE },
      { body: CURRENT_USER_RESPONSE },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithMicrosoft({ mode: 'popup' });
    const startUrl = browser.getStartUrl();
    const state = startUrl.searchParams.get('state')!;
    browser.dispatchMessage(authPageResult(state, { code: 'microsoft-code' }));

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
    browser.dispatchMessage(authPageResult(state, { code: 'google-code' }));

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
    expect(listener).toHaveBeenLastCalledWith(USER);
    expect(JSON.parse(browser.localStorage._store[SESSION_KEY])).toEqual({
      user: USER,
      token: 'access-123',
      refreshToken: 'refresh-456',
    });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('accepts the structurally valid token returned by the current main auth page', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([{ body: CURRENT_USER_RESPONSE }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle();
    const state = browser.getStartUrl().searchParams.get('state')!;
    browser.dispatchMessage(authPageResult(state, { token: TOKEN_RESPONSE }));

    await expect(signIn).resolves.toEqual(USER);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(`${IAM_URL}/api/v1/auth/me`);
  });

  it('rejects popup JWTs issued for another app before persisting or hydrating', async () => {
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
    browser.dispatchMessage(authPageResult(state, { code: 'google-code' }));

    await expect(signIn).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.accessToken).toBeNull();
    expect(browser.localStorage._store[SESSION_KEY]).toBeUndefined();
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
    browser.dispatchMessage(authPageResult(state, { token: TOKEN_RESPONSE }), invalidEvent);
    browser.dispatchMessage(authPageResult(state, { token: TOKEN_RESPONSE }));

    await expect(signIn).resolves.toEqual(USER);
  });

  it('rejects a popup response with a different CSRF state', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle();
    browser.dispatchMessage(authPageResult('google.attacker', { token: TOKEN_RESPONSE }));

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
    browser.dispatchMessage(authPageResult(state, { token: { accessToken: 'only-one-field' } }));

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
    browser.dispatchMessage(authPageResult(startUrl.searchParams.get('state')!, { token: TOKEN_RESPONSE }), {
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
    const assignedUrl = browser.getRedirectUrl();
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
    const assignedUrl = browser.getRedirectUrl();
    browser.window.location.hash =
      `#codeMitra=redirect-code&stateMitra=${assignedUrl.searchParams.get('state')}`;

    await expect(auth.completeGoogleSignInRedirect()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.accessToken).toBeNull();
    expect(browser.localStorage._store[SESSION_KEY]).toBeUndefined();
  });

  it('rejects a redirect with a different state, keeping its pending request', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
    const storageKey = `mitra_google_redirect_${APP_ID}`;

    void auth.signInWithGoogle({ mode: 'redirect' });
    browser.window.location.hash = '#codeMitra=redirect-code&stateMitra=google.attacker';

    await expect(auth.completeGoogleSignInRedirect()).rejects.toThrow('possible CSRF');
    expect(browser.window.sessionStorage.removeItem).not.toHaveBeenCalled();
    expect(browser.window.sessionStorage.getItem(storageKey)).not.toBeNull();
    expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders?status=open');
  });

  it('rejects a forged redirect error without a bound state, keeping its pending request', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
    const storageKey = `mitra_google_redirect_${APP_ID}`;

    void auth.signInWithGoogle({ mode: 'redirect' });
    browser.window.location.hash = '#codeMitra=error&errorMitra=forged-provider-error';

    await expect(auth.completeGoogleSignInRedirect()).rejects.toThrow('missing state');
    expect(browser.window.sessionStorage.removeItem).not.toHaveBeenCalled();
    expect(browser.window.sessionStorage.getItem(storageKey)).not.toBeNull();
    expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders?status=open');
  });

  it('rejects a forged redirect error with a mismatched state without exposing it', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithGoogle({ mode: 'redirect' });
    browser.window.location.hash =
      '#codeMitra=error&errorMitra=forged-provider-error&stateMitra=google.attacker';

    await expect(auth.completeGoogleSignInRedirect()).rejects.toThrow('possible CSRF');
    expect(browser.window.sessionStorage.removeItem).not.toHaveBeenCalled();
    expect(browser.window.history.replaceState).toHaveBeenCalled();
  });

  it('exposes a redirect error only after validating and consuming its state', async () => {
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    void auth.signInWithGoogle({ mode: 'redirect' });
    const assignedUrl = browser.getRedirectUrl();
    browser.window.location.hash =
      `#codeMitra=error&errorMitra=provider-denied&stateMitra=${assignedUrl.searchParams.get('state')}`;

    await expect(auth.completeGoogleSignInRedirect()).rejects.toThrow('provider-denied');
    expect(browser.window.sessionStorage.removeItem).toHaveBeenCalledWith(
      `mitra_google_redirect_${APP_ID}`
    );
    expect(browser.window.history.replaceState).toHaveBeenCalled();
  });

  it.each([
    ['no pending request of its own', false],
    ['a pending request of its own', true],
  ])('leaves a fragment from another flow alone with %s', async (_case, startsOwnFlow) => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    if (startsOwnFlow) void auth.signInWithGoogle({ mode: 'redirect' });
    browser.window.location.hash = '#codeMitra=link-code&stateMitra=email.0f0f0f0f';

    await expect(auth.completeGoogleSignInRedirect()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.window.history.replaceState).not.toHaveBeenCalled();
    expect(browser.window.sessionStorage.removeItem).not.toHaveBeenCalled();
  });

  it('leaves a fragment whose state has no provider prefix alone (redirect started by an earlier version)', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
    browser.window.location.hash = '#codeMitra=link-code&stateMitra=9f86d081884c7d659a2feaa0c55ad015';

    await expect(auth.completeGoogleSignInRedirect()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.window.history.replaceState).not.toHaveBeenCalled();
  });

  it('names the flow in the state it generates', async () => {
    const browser = mockBrowser();
    mockFetchSequence([{ body: CURRENT_USER_RESPONSE }]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const signIn = auth.signInWithGoogle();
    const state = browser.getStartUrl().searchParams.get('state')!;
    expect(state).toMatch(/^google\.[0-9a-f]{32}$/);

    browser.dispatchMessage(authPageResult(state, { token: TOKEN_RESPONSE }));
    await signIn;

    void auth.signInWithMicrosoft({ mode: 'redirect' });
    const redirected = browser.getRedirectUrl();
    expect(redirected.searchParams.get('state')).toMatch(/^microsoft\.[0-9a-f]{32}$/);
  });

  it('leaves an error fragment without state alone when no flow of its own is pending', async () => {
    const browser = mockBrowser();
    const fetchMock = mockFetchSequence([]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    browser.window.location.hash = '#codeMitra=error&errorMitra=forged-provider-error';

    await expect(auth.completeGoogleSignInRedirect()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.window.history.replaceState).not.toHaveBeenCalled();
    expect(browser.window.sessionStorage.removeItem).not.toHaveBeenCalled();
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

describe('Email auth page flow', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

    browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));
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

  it('keeps the popup open for the whole life of the challenge before timing out', async () => {
    vi.useFakeTimers();
    const browser = mockBrowser();
    const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

    const rejection = expect(auth.signInWithEmail()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    expect(browser.popup.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

    await rejection;
    expect(browser.popup.close).toHaveBeenCalledOnce();
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
    browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

    await expect(signIn).resolves.toEqual(USER);
    expect(fetchMock.mock.calls[0][0]).toBe(EXCHANGE_URL);
    expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
  });
});
