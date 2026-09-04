import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConfig, type LoginResponse } from 'mitra-interactions-sdk';
import { createClient } from '../client';
import { exchangeSsoCodeMitra } from './index';
import { adoptLegacySession, resetActiveBridge } from './bridge';
import {
  mockFetch,
  mockFetchSequence,
  mockLocalStorage,
  mockSessionStorage,
} from '../test-utils';

const APP_ID = 'app-1';
const API_URL = 'https://api.mitra.io';
const LEGACY_URL = `${API_URL}/legacy`;
const STORAGE_KEY = `mitra_auth_${APP_ID}`;
const currentUserResponse = {
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

/** Builds an unsigned JWT so the legacy scope check can read the claims. */
function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.`;
}

const appScopedRefreshToken = fakeJwt({ app_id: APP_ID, sub: 'u1' });

function readStoredSession(storage: ReturnType<typeof mockLocalStorage>) {
  return JSON.parse(storage._store[STORAGE_KEY]);
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The legacy transport reads the body as text, which `mockFetch` does not serve. */
function mockLegacyFetch(response: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(response)),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('LegacySessionBridge', () => {
  let storage: ReturnType<typeof mockLocalStorage>;

  beforeEach(() => {
    storage = mockLocalStorage();
    mockFetch({});
  });

  afterEach(() => {
    resetActiveBridge();
    vi.unstubAllGlobals();
  });

  it('should configure the legacy SDK from the client config', () => {
    createClient({ appId: APP_ID, apiUrl: `${API_URL}///` });

    expect(getConfig().baseURL).toBe(LEGACY_URL);
    expect(getConfig().authUrl).toBe(LEGACY_URL);
    expect(getConfig().authPageUrl).toBe(`${API_URL}/sdk-auth.html`);
    expect(getConfig().projectId).toBe(APP_ID);
    expect(typeof getConfig().onTokenRefresh).toBe('function');
  });

  it('should resolve the injected auth page again on every legacy session update', () => {
    const injectedEnvironment = {
      authPageUrl: 'https://injected.example.com/sdk-auth.html?brand=first',
    };
    vi.stubGlobal('window', { __mitraEnv: injectedEnvironment });
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    expect(getConfig().authPageUrl).toBe(injectedEnvironment.authPageUrl);

    injectedEnvironment.authPageUrl = 'https://injected.example.com/sdk-auth.html?brand=second';
    mitra.auth.setToken('new-token');

    expect(getConfig().authPageUrl).toBe(injectedEnvironment.authPageUrl);
  });

  it('should prefer the explicit auth page and preserve its query', () => {
    vi.stubGlobal('window', {
      __mitraEnv: { authPageUrl: 'https://injected.example.com/sdk-auth.html' },
    });
    const explicitAuthPageUrl =
      'https://explicit.example.com/custom-auth.html?brand=acme&source=sdk';

    createClient({
      appId: APP_ID,
      apiUrl: API_URL,
      authPageUrl: explicitAuthPageUrl,
    });

    expect(getConfig().authPageUrl).toBe(explicitAuthPageUrl);
    expect(getConfig().baseURL).toBe(LEGACY_URL);
    expect(getConfig().authUrl).toBe(LEGACY_URL);
  });

  it('should hand a persisted session to the legacy SDK on boot', () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: 'persisted-access-token',
      refreshToken: appScopedRefreshToken,
    });

    createClient({ appId: APP_ID, apiUrl: API_URL });

    expect(getConfig().token).toBe('persisted-access-token');
    expect(getConfig().refreshToken).toBe(appScopedRefreshToken);
  });

  it('should leave the legacy session empty when nothing is persisted', () => {
    createClient({ appId: APP_ID, apiUrl: API_URL });

    expect(getConfig().token).toBeUndefined();
    expect(getConfig().refreshToken).toBeUndefined();
  });

  it('should propagate an adopted native session to the legacy SDK', async () => {
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });
    const fetchMock = mockFetchSequence([{ body: currentUserResponse }]);

    mitra.auth.setSession({
      accessToken: 'native-access-token',
      refreshToken: appScopedRefreshToken,
    });
    await mitra.auth.checkAuth();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getConfig()).toMatchObject({
      baseURL: LEGACY_URL,
      authUrl: LEGACY_URL,
      token: 'native-access-token',
      refreshToken: appScopedRefreshToken,
    });
  });

  it('should propagate native Google SSO while its code exchange stays on IAM', async () => {
    const messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
    const popup = {
      closed: false,
      close: vi.fn(function close(this: { closed: boolean }) {
        this.closed = true;
      }),
    } as unknown as Window;
    const browserWindow = {
      location: { origin: 'https://app.example.com' },
      outerWidth: 1280,
      outerHeight: 720,
      screenX: 0,
      screenY: 0,
      screen: { width: 1280, height: 720 },
      open: vi.fn(() => popup),
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
        if (type === 'message') messageListeners.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
        if (type === 'message') messageListeners.delete(listener);
      }),
    } as unknown as Window;
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7);
        return bytes;
      },
    });
    const fetchMock = mockFetchSequence([
      {
        body: {
          accessToken: 'google-access-token',
          refreshToken: appScopedRefreshToken,
          tokenType: 'Bearer',
        },
      },
      { body: currentUserResponse },
    ]);
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    const signIn = mitra.auth.signInWithGoogle({ mode: 'popup' });
    const startUrl = new URL(vi.mocked(browserWindow.open).mock.calls[0][0] as string);
    messageListeners.forEach((listener) => listener({
      origin: startUrl.origin,
      source: popup,
      data: {
        type: 'mitra-oauth-result',
        success: true,
        state: startUrl.searchParams.get('state'),
        code: 'google-code',
      },
    } as MessageEvent<unknown>));
    await signIn;

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_URL}/iam/api/v1/auth/google`);
    expect(getConfig()).toMatchObject({
      baseURL: LEGACY_URL,
      authUrl: LEGACY_URL,
      token: 'google-access-token',
      refreshToken: appScopedRefreshToken,
    });
  });

  it('should propagate a native refresh to the legacy SDK', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: 'old-access-token',
      refreshToken: appScopedRefreshToken,
    });
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });
    mockFetchSequence([
      {
        body: {
          accessToken: 'new-access-token',
          refreshToken: appScopedRefreshToken,
          tokenType: 'Bearer',
        },
      },
    ]);

    await expect(mitra.auth.refreshSession()).resolves.toBe(true);

    expect(getConfig().token).toBe('new-access-token');
    expect(getConfig().refreshToken).toBe(appScopedRefreshToken);
  });

  it('should clear the active legacy credentials on native sign-out', () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: 'native-access-token',
      refreshToken: appScopedRefreshToken,
    });
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    mitra.auth.signOut();

    expect(getConfig().token).toBeUndefined();
    expect(getConfig().refreshToken).toBeUndefined();
    expect(getConfig().baseURL).toBe(LEGACY_URL);
    expect(getConfig().authUrl).toBe(LEGACY_URL);
    // The legacy SDK has no public API for deleting its private persisted token.
    expect(JSON.parse(storage._store['mitra-session']).refreshToken).toBe(appScopedRefreshToken);
  });

  it('should keep the legacy bridge cleared after a late proactive refresh response', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: fakeJwt({ app_id: APP_ID, exp: nowSeconds - 1 }),
      refreshToken: fakeJwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
    });
    const pendingRefresh = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingRefresh.promise));
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    const refreshing = mitra.auth.ensureFreshSession();
    mitra.auth.signOut();
    pendingRefresh.resolve(jsonResponse({
      accessToken: fakeJwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
      refreshToken: fakeJwt({ app_id: APP_ID, exp: nowSeconds + 7_200 }),
      tokenType: 'Bearer',
    }));

    await expect(refreshing).resolves.toBe(false);
    expect(getConfig().token).toBeUndefined();
    expect(getConfig().refreshToken).toBeUndefined();
    expect(storage._store[STORAGE_KEY]).toBeUndefined();
  });

  it('should keep the legacy bridge cleared when sign out wins a reactive refresh', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: 'opaque-access',
      refreshToken: appScopedRefreshToken,
    });
    const pendingRefresh = deferredResponse();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'Expired' }, 401))
      .mockReturnValueOnce(pendingRefresh.promise);
    vi.stubGlobal('fetch', fetchMock);
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    const execution = mitra.functions.execute('fn-1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    mitra.auth.signOut();
    pendingRefresh.resolve(jsonResponse({
      accessToken: 'late-access',
      refreshToken: appScopedRefreshToken,
      tokenType: 'Bearer',
    }));

    await expect(execution).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getConfig().token).toBeUndefined();
    expect(getConfig().refreshToken).toBeUndefined();
    expect(storage._store[STORAGE_KEY]).toBeUndefined();
  });

  it.each([
    ['success', 200],
    ['definitive failure', 401],
  ])('should keep a newer bridged session after an old refresh %s', async (_label, status) => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: null,
      token: 'old-access',
      refreshToken: appScopedRefreshToken,
    });
    const pendingRefresh = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingRefresh.promise));
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    const oldRefresh = mitra.auth.refreshSession();
    adoptLegacySession({
      token: 'bridged-access',
      refreshToken: appScopedRefreshToken,
      baseURL: LEGACY_URL,
    });
    pendingRefresh.resolve(jsonResponse(
      status === 200
        ? {
            accessToken: 'late-access',
            refreshToken: appScopedRefreshToken,
            tokenType: 'Bearer',
          }
        : { message: 'Old refresh rejected' },
      status,
    ));

    await expect(oldRefresh).resolves.toBe(false);
    expect(getConfig().token).toBe('bridged-access');
    expect(getConfig().refreshToken).toBe(appScopedRefreshToken);
    expect(readStoredSession(storage)).toMatchObject({
      token: 'bridged-access',
      refreshToken: appScopedRefreshToken,
    });
  });

  it('should retry an old 401 with a newly adopted session without refreshing it', async () => {
    const newAccessToken = fakeJwt({
      app_id: APP_ID,
      sub: 'u2',
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const newRefreshToken = fakeJwt({ app_id: APP_ID, sub: 'u2' });
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'old@test.com', name: null },
      token: 'old-access',
      refreshToken: appScopedRefreshToken,
    });
    const pendingMe = deferredResponse();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(pendingMe.promise)
      .mockImplementation((url: string) => {
        if (url.endsWith('/api/v1/auth/refresh-token')) {
          return Promise.resolve(jsonResponse({ message: 'New refresh must not be used' }, 401));
        }
        return Promise.resolve(jsonResponse(currentUserResponse));
      });
    vi.stubGlobal('fetch', fetchMock);
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    const loadingUser = mitra.auth.me();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    adoptLegacySession({
      token: newAccessToken,
      refreshToken: newRefreshToken,
      baseURL: LEGACY_URL,
    });
    pendingMe.resolve(jsonResponse({ message: 'Old access rejected' }, 401));

    await expect(loadingUser).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) =>
      !String(url).endsWith('/api/v1/auth/refresh-token')
    )).toBe(true);
    expect(fetchMock.mock.calls.some(([, request]) =>
      String((request as RequestInit | undefined)?.body).includes(newRefreshToken)
    )).toBe(false);
    const firstHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const retryHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe('Bearer old-access');
    expect(retryHeaders.Authorization).toBe(`Bearer ${newAccessToken}`);
    expect(readStoredSession(storage)).toMatchObject({
      token: newAccessToken,
      refreshToken: newRefreshToken,
    });
    expect(getConfig()).toMatchObject({
      token: newAccessToken,
      refreshToken: newRefreshToken,
    });
  });

  it('should not refresh or retry an old 401 after sign-out', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'old@test.com', name: null },
      token: 'old-access',
      refreshToken: appScopedRefreshToken,
    });
    const pendingMe = deferredResponse();
    const fetchMock = vi.fn().mockReturnValueOnce(pendingMe.promise);
    vi.stubGlobal('fetch', fetchMock);
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    const loadingUser = mitra.auth.me();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    mitra.auth.signOut();
    pendingMe.resolve(jsonResponse({ message: 'Old access rejected' }, 401));

    await expect(loadingUser).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(storage._store[STORAGE_KEY]).toBeUndefined();
    expect(getConfig().token).toBeUndefined();
    expect(getConfig().refreshToken).toBeUndefined();
  });

  it('should propagate a manual native token change to the active legacy client', () => {
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    mitra.auth.setToken('manual-access-token');

    expect(getConfig().token).toBe('manual-access-token');
    expect(getConfig().refreshToken).toBeUndefined();
  });

  it('should disconnect the previous client from the legacy singleton', () => {
    const first = createClient({ appId: APP_ID, apiUrl: API_URL });
    createClient({ appId: 'app-2', apiUrl: 'https://other-api.mitra.io' });

    first.auth.setToken('stale-client-token');

    expect(getConfig().projectId).toBe('app-2');
    expect(getConfig().baseURL).toBe('https://other-api.mitra.io/legacy');
    expect(getConfig().token).toBeUndefined();
  });

  it('should persist a legacy token refresh into the client session', () => {
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    getConfig().onTokenRefresh?.({
      token: 'refreshed-access-token',
      refreshToken: appScopedRefreshToken,
      baseURL: API_URL,
    });

    expect(mitra.auth.accessToken).toBe('refreshed-access-token');
    expect(readStoredSession(storage)).toMatchObject({
      token: 'refreshed-access-token',
      refreshToken: appScopedRefreshToken,
    });
  });

  it('should keep the extra login tokens on a legacy token refresh and drop them on a legacy login', () => {
    const allTokens = {
      platform: {
        accessToken: 'session-access',
        refreshToken: 'session-refresh',
        tokenType: 'Bearer',
      },
      mitraSpace: { token: 'space-token', tokenType: 'Bearer' },
    };
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: 'old-access',
      refreshToken: appScopedRefreshToken,
      allTokens,
    });
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    getConfig().onTokenRefresh?.({
      token: 'refreshed-access-token',
      refreshToken: appScopedRefreshToken,
      baseURL: API_URL,
    });

    expect(mitra.auth.accessToken).toBe('refreshed-access-token');
    expect(mitra.auth.allTokens).toEqual(allTokens);
    expect(readStoredSession(storage).allTokens).toEqual(allTokens);

    adoptLegacySession({
      token: 'sso-access-token',
      refreshToken: appScopedRefreshToken,
      baseURL: API_URL,
    });

    expect(mitra.auth.allTokens).toBeNull();
    expect(readStoredSession(storage).allTokens).toBeUndefined();
  });

  it('should reinstate the refresh hook that a legacy login drops', () => {
    createClient({ appId: APP_ID, apiUrl: API_URL });
    const initialHook = getConfig().onTokenRefresh;

    adoptLegacySession({ token: 'sso-access-token', baseURL: API_URL });

    expect(typeof getConfig().onTokenRefresh).toBe('function');
    expect(getConfig().onTokenRefresh).not.toBe(initialHook);
  });

  it('should persist a legacy login session into the client session', () => {
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    adoptLegacySession({
      token: 'sso-access-token',
      refreshToken: appScopedRefreshToken,
      baseURL: API_URL,
    });

    expect(mitra.auth.accessToken).toBe('sso-access-token');
    expect(readStoredSession(storage)).toMatchObject({
      token: 'sso-access-token',
      refreshToken: appScopedRefreshToken,
    });
  });

  it('should store the bare JWT when the legacy session carries the Bearer scheme', () => {
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    adoptLegacySession({ token: 'Bearer sso-access-token', baseURL: API_URL });

    expect(mitra.auth.accessToken).toBe('sso-access-token');
    expect(readStoredSession(storage).token).toBe('sso-access-token');
  });

  it('should keep the current user when adopting a legacy session', () => {
    const user = { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null };
    storage._store[STORAGE_KEY] = JSON.stringify({ user, token: 'old', refreshToken: null });

    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });
    adoptLegacySession({ token: 'sso-access-token', baseURL: API_URL });

    expect(mitra.auth.currentUser).toEqual(user);
    expect(readStoredSession(storage).user).toEqual(user);
  });

  it('should ignore a legacy session when no client was created', () => {
    expect(() =>
      adoptLegacySession({ token: 'sso-access-token', baseURL: API_URL })
    ).not.toThrow();
  });

  it('should create the client even when the legacy SDK rejects the config', () => {
    const mitra = createClient({ appId: APP_ID, apiUrl: '' });

    expect(mitra.auth).toBeDefined();
    expect(mitra.entities).toBeDefined();
  });

  it('should clear a persisted native session with an out-of-scope refresh token', () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: null,
      token: 'persisted-access-token',
      refreshToken: fakeJwt({ sub: 'u1' }),
    });

    createClient({ appId: APP_ID, apiUrl: API_URL });

    expect(getConfig().token).toBeUndefined();
    expect(getConfig().refreshToken).toBeUndefined();
    expect(storage._store[STORAGE_KEY]).toBeUndefined();
  });

  it('should reject a legacy session issued for another app and clear legacy credentials', () => {
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    adoptLegacySession({
      token: fakeJwt({ app_id: 'other-app' }),
      refreshToken: fakeJwt({ app_id: 'other-app' }),
      baseURL: API_URL,
    });

    expect(mitra.auth.accessToken).toBeNull();
    expect(storage._store[STORAGE_KEY]).toBeUndefined();
    expect(getConfig().token).toBeUndefined();
    expect(getConfig().refreshToken).toBeUndefined();
  });

  it('should clear the extra tokens when a legacy token refresh returns another app', () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: 'old-access',
      refreshToken: appScopedRefreshToken,
      allTokens: {
        platform: {
          accessToken: 'session-access',
          refreshToken: 'session-refresh',
          tokenType: 'Bearer',
        },
        mitraSpace: { token: 'space-token', tokenType: 'Bearer' },
      },
    });
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    getConfig().onTokenRefresh?.({
      token: fakeJwt({ app_id: 'other-app' }),
      refreshToken: fakeJwt({ app_id: 'other-app' }),
      baseURL: API_URL,
    });

    expect(mitra.auth.allTokens).toBeNull();
    expect(mitra.auth.accessToken).toBeNull();
    expect(storage._store[STORAGE_KEY]).toBeUndefined();
    expect(getConfig().token).toBeUndefined();
    expect(getConfig().refreshToken).toBeUndefined();
  });

  it('should persist the session of a real legacy SSO exchange', async () => {
    const sessionStore = mockSessionStorage();
    sessionStore._store['mitra_sso_redirect'] = JSON.stringify({
      state: 'nonce-1',
      authUrl: LEGACY_URL,
      provider: 'google',
      redirectUri: 'https://app.mitra.io/callback',
      projectId: APP_ID,
    });
    const fetchMock = mockLegacyFetch({
      token: 'sso-exchanged-token',
      refreshToken: appScopedRefreshToken,
    });
    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

    const session = await exchangeSsoCodeMitra({ code: 'sso-code', state: 'nonce-1' });

    expect(fetchMock.mock.calls[0][0]).toBe(`${LEGACY_URL}/auth/google`);
    expect(session.token).toBe('sso-exchanged-token');
    expect(mitra.auth.accessToken).toBe('sso-exchanged-token');
    expect(readStoredSession(storage)).toMatchObject({
      token: 'sso-exchanged-token',
      refreshToken: appScopedRefreshToken,
    });
    // The legacy login path reconfigures the SDK without a refresh callback.
    expect(typeof getConfig().onTokenRefresh).toBe('function');
  });

  it('should not refresh on its own', () => {
    const fetchMock = mockFetch({});

    const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });
    adoptLegacySession({
      token: 'sso-access-token',
      refreshToken: appScopedRefreshToken,
      baseURL: API_URL,
    } satisfies LoginResponse);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mitra.auth.accessToken).toBe('sso-access-token');
  });
});
