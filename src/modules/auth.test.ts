import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthModule, getAuthSessionPort } from './auth';
import {
  MOCK_API_URL as API_URL,
  authPageResult,
  mockBrowser,
  mockFetchSequence,
  mockLocalStorage,
} from '../test-utils';

const APP_ID = 'test-app';
const IAM_URL = `${API_URL}/iam`;
const AUTH_PAGE_URL = `${API_URL}/sdk-auth.html`;
const EXCHANGE_URL = `${IAM_URL}/api/v1/auth/magic-link/exchange`;
const STORAGE_KEY = `mitra_auth_${APP_ID}`;

const fakeUser = { id: 'u1', tenantId: 't1', email: 'user@test.com', name: 'Test User' };
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
const apiUser = { ...currentUserResponse, tenantId: 't1' };
const fakeTokenResponse = { accessToken: 'access-123', refreshToken: 'refresh-456', tokenType: 'Bearer' };
const fakeAllTokens = {
  platform: { accessToken: 'session-access', refreshToken: 'session-refresh', tokenType: 'Bearer' },
  mitraSpace: { token: 'space-token', tokenType: 'Bearer' },
  b2bToken: { accessToken: 'peer-access', refreshToken: 'peer-refresh', tokenType: 'Bearer' },
};
const rotatedPlatform = {
  accessToken: 'new-session-access',
  refreshToken: 'new-session-refresh',
  tokenType: 'Bearer',
};

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function storedSession(
  storage: ReturnType<typeof mockLocalStorage>,
  token: string,
  refreshToken: string,
): void {
  storage._store[STORAGE_KEY] = JSON.stringify({ user: fakeUser, token, refreshToken });
}

function storedSessionWithAllTokens(
  storage: ReturnType<typeof mockLocalStorage>,
  allTokens: unknown = fakeAllTokens,
): void {
  storage._store[STORAGE_KEY] = JSON.stringify({
    user: fakeUser,
    token: 'old-access',
    refreshToken: 'old-refresh',
    allTokens,
  });
}

function storedAllTokens(storage: ReturnType<typeof mockLocalStorage>): unknown {
  return JSON.parse(storage._store[STORAGE_KEY]).allTokens;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
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

describe('AuthModule', () => {
  let storage: ReturnType<typeof mockLocalStorage>;

  beforeEach(() => {
    storage = mockLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should reject unsupported email and password authentication without a request', async () => {
    const fetchMock = mockFetchSequence([]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.signIn({ email: 'user@test.com', password: 'pass' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_AUTH_METHOD',
      message: expect.stringContaining('signInWithEmail()'),
    });
    await expect(auth.signUp({ email: 'user@test.com', password: 'pass' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_AUTH_METHOD',
      message: expect.stringContaining('signInWithEmail()'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject adopted sessions issued for another app before user hydration', () => {
    const auth = new AuthModule(APP_ID, IAM_URL);

    expect(auth.setSession({
      accessToken: jwt({ app_id: 'other-app' }),
      refreshToken: jwt({ app_id: 'other-app' }),
    })).toBe(false);
    expect(auth.accessToken).toBeNull();
    expect(storage._store[STORAGE_KEY]).toBeUndefined();
  });

  it('should reject an invalid canonical current-user response after session adoption', async () => {
    const invalidTenant = { ...currentUserResponse.tenant } as Record<string, unknown>;
    delete invalidTenant.active;
    mockFetchSequence([{ body: { ...currentUserResponse, tenant: invalidTenant } }]);
    const auth = new AuthModule(APP_ID, IAM_URL);
    auth.setSession({ accessToken: 'access-123', refreshToken: 'refresh-456' });

    await expect(auth.checkAuth()).resolves.toBe(false);
    expect(auth.currentUser).toBeNull();
    expect(auth.accessToken).toBe('access-123');
  });

  it('should save and hydrate an adopted session', async () => {
    mockFetchSequence([{ body: currentUserResponse }]);
    const auth = new AuthModule(APP_ID, IAM_URL);
    expect(auth.setSession({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
    })).toBe(true);
    await expect(auth.checkAuth()).resolves.toBe(true);

    expect(storage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      expect.any(String)
    );
    const stored = JSON.parse(storage._store[STORAGE_KEY]);
    expect(stored.user).toEqual(apiUser);
    expect(stored.token).toBe('access-123');
    expect(stored.refreshToken).toBe('refresh-456');
  });

  it('should clear auth state on sign out', async () => {
    mockFetchSequence([{ body: currentUserResponse }]);
    const auth = new AuthModule(APP_ID, IAM_URL);
    auth.setSession({ accessToken: 'access-123', refreshToken: 'refresh-456' });
    await auth.checkAuth();

    auth.signOut();

    expect(auth.currentUser).toBeNull();
    expect(auth.accessToken).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('should redirect on sign out when redirectUrl is provided', async () => {
    const locationMock = { href: '' };
    vi.stubGlobal('window', { location: locationMock });

    const auth = new AuthModule(APP_ID, IAM_URL);
    auth.signOut('/login');

    expect(locationMock.href).toBe('/login');
  });

  it('should refresh session and update tokens', async () => {
    // First sign in to have a refresh token
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'old-access',
      refreshToken: 'old-refresh',
    });

    const newTokenResponse = { accessToken: 'new-access', refreshToken: 'new-refresh', tokenType: 'Bearer' };
    const fetchMock = mockFetchSequence([{ body: newTokenResponse }]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const result = await auth.refreshSession();

    expect(result).toBe(true);
    expect(auth.accessToken).toBe('new-access');
    expect(auth.currentUser).toEqual(fakeUser);
    expect(JSON.parse(storage._store[STORAGE_KEY])).toMatchObject({
      user: fakeUser,
      token: 'new-access',
      refreshToken: 'new-refresh',
    });

    // Verify refresh call
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${IAM_URL}/api/v1/auth/refresh-token`);
    expect(JSON.parse(options.body)).toEqual({ refreshToken: 'old-refresh' });
  });

  it('should deduplicate concurrent refresh calls', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'old-access',
      refreshToken: 'old-refresh',
    });

    const fetchMock = mockFetchSequence([
      { body: { accessToken: 'new', refreshToken: 'new-r', tokenType: 'Bearer' } },
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);

    const [r1, r2] = await Promise.all([
      auth.refreshSession(),
      auth.refreshSession(),
    ]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('should return false when refreshing without a refresh token', async () => {
    const auth = new AuthModule(APP_ID, IAM_URL);
    const result = await auth.refreshSession();
    expect(result).toBe(false);
  });

  it('should clear auth state when refresh fails', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'old-access',
      refreshToken: 'old-refresh',
    });

    mockFetchSequence([
      { body: { message: 'Invalid token' }, status: 401 },
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const result = await auth.refreshSession();

    expect(result).toBe(false);
    expect(auth.currentUser).toBeNull();
    expect(auth.accessToken).toBeNull();
  });

  it('should rotate tokens without fetching me or notifying public auth listeners', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'old-access',
      refreshToken: 'old-refresh',
    });
    const fetchMock = mockFetchSequence([{ body: fakeTokenResponse }]);
    const auth = new AuthModule(APP_ID, IAM_URL);
    const listener = vi.fn();
    const sessionListener = vi.fn();
    auth.onAuthStateChange(listener);
    getAuthSessionPort(auth).onSessionChange(sessionListener);

    await expect(auth.refreshSession()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.currentUser).toEqual(fakeUser);
    expect(listener.mock.calls).toEqual([[fakeUser]]);
    expect(sessionListener).toHaveBeenCalledWith({
      token: fakeTokenResponse.accessToken,
      refreshToken: fakeTokenResponse.refreshToken,
    });
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('should refresh proactively when the access token is inside the default skew', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    storedSession(
      storage,
      jwt({ app_id: APP_ID, exp: nowSeconds + 29 }),
      jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
    );
    const fetchMock = mockFetchSequence([{
      body: {
        accessToken: jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
        refreshToken: jwt({ app_id: APP_ID, exp: nowSeconds + 7_200 }),
        tokenType: 'Bearer',
      },
    }]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.ensureFreshSession()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('should not restore a session when sign out wins an in-flight proactive refresh', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    storedSession(
      storage,
      jwt({ app_id: APP_ID, exp: nowSeconds - 1 }),
      jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
    );
    const pendingRefresh = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pendingRefresh.promise);
    vi.stubGlobal('fetch', fetchMock);
    const auth = new AuthModule(APP_ID, IAM_URL);
    const sessionListener = vi.fn();
    getAuthSessionPort(auth).onSessionChange(sessionListener);

    const refreshing = auth.ensureFreshSession();
    auth.signOut();
    pendingRefresh.resolve(jsonResponse({
      accessToken: jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
      refreshToken: jwt({ app_id: APP_ID, exp: nowSeconds + 7_200 }),
      tokenType: 'Bearer',
    }));

    await expect(refreshing).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.accessToken).toBeNull();
    expect(auth.currentUser).toBeNull();
    expect(storage._store[STORAGE_KEY]).toBeUndefined();
    expect(sessionListener.mock.calls).toEqual([[{ token: null, refreshToken: null }]]);
  });

  it('should not let an old refresh overwrite a newer adopted session', async () => {
    storedSession(storage, 'old-access', 'old-refresh');
    const pendingRefresh = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(pendingRefresh.promise)
      .mockResolvedValueOnce(jsonResponse(currentUserResponse));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new AuthModule(APP_ID, IAM_URL);

    const oldRefresh = auth.refreshSession();
    expect(auth.setSession({
      accessToken: 'login-access',
      refreshToken: 'login-refresh',
    })).toBe(true);
    await expect(auth.me()).resolves.toEqual(apiUser);
    pendingRefresh.resolve(jsonResponse({
      accessToken: 'late-old-access',
      refreshToken: 'late-old-refresh',
      tokenType: 'Bearer',
    }));

    await expect(oldRefresh).resolves.toBe(false);
    expect(auth.accessToken).toBe('login-access');
    expect(auth.currentUser).toEqual(apiUser);
    expect(JSON.parse(storage._store[STORAGE_KEY])).toMatchObject({
      token: 'login-access',
      refreshToken: 'login-refresh',
      user: apiUser,
    });
  });

  it.each([
    ['success', 200],
    ['definitive failure', 401],
  ])('should ignore an old refresh %s after adopting a newer session', async (_label, status) => {
    storedSession(storage, 'old-access', 'old-refresh');
    const pendingRefresh = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingRefresh.promise));
    const auth = new AuthModule(APP_ID, IAM_URL);

    const oldRefresh = auth.refreshSession();
    getAuthSessionPort(auth).adoptSession({ token: 'adopted-access', refreshToken: 'adopted-refresh' });
    pendingRefresh.resolve(jsonResponse(
      status === 200
        ? {
            accessToken: 'late-old-access',
            refreshToken: 'late-old-refresh',
            tokenType: 'Bearer',
          }
        : { message: 'Old refresh rejected' },
      status,
    ));

    await expect(oldRefresh).resolves.toBe(false);
    expect(auth.accessToken).toBe('adopted-access');
    expect(auth.currentUser).toEqual(fakeUser);
    expect(JSON.parse(storage._store[STORAGE_KEY])).toMatchObject({
      token: 'adopted-access',
      refreshToken: 'adopted-refresh',
      user: fakeUser,
    });
  });

  it('should start and deduplicate a new-session refresh while the old flight is pending', async () => {
    storedSession(storage, 'old-access', 'old-refresh');
    const oldPendingRefresh = deferred<Response>();
    const newPendingRefresh = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldPendingRefresh.promise)
      .mockReturnValueOnce(newPendingRefresh.promise);
    vi.stubGlobal('fetch', fetchMock);
    const auth = new AuthModule(APP_ID, IAM_URL);

    const oldRefresh = auth.refreshSession();
    getAuthSessionPort(auth).adoptSession({ token: 'adopted-access', refreshToken: 'adopted-refresh' });
    const newRefreshes = Promise.all([auth.refreshSession(), auth.refreshSession()]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    oldPendingRefresh.resolve(jsonResponse({
      accessToken: 'late-old-access',
      refreshToken: 'late-old-refresh',
      tokenType: 'Bearer',
    }));
    await expect(oldRefresh).resolves.toBe(false);

    newPendingRefresh.resolve(jsonResponse({
      accessToken: 'newest-access',
      refreshToken: 'newest-refresh',
      tokenType: 'Bearer',
    }));
    await expect(newRefreshes).resolves.toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.accessToken).toBe('newest-access');
    expect(JSON.parse(storage._store[STORAGE_KEY])).toMatchObject({
      token: 'newest-access',
      refreshToken: 'newest-refresh',
    });
  });

  it.each([
    ['outside the skew', Math.floor(Date.now() / 1000) + 60],
    ['without exp', undefined],
    ['with a nonnumeric exp', 'soon'],
  ])('should not refresh a scoped JWT %s', async (_label, exp) => {
    const payload = exp === undefined ? { app_id: APP_ID } : { app_id: APP_ID, exp };
    storedSession(storage, jwt(payload), jwt({ app_id: APP_ID }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.ensureFreshSession()).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['opaque-token', 'malformed.jwt'])('should leave %s server-authoritative', async (token) => {
    storedSession(storage, token, 'opaque-refresh');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.ensureFreshSession()).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.accessToken).toBe(token);
  });

  it('should refresh expired tokens and deduplicate proactive callers', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    storedSession(
      storage,
      jwt({ app_id: APP_ID, exp: nowSeconds - 1 }),
      jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
    );
    let resolveRefresh!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new AuthModule(APP_ID, IAM_URL);

    const results = Promise.all([
      auth.ensureFreshSession(),
      auth.ensureFreshSession(),
      auth.refreshSession(),
    ]);
    resolveRefresh(new Response(JSON.stringify({
      accessToken: jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
      refreshToken: jwt({ app_id: APP_ID, exp: nowSeconds + 7_200 }),
      tokenType: 'Bearer',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(results).resolves.toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('should honor a custom minimum validity and validate its boundary', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    storedSession(
      storage,
      jwt({ app_id: APP_ID, exp: nowSeconds + 60 }),
      jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
    );
    const fetchMock = mockFetchSequence([{
      body: {
        accessToken: jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
        refreshToken: jwt({ app_id: APP_ID, exp: nowSeconds + 7_200 }),
        tokenType: 'Bearer',
      },
    }]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.ensureFreshSession(61_000)).resolves.toBe(true);
    await expect(auth.ensureFreshSession(-1)).rejects.toThrow(RangeError);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([408, 429, 500, 503])(
    'should preserve the current session on transient refresh status %i',
    async (status) => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const accessToken = jwt({ app_id: APP_ID, exp: nowSeconds - 1 });
      storedSession(storage, accessToken, jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }));
      mockFetchSequence([{ body: { message: 'Try later' }, status }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.ensureFreshSession()).resolves.toBe(false);

      expect(auth.currentUser).toEqual(fakeUser);
      expect(auth.accessToken).toBe(accessToken);
      expect(storage.removeItem).not.toHaveBeenCalled();
    },
  );

  it('should preserve the current session on a network refresh failure', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const accessToken = jwt({ app_id: APP_ID, exp: nowSeconds - 1 });
    storedSession(storage, accessToken, jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.ensureFreshSession()).resolves.toBe(false);

    expect(auth.currentUser).toEqual(fakeUser);
    expect(auth.accessToken).toBe(accessToken);
  });

  it('should notify logout listeners only once when me and refresh both reject the session', async () => {
    storedSession(storage, 'opaque-access', 'opaque-refresh');
    mockFetchSequence([
      { body: { message: 'Expired' }, status: 401 },
      { body: { message: 'Invalid refresh' }, status: 401 },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL);
    const listener = vi.fn();
    auth.onAuthStateChange(listener);

    await expect(auth.me()).resolves.toBeNull();

    expect(listener.mock.calls).toEqual([[fakeUser], [null]]);
    expect(storage.removeItem).toHaveBeenCalledOnce();
  });

  it.each(['network', '5xx'])(
    'should preserve the retained session when me reaches 401 after %s refresh failures',
    async (failure) => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const accessToken = jwt({ app_id: APP_ID, exp: nowSeconds - 1 });
      const refreshToken = jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 });
      storedSession(storage, accessToken, refreshToken);
      const transient = failure === 'network'
        ? () => Promise.reject(new TypeError('offline'))
        : () => Promise.resolve(jsonResponse({ message: 'Unavailable' }, 503));
      const fetchMock = vi.fn()
        .mockImplementationOnce(transient)
        .mockResolvedValueOnce(jsonResponse({ message: 'Expired' }, 401))
        .mockImplementationOnce(transient);
      vi.stubGlobal('fetch', fetchMock);
      const auth = new AuthModule(APP_ID, IAM_URL);
      const listener = vi.fn();
      auth.onAuthStateChange(listener);

      await expect(auth.me()).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(auth.accessToken).toBe(accessToken);
      expect(auth.currentUser).toEqual(fakeUser);
      expect(JSON.parse(storage._store[STORAGE_KEY])).toMatchObject({
        token: accessToken,
        refreshToken,
        user: fakeUser,
      });
      expect(listener.mock.calls).toEqual([[fakeUser]]);
    },
  );

  it.each([
    ['success', 200],
    ['definitive failure', 401],
  ])('should not let a reactive old refresh %s clear an adopted session', async (_label, status) => {
    storedSession(storage, 'old-access', 'old-refresh');
    const pendingRefresh = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'Expired' }, 401))
      .mockReturnValueOnce(pendingRefresh.promise);
    vi.stubGlobal('fetch', fetchMock);
    const auth = new AuthModule(APP_ID, IAM_URL);

    const currentUser = auth.me();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    getAuthSessionPort(auth).adoptSession({ token: 'adopted-access', refreshToken: 'adopted-refresh' });
    pendingRefresh.resolve(jsonResponse(
      status === 200
        ? {
            accessToken: 'late-old-access',
            refreshToken: 'late-old-refresh',
            tokenType: 'Bearer',
          }
        : { message: 'Old refresh rejected' },
      status,
    ));

    await expect(currentUser).resolves.toBeNull();
    expect(auth.accessToken).toBe('adopted-access');
    expect(auth.currentUser).toEqual(fakeUser);
    expect(JSON.parse(storage._store[STORAGE_KEY])).toMatchObject({
      token: 'adopted-access',
      refreshToken: 'adopted-refresh',
      user: fakeUser,
    });
  });

  it('should refresh before the authenticated me request', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const newAccess = jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 });
    storedSession(
      storage,
      jwt({ app_id: APP_ID, exp: nowSeconds - 1 }),
      jwt({ app_id: APP_ID, exp: nowSeconds + 7_200 }),
    );
    const fetchMock = mockFetchSequence([
      {
        body: {
          accessToken: newAccess,
          refreshToken: jwt({ app_id: APP_ID, exp: nowSeconds + 7_200 }),
          tokenType: 'Bearer',
        },
      },
      { body: currentUserResponse },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.me()).resolves.toEqual(apiUser);

    expect(fetchMock.mock.calls[0][0]).toBe(`${IAM_URL}/api/v1/auth/refresh-token`);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${newAccess}`);
  });

  it.each([400, 401, 403, 404, 422])(
    'should clear the current session on definitive refresh status %i',
    async (status) => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      storedSession(
        storage,
        jwt({ app_id: APP_ID, exp: nowSeconds - 1 }),
        jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
      );
      mockFetchSequence([{ body: { message: 'Rejected' }, status }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.ensureFreshSession()).resolves.toBe(false);

      expect(auth.currentUser).toBeNull();
      expect(auth.accessToken).toBeNull();
      expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    },
  );

  it.each([
    ['access', jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 }), jwt({ app_id: APP_ID })],
    ['refresh', jwt({ app_id: APP_ID }), jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 })],
    ['empty app scope', jwt({ app_id: ' ' }), jwt({ app_id: APP_ID })],
    ['foreign access app', jwt({ app_id: 'other-app' }), jwt({ app_id: APP_ID })],
    ['foreign refresh app', jwt({ app_id: APP_ID }), jwt({ app_id: 'other-app' })],
  ])('should reject a decodable stored %s token outside the configured app', async (
    _label,
    token,
    refreshToken
  ) => {
    storedSession(storage, token, refreshToken);

    const auth = new AuthModule(APP_ID, IAM_URL);

    expect(auth.currentUser).toBeNull();
    expect(auth.accessToken).toBeNull();
    await expect(auth.ensureFreshSession()).resolves.toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it.each([
    [
      'with access token without app scope',
      jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 }),
      jwt({ app_id: APP_ID, exp: Math.floor(Date.now() / 1000) + 7_200 }),
    ],
    [
      'with access token for another app',
      jwt({ app_id: 'other-app', exp: Math.floor(Date.now() / 1000) + 3_600 }),
      jwt({ app_id: APP_ID, exp: Math.floor(Date.now() / 1000) + 7_200 }),
    ],
    [
      'with refresh token for another app',
      jwt({ app_id: APP_ID, exp: Math.floor(Date.now() / 1000) + 3_600 }),
      jwt({ app_id: 'other-app', exp: Math.floor(Date.now() / 1000) + 7_200 }),
    ],
  ])('should reject and clear a refreshed session %s', async (
    _label,
    refreshedAccess,
    refreshedRefresh
  ) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    storedSession(
      storage,
      jwt({ app_id: APP_ID, exp: nowSeconds - 1 }),
      jwt({ app_id: APP_ID, exp: nowSeconds + 3_600 }),
    );
    mockFetchSequence([{
      body: {
        accessToken: refreshedAccess,
        refreshToken: refreshedRefresh,
        tokenType: 'Bearer',
      },
    }]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.ensureFreshSession()).resolves.toBe(false);

    expect(auth.accessToken).toBeNull();
    expect(auth.currentUser).toBeNull();
  });

  it('should reject a token for another app set manually', () => {
    storedSession(storage, 'old-opaque-access', 'old-opaque-refresh');
    const auth = new AuthModule(APP_ID, IAM_URL);

    auth.setToken(jwt({
      app_id: 'other-app',
      exp: Math.floor(Date.now() / 1000) + 3_600,
    }));

    expect(auth.accessToken).toBeNull();
    expect(auth.currentUser).toBeNull();
  });

  it('should reject an adopted bridge session with a token for another app', () => {
    storedSession(storage, 'old-opaque-access', 'old-opaque-refresh');
    const auth = new AuthModule(APP_ID, IAM_URL);

    getAuthSessionPort(auth).adoptSession({
      token: jwt({ app_id: 'other-app' }),
      refreshToken: jwt({ app_id: APP_ID }),
    });

    expect(auth.accessToken).toBeNull();
    expect(auth.currentUser).toBeNull();
  });

  it('should fetch current user via me()', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'access-123',
      refreshToken: 'refresh-456',
    });

    const updatedResponse = { ...currentUserResponse, name: 'Updated Name' };
    const updatedUser = { ...updatedResponse, tenantId: 't1' };
    mockFetchSequence([{ body: updatedResponse }]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const user = await auth.me();

    expect(user).toEqual(updatedUser);
    expect(auth.currentUser).toEqual(updatedUser);
  });

  it('should clear auth state when me() returns 401', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'expired-token',
      refreshToken: null,
    });

    mockFetchSequence([
      { body: { message: 'Unauthorized' }, status: 401 },
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const user = await auth.me();

    expect(user).toBeNull();
    expect(auth.currentUser).toBeNull();
    expect(auth.accessToken).toBeNull();
  });

  it('should report isAuthenticated correctly', async () => {
    const auth = new AuthModule(APP_ID, IAM_URL);
    expect(auth.isAuthenticated).toBe(false);

    mockFetchSequence([{ body: currentUserResponse }]);
    auth.setSession({ accessToken: 'access-123', refreshToken: 'refresh-456' });
    await auth.checkAuth();
    expect(auth.isAuthenticated).toBe(true);
  });

  it('should load auth state from localStorage on construction', () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'stored-token',
      refreshToken: 'stored-refresh',
    });

    const auth = new AuthModule(APP_ID, IAM_URL);

    expect(auth.currentUser).toEqual(fakeUser);
    expect(auth.accessToken).toBe('stored-token');
    expect(auth.isAuthenticated).toBe(true);
  });

  it('should validate session via checkAuth()', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'access-123',
      refreshToken: 'refresh-456',
    });

    mockFetchSequence([{ body: currentUserResponse }]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const valid = await auth.checkAuth();

    expect(valid).toBe(true);
  });

  it('should return false from checkAuth() when not authenticated', async () => {
    const auth = new AuthModule(APP_ID, IAM_URL);
    const valid = await auth.checkAuth();
    expect(valid).toBe(false);
  });

  it('should set token manually via setToken()', () => {
    const auth = new AuthModule(APP_ID, IAM_URL);

    auth.setToken('manual-token');

    expect(auth.accessToken).toBe('manual-token');
    expect(storage.setItem).toHaveBeenCalled();
  });

  it('should set token without saving to storage when saveToStorage is false', () => {
    const auth = new AuthModule(APP_ID, IAM_URL);

    auth.setToken('manual-token', false);

    expect(auth.accessToken).toBe('manual-token');
    // setItem should not have been called (only the constructor loadFromStorage call)
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('should redirect to login with encoded returnUrl', () => {
    const locationMock = { href: '' };
    vi.stubGlobal('window', { location: locationMock });

    const auth = new AuthModule(APP_ID, IAM_URL);
    auth.redirectToLogin('/dashboard?tab=1');

    expect(locationMock.href).toBe('/login?returnUrl=%2Fdashboard%3Ftab%3D1');
  });

  it('should use default returnUrl when none provided', () => {
    const locationMock = { href: '' };
    vi.stubGlobal('window', { location: locationMock });

    const auth = new AuthModule(APP_ID, IAM_URL);
    auth.redirectToLogin();

    expect(locationMock.href).toBe('/login?returnUrl=%2F');
  });

  it('should call onAuthStateChange listener immediately and after session hydration', async () => {
    const auth = new AuthModule(APP_ID, IAM_URL);
    const listener = vi.fn();

    auth.onAuthStateChange(listener);

    // Called immediately with null (not authenticated)
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);

    mockFetchSequence([{ body: currentUserResponse }]);
    auth.setSession({ accessToken: 'access-123', refreshToken: 'refresh-456' });
    await auth.checkAuth();

    // Called again with the user
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(apiUser);
  });

  it('should unsubscribe listener when unsub function is called', async () => {
    const auth = new AuthModule(APP_ID, IAM_URL);
    const listener = vi.fn();

    const unsub = auth.onAuthStateChange(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();

    mockFetchSequence([{ body: currentUserResponse }]);
    auth.setSession({ accessToken: 'access-123', refreshToken: 'refresh-456' });
    await auth.checkAuth();

    // Should NOT have been called again after unsubscribe
    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe('allTokens', () => {
    it('should expose and persist the three families returned at login', async () => {
      const browser = mockBrowser();
      mockFetchSequence([
        { body: { ...fakeTokenResponse, allTokens: fakeAllTokens } },
        { body: currentUserResponse },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const signIn = auth.signInWithEmail();
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

      await expect(signIn).resolves.toEqual(apiUser);
      expect(auth.allTokens).toEqual(fakeAllTokens);
      expect(storedAllTokens(browser.localStorage)).toEqual(fakeAllTokens);
    });

    it('should drop the tokens of the previous session when the next login has none', async () => {
      const browser = mockBrowser();
      storedSessionWithAllTokens(browser.localStorage);
      mockFetchSequence([{ body: fakeTokenResponse }, { body: currentUserResponse }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
      expect(auth.allTokens).toEqual(fakeAllTokens);

      const signIn = auth.signInWithEmail();
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

      await expect(signIn).resolves.toEqual(apiUser);
      expect(auth.allTokens).toBeNull();
      expect(JSON.parse(browser.localStorage._store[STORAGE_KEY])).not.toHaveProperty('allTokens');
    });

    it('should read no tokens when the login response carries none of them', async () => {
      const browser = mockBrowser();
      mockFetchSequence([
        { body: { ...fakeTokenResponse, allTokens: { platform: null, mitraSpace: null, b2bToken: null } } },
        { body: currentUserResponse },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const signIn = auth.signInWithEmail();
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

      await expect(signIn).resolves.toEqual(apiUser);
      expect(auth.allTokens).toBeNull();
      expect(JSON.parse(browser.localStorage._store[STORAGE_KEY])).not.toHaveProperty('allTokens');
    });

    it.each([
      ['a session stored before the field existed', () => storedSession(storage, 'old-access', 'old-refresh')],
      ['malformed stored tokens', () => storedSessionWithAllTokens(storage, 'not-an-object')],
    ])('should still load %s, without extra tokens', (_case, store) => {
      store();

      const auth = new AuthModule(APP_ID, IAM_URL);

      expect(auth.allTokens).toBeNull();
      expect(auth.accessToken).toBe('old-access');
    });

    it('should load a session stored before b2bToken existed', () => {
      storedSessionWithAllTokens(storage, {
        platform: fakeAllTokens.platform,
        mitraSpace: fakeAllTokens.mitraSpace,
      });

      const auth = new AuthModule(APP_ID, IAM_URL);

      expect(auth.allTokens).toEqual({ ...fakeAllTokens, b2bToken: null });
    });

    it('should take platform from the refresh and keep mitraSpace and b2bToken from login', async () => {
      storedSessionWithAllTokens(storage);
      mockFetchSequence([{
        body: {
          ...fakeTokenResponse,
          allTokens: { platform: rotatedPlatform, mitraSpace: null, b2bToken: null },
        },
      }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(true);

      const merged = { ...fakeAllTokens, platform: rotatedPlatform };
      expect(auth.allTokens).toEqual(merged);
      expect(storedAllTokens(storage)).toEqual(merged);
    });

    it('should replace mitraSpace and b2bToken when a refresh carries them', async () => {
      storedSessionWithAllTokens(storage);
      const incoming = {
        platform: rotatedPlatform,
        mitraSpace: { token: 'new-space-token', tokenType: 'Bearer' },
        b2bToken: { accessToken: 'new-peer-access', refreshToken: 'new-peer-refresh', tokenType: 'Bearer' },
      };
      mockFetchSequence([{ body: { ...fakeTokenResponse, allTokens: incoming } }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(true);

      expect(auth.allTokens).toEqual(incoming);
    });

    it('should drop platform when the refresh reports none', async () => {
      storedSessionWithAllTokens(storage);
      mockFetchSequence([{
        body: { ...fakeTokenResponse, allTokens: { platform: null, mitraSpace: null, b2bToken: null } },
      }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(true);

      expect(auth.allTokens).toEqual({ ...fakeAllTokens, platform: null });
    });

    it.each([
      ['omits the field', fakeTokenResponse],
      ['carries a field that is not an object', { ...fakeTokenResponse, allTokens: 'not-an-object' }],
    ])('should clear the tokens when the refresh %s', async (_case, body) => {
      storedSessionWithAllTokens(storage);
      mockFetchSequence([{ body }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(true);

      expect(auth.accessToken).toBe('access-123');
      expect(auth.allTokens).toBeNull();
      expect(JSON.parse(storage._store[STORAGE_KEY])).not.toHaveProperty('allTokens');
    });

    it('should read no tokens once a refresh leaves none of them', async () => {
      storedSessionWithAllTokens(storage, { platform: fakeAllTokens.platform, mitraSpace: null, b2bToken: null });
      mockFetchSequence([{
        body: { ...fakeTokenResponse, allTokens: { platform: null, mitraSpace: null, b2bToken: null } },
      }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(true);

      expect(auth.allTokens).toBeNull();
      expect(JSON.parse(storage._store[STORAGE_KEY])).not.toHaveProperty('allTokens');
    });

    it('should not let a write into the returned tokens reach storage', () => {
      storedSessionWithAllTokens(storage);
      const auth = new AuthModule(APP_ID, IAM_URL);
      const renewedPair = { accessToken: 'renewed-access', refreshToken: 'renewed-refresh', tokenType: 'Bearer' };
      const tokens = auth.allTokens as { b2bToken: unknown };
      const b2bToken = auth.allTokens?.b2bToken as { accessToken: string };

      expect(() => { tokens.b2bToken = renewedPair; }).toThrow(TypeError);
      expect(() => { b2bToken.accessToken = 'renewed-access'; }).toThrow(TypeError);
      getAuthSessionPort(auth).rotateSession({ token: 'rotated-access', refreshToken: 'rotated-refresh' });

      expect(auth.allTokens).toEqual(fakeAllTokens);
      expect(storedAllTokens(storage)).toEqual(fakeAllTokens);
    });

    it('should drop the tokens of the replaced session on setSession', () => {
      storedSessionWithAllTokens(storage);
      const auth = new AuthModule(APP_ID, IAM_URL);

      expect(auth.setSession({ accessToken: 'adopted-access', refreshToken: 'adopted-refresh' })).toBe(true);

      expect(auth.allTokens).toBeNull();
      expect(storedAllTokens(storage)).toBeUndefined();
    });

    it('should drop the tokens of the replaced session on setToken', () => {
      storedSessionWithAllTokens(storage);
      const auth = new AuthModule(APP_ID, IAM_URL);

      auth.setToken('manual-token');

      expect(auth.allTokens).toBeNull();
      expect(storedAllTokens(storage)).toBeUndefined();
    });

    it('should drop the tokens of the replaced session on an api key sign-in', async () => {
      storedSessionWithAllTokens(storage);
      mockFetchSequence([
        { body: { accessToken: 'api-key-access', refreshToken: null, tokenType: 'Bearer' } },
        { body: currentUserResponse },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await auth.signInWithApiKey('test-api-key');

      expect(auth.accessToken).toBe('api-key-access');
      expect(auth.allTokens).toBeNull();
    });

    it('should keep the tokens when another issuer rotates the same session', () => {
      storedSessionWithAllTokens(storage);
      const auth = new AuthModule(APP_ID, IAM_URL);

      expect(getAuthSessionPort(auth).rotateSession({ token: 'rotated-access', refreshToken: 'rotated-refresh' }))
        .toBe(true);

      expect(auth.accessToken).toBe('rotated-access');
      expect(auth.allTokens).toEqual(fakeAllTokens);
      expect(storedAllTokens(storage)).toEqual(fakeAllTokens);
    });

    it('should clear the tokens when a rotated session belongs to another app', () => {
      storedSessionWithAllTokens(storage);
      const auth = new AuthModule(APP_ID, IAM_URL);

      expect(getAuthSessionPort(auth).rotateSession({ token: jwt({ app_id: 'other-app' }) })).toBe(false);

      expect(auth.allTokens).toBeNull();
      expect(storage._store[STORAGE_KEY]).toBeUndefined();
    });

    it('should clear the tokens on sign out', () => {
      storedSessionWithAllTokens(storage);
      const auth = new AuthModule(APP_ID, IAM_URL);

      auth.signOut();

      expect(auth.allTokens).toBeNull();
      expect(storage._store[STORAGE_KEY]).toBeUndefined();
    });
  });

  describe('email sign-in', () => {
    it('should exchange the popup code at the magic link route and hydrate the session', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([
        { body: fakeTokenResponse },
        { body: currentUserResponse },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const signIn = auth.signInWithEmail({ mode: 'popup' });
      const startUrl = browser.getStartUrl();
      const state = startUrl.searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

      await expect(signIn).resolves.toEqual(apiUser);
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
      expect(auth.currentUser).toEqual(apiUser);
      expect(JSON.parse(browser.localStorage._store[STORAGE_KEY])).toEqual({
        user: apiUser,
        token: 'access-123',
        refreshToken: 'refresh-456',
      });
    });

    it('should refuse an exchanged token issued for another app before persisting or hydrating', async () => {
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
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

      await expect(signIn).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(auth.accessToken).toBeNull();
      expect(browser.localStorage._store[STORAGE_KEY]).toBeUndefined();
    });

    it('should surface the IAM error code when the exchange code is refused', async () => {
      const browser = mockBrowser();
      mockFetchSequence([{
        status: 401,
        body: { message: 'Invalid exchange code', error_code: 'INVALID_EXCHANGE_CODE' },
      }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const signIn = auth.signInWithEmail();
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'used-code' }));

      await expect(signIn).rejects.toMatchObject({
        name: 'MitraApiError',
        status: 401,
        code: 'INVALID_EXCHANGE_CODE',
        message: 'Invalid exchange code',
      });
      expect(auth.accessToken).toBeNull();
    });

    it('should validate the exchange response with the same contract as the SSO exchange', async () => {
      const browser = mockBrowser();
      mockFetchSequence([{ body: { accessToken: 'access-123', tokenType: 'Bearer' } }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const signIn = auth.signInWithEmail();
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

      await expect(signIn).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('should require browser APIs', async () => {
      vi.stubGlobal('window', undefined);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(auth.signInWithEmail()).rejects.toThrow('only available in a browser');
      await expect(auth.completeEmailSignInRedirect()).rejects.toThrow(
        'only available in a browser'
      );
    });
  });
});
