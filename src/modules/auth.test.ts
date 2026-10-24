import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthModule, getAuthSessionPort } from './auth';
import {
  MOCK_API_URL as API_URL,
  authPageResult,
  mockBrowser,
  mockFetchSequence,
  mockLocalStorage,
  type BrowserHarness,
} from '../test-utils';

const APP_ID = 'test-app';
const IAM_URL = `${API_URL}/iam`;
const AUTH_PAGE_URL = `${API_URL}/sdk-auth.html`;
const EXCHANGE_URL = `${IAM_URL}/api/v1/auth/magic-link/exchange`;
const STORAGE_KEY = `mitra_auth_${APP_ID}`;
const exclusiveRefresh = jwt({ app_id: APP_ID, login_mode: 'exclusive', sid: 'session-1' });

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
  backoffice: { accessToken: 'backoffice-access', tokenType: 'Bearer', expiresIn: 3600 },
};
const noAllTokens = { platform: null, mitraSpace: null, b2bToken: null, backoffice: null };
const rotatedPlatform = {
  accessToken: 'new-session-access',
  refreshToken: 'new-session-refresh',
  tokenType: 'Bearer',
};
const rotatedBackoffice = {
  accessToken: 'new-backoffice-access',
  tokenType: 'Bearer',
  expiresIn: 3600,
};

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

/** A backoffice token whose access expires `inSeconds` from now, negative for expired. */
function backofficeToken(inSeconds: number, accessToken = 'backoffice-access') {
  return {
    accessToken: jwt({ sub: 'u1', exp: Math.floor(Date.now() / 1_000) + inSeconds, jti: accessToken }),
    tokenType: 'Bearer',
    expiresIn: 3600,
  };
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
  token = 'old-access',
): void {
  storage._store[STORAGE_KEY] = JSON.stringify({
    user: fakeUser,
    token,
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
    it('should expose and persist the four families returned at login', async () => {
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
        { body: { ...fakeTokenResponse, allTokens: noAllTokens } },
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

    it('should load a session stored before b2bToken and backoffice existed', () => {
      storedSessionWithAllTokens(storage, {
        platform: fakeAllTokens.platform,
        mitraSpace: fakeAllTokens.mitraSpace,
      });

      const auth = new AuthModule(APP_ID, IAM_URL);

      expect(auth.allTokens).toEqual({ ...fakeAllTokens, b2bToken: null, backoffice: null });
    });

    it('should keep the field when backoffice is the only family IAM sent', async () => {
      const browser = mockBrowser();
      const allTokens = { ...noAllTokens, backoffice: fakeAllTokens.backoffice };
      mockFetchSequence([
        { body: { ...fakeTokenResponse, allTokens } },
        { body: currentUserResponse },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const signIn = auth.signInWithEmail();
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

      await expect(signIn).resolves.toEqual(apiUser);
      expect(auth.allTokens).toEqual(allTokens);
      expect(storedAllTokens(browser.localStorage)).toEqual(allTokens);
    });

    it('should take platform and backoffice from the refresh and keep mitraSpace and b2bToken from login', async () => {
      storedSessionWithAllTokens(storage);
      mockFetchSequence([{
        body: {
          ...fakeTokenResponse,
          allTokens: {
            platform: rotatedPlatform,
            mitraSpace: null,
            b2bToken: null,
            backoffice: rotatedBackoffice,
          },
        },
      }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(true);

      const merged = { ...fakeAllTokens, platform: rotatedPlatform, backoffice: rotatedBackoffice };
      expect(auth.allTokens).toEqual(merged);
      expect(storedAllTokens(storage)).toEqual(merged);
    });

    it('should replace mitraSpace and b2bToken when a refresh carries them', async () => {
      storedSessionWithAllTokens(storage);
      const incoming = {
        platform: rotatedPlatform,
        mitraSpace: { token: 'new-space-token', tokenType: 'Bearer' },
        b2bToken: { accessToken: 'new-peer-access', refreshToken: 'new-peer-refresh', tokenType: 'Bearer' },
        backoffice: rotatedBackoffice,
      };
      mockFetchSequence([{ body: { ...fakeTokenResponse, allTokens: incoming } }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(true);

      expect(auth.allTokens).toEqual(incoming);
    });

    it('should drop platform and backoffice when the refresh reports them as null', async () => {
      storedSessionWithAllTokens(storage);
      mockFetchSequence([{ body: { ...fakeTokenResponse, allTokens: noAllTokens } }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(true);

      expect(auth.allTokens).toEqual({ ...fakeAllTokens, platform: null, backoffice: null });
      expect(storedAllTokens(storage)).toEqual({ ...fakeAllTokens, platform: null, backoffice: null });
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
      storedSessionWithAllTokens(storage, { ...noAllTokens, platform: fakeAllTokens.platform });
      mockFetchSequence([{ body: { ...fakeTokenResponse, allTokens: noAllTokens } }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(true);

      expect(auth.allTokens).toBeNull();
      expect(JSON.parse(storage._store[STORAGE_KEY])).not.toHaveProperty('allTokens');
    });

    it('should clear the tokens in memory and in storage when the refresh is rejected', async () => {
      storedSessionWithAllTokens(storage);
      mockFetchSequence([{ body: { message: 'Invalid refresh' }, status: 401 }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(false);

      expect(auth.allTokens).toBeNull();
      expect(storage._store[STORAGE_KEY]).toBeUndefined();
    });

    it.each(['network', '5xx'])('should keep the tokens after a %s refresh failure', async (failure) => {
      storedSessionWithAllTokens(storage);
      vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(failure === 'network'
        ? () => Promise.reject(new TypeError('offline'))
        : () => Promise.resolve(jsonResponse({ message: 'Unavailable' }, 503))));
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.refreshSession()).resolves.toBe(false);

      expect(auth.allTokens).toEqual(fakeAllTokens);
      expect(storedAllTokens(storage)).toEqual(fakeAllTokens);
    });

    it('should not let a write into the returned tokens reach storage', () => {
      storedSessionWithAllTokens(storage, fakeAllTokens, jwt({ app_id: APP_ID, sub: 'u1', iat: 1 }));
      const auth = new AuthModule(APP_ID, IAM_URL);
      const renewedPair = { accessToken: 'renewed-access', refreshToken: 'renewed-refresh', tokenType: 'Bearer' };
      const tokens = auth.allTokens as { b2bToken: unknown };
      const b2bToken = auth.allTokens?.b2bToken as { accessToken: string };

      expect(() => { tokens.b2bToken = renewedPair; }).toThrow(TypeError);
      expect(() => { b2bToken.accessToken = 'renewed-access'; }).toThrow(TypeError);
      getAuthSessionPort(auth).rotateSession({ token: jwt({ app_id: APP_ID, sub: 'u1', iat: 2 }) });

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
      storedSessionWithAllTokens(storage, fakeAllTokens, jwt({ app_id: APP_ID, sub: 'u1', iat: 1 }));
      const auth = new AuthModule(APP_ID, IAM_URL);
      const rotated = jwt({ app_id: APP_ID, sub: 'u1', iat: 2 });

      expect(getAuthSessionPort(auth).rotateSession({ token: rotated, refreshToken: 'rotated-refresh' }))
        .toBe(true);

      expect(auth.accessToken).toBe(rotated);
      expect(auth.allTokens).toEqual(fakeAllTokens);
      expect(storedAllTokens(storage)).toEqual(fakeAllTokens);
    });

    it.each([
      ['another person', jwt({ app_id: APP_ID, sub: 'u1' }), jwt({ app_id: APP_ID, sub: 'u2' })],
      ['an unreadable current token', 'old-access', jwt({ app_id: APP_ID, sub: 'u1' })],
      ['an unreadable rotated token', jwt({ app_id: APP_ID, sub: 'u1' }), 'rotated-access'],
      ['a token without a subject', jwt({ app_id: APP_ID, sub: 'u1' }), jwt({ app_id: APP_ID })],
    ])('should drop the tokens when a rotated session comes from %s', (_case, current, rotated) => {
      storedSessionWithAllTokens(storage, fakeAllTokens, current);
      const auth = new AuthModule(APP_ID, IAM_URL);

      expect(getAuthSessionPort(auth).rotateSession({ token: rotated })).toBe(true);

      expect(auth.accessToken).toBe(rotated);
      expect(auth.allTokens).toBeNull();
      expect(storedAllTokens(storage)).toBeUndefined();
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

  describe('ensureFreshBackofficeToken', () => {
    const REFRESH_URL = `${IAM_URL}/api/v1/auth/refresh-token`;

    function refreshWith(backoffice: unknown) {
      return mockFetchSequence([{
        body: { ...fakeTokenResponse, allTokens: { ...noAllTokens, backoffice } },
      }]);
    }

    it.each([
      ['has expired', -1],
      ['is inside the default margin', 45],
    ])('should refresh the app session when the backoffice token %s', async (_case, inSeconds) => {
      storedSessionWithAllTokens(storage, { ...fakeAllTokens, backoffice: backofficeToken(inSeconds) });
      const fresh = backofficeToken(3_600, 'fresh-backoffice');
      const fetchMock = refreshWith(fresh);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.ensureFreshBackofficeToken()).resolves.toEqual(fresh);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(REFRESH_URL);
    });

    it.each([
      ['far from expiry', backofficeToken(3_600)],
      ['opaque, so its expiry is unreadable', fakeAllTokens.backoffice],
    ])('should answer the token in hand when it is %s', async (_case, backoffice) => {
      storedSessionWithAllTokens(storage, { ...fakeAllTokens, backoffice });
      const fetchMock = mockFetchSequence([]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.ensureFreshBackofficeToken()).resolves.toEqual(backoffice);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject a margin that is not a finite positive number', async () => {
      storedSessionWithAllTokens(storage);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.ensureFreshBackofficeToken(-1)).rejects.toThrow(RangeError);
    });

    it.each([
      ['the session carries no extra tokens', () => storedSession(storage, 'old-access', 'old-refresh')],
      ['the app is not entitled to this one', () => storedSessionWithAllTokens(
        storage,
        { ...fakeAllTokens, backoffice: null },
      )],
    ])('should answer null without refreshing when %s', async (_case, store) => {
      store();
      const fetchMock = mockFetchSequence([]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.ensureFreshBackofficeToken()).resolves.toBeNull();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should answer null when the refresh reports the grant is gone', async () => {
      storedSessionWithAllTokens(storage, { ...fakeAllTokens, backoffice: backofficeToken(-1) });
      refreshWith(null);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.ensureFreshBackofficeToken()).resolves.toBeNull();

      expect(auth.allTokens).toEqual({ ...fakeAllTokens, platform: null, backoffice: null });
    });

    it('should answer the token in hand when the refresh fails transiently', async () => {
      const expiring = backofficeToken(-1);
      storedSessionWithAllTokens(storage, { ...fakeAllTokens, backoffice: expiring });
      mockFetchSequence([{ body: { message: 'Unavailable' }, status: 503 }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(auth.ensureFreshBackofficeToken()).resolves.toEqual(expiring);
    });

    it('should share one refresh between concurrent callers', async () => {
      storedSessionWithAllTokens(storage, { ...fakeAllTokens, backoffice: backofficeToken(-1) });
      const fresh = backofficeToken(3_600, 'fresh-backoffice');
      const fetchMock = refreshWith(fresh);
      const auth = new AuthModule(APP_ID, IAM_URL);

      await expect(Promise.all([
        auth.ensureFreshBackofficeToken(),
        auth.ensureFreshBackofficeToken(),
      ])).resolves.toEqual([fresh, fresh]);

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('should answer null when another person signs in while the refresh is in flight', async () => {
      const browser = mockBrowser();
      storedSessionWithAllTokens(browser.localStorage, {
        ...fakeAllTokens,
        backoffice: backofficeToken(-1),
      });
      const personB = backofficeToken(3_600, 'person-b-backoffice');
      const pendingRefresh = deferred<Response>();
      vi.stubGlobal('fetch', vi.fn()
        .mockReturnValueOnce(pendingRefresh.promise)
        .mockResolvedValueOnce(jsonResponse({
          ...fakeTokenResponse,
          allTokens: { ...noAllTokens, backoffice: personB },
        }))
        .mockResolvedValueOnce(jsonResponse(currentUserResponse)));
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const answering = auth.ensureFreshBackofficeToken();
      const signIn = auth.signInWithEmail();
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));
      await expect(signIn).resolves.toEqual(apiUser);
      pendingRefresh.resolve(jsonResponse({
        ...fakeTokenResponse,
        allTokens: { ...noAllTokens, backoffice: backofficeToken(3_600, 'person-a-backoffice') },
      }));

      await expect(answering).resolves.toBeNull();
      expect(auth.allTokens?.backoffice).toEqual(personB);
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

describe('AuthModule password methods', () => {
  const LOGOUT_URL = `${IAM_URL}/api/v1/auth/logout`;
  const RESET_URL = `${IAM_URL}/api/v1/auth/password/reset`;
  const sharedRefresh = jwt({ app_id: APP_ID });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sessionRequest(state: string) {
    return { type: 'mitra-auth-session-request', state };
  }

  /** Lets the async hand-over of the session reach `postMessage`. */
  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  describe('signInWithPassword and signUpWithPassword', () => {
    it.each([
      ['signInWithPassword', 'login'],
      ['signUpWithPassword', 'signup'],
    ] as const)('%s should open the password view %s and redeem the exchange code', async (method, view) => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([
        { body: fakeTokenResponse },
        { body: currentUserResponse },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const signIn = auth[method]();
      const startUrl = browser.getStartUrl();
      const state = startUrl.searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

      await expect(signIn).resolves.toEqual(apiUser);
      expect(startUrl.origin + startUrl.pathname).toBe(AUTH_PAGE_URL);
      expect(startUrl.searchParams.get('provider')).toBe('password');
      expect(startUrl.searchParams.get('view')).toBe(view);
      expect(startUrl.searchParams.get('origin')).toBe('https://app.example.com');
      expect(state.startsWith('password.')).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toBe(EXCHANGE_URL);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ appId: APP_ID, code: 'exchange-code' });
      expect(browser.popup.postMessage).not.toHaveBeenCalled();
    });

    it('should not hand the session to a login popup that asks for it', async () => {
      const browser = mockBrowser();
      storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
      mockFetchSequence([]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      void auth.signInWithPassword().catch(() => undefined);
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(sessionRequest(state));
      await flushMicrotasks();

      expect(browser.popup.postMessage).not.toHaveBeenCalled();
    });

    it('should refuse a popup on another view while one is open, without navigating it away', async () => {
      const browser = mockBrowser();
      mockFetchSequence([{ body: fakeTokenResponse }, { body: currentUserResponse }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const signIn = auth.signInWithPassword();
      await expect(auth.signUpWithPassword()).rejects.toThrow('Another Password popup is already open.');
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));

      await expect(signIn).resolves.toEqual(apiUser);
      expect(browser.window.open).toHaveBeenCalledOnce();
    });
  });

  describe('changePassword', () => {
    it('should refuse without a session before opening any popup', async () => {
      const browser = mockBrowser();
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(auth.changePassword()).rejects.toMatchObject({ name: 'MitraApiError', status: 401 });
      expect(browser.window.open).not.toHaveBeenCalled();
    });

    it('should hand the token over by postMessage only, and adopt the session the page signs in again with', async () => {
      const browser = mockBrowser();
      storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
      const fetchMock = mockFetchSequence([
        { body: { accessToken: 'access-new', refreshToken: 'refresh-new', tokenType: 'Bearer' } },
        { body: currentUserResponse },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const change = auth.changePassword();
      const startUrl = browser.getStartUrl();
      const state = startUrl.searchParams.get('state')!;
      expect(startUrl.searchParams.get('view')).toBe('change');
      expect(startUrl.toString()).not.toContain('access-123');

      browser.dispatchMessage(sessionRequest('password.forged'));
      browser.dispatchMessage(sessionRequest(state), { origin: 'https://evil.example.com' });
      browser.dispatchMessage(sessionRequest(state), { source: null });
      await flushMicrotasks();
      expect(browser.popup.postMessage).not.toHaveBeenCalled();

      browser.dispatchMessage(sessionRequest(state));
      await flushMicrotasks();
      expect(browser.popup.postMessage).toHaveBeenCalledExactlyOnceWith(
        { type: 'mitra-auth-session', state, accessToken: 'access-123' },
        API_URL
      );

      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));
      await expect(change).resolves.toEqual(apiUser);
      expect(fetchMock.mock.calls[0][0]).toBe(EXCHANGE_URL);
      expect(auth.accessToken).toBe('access-new');
      expect(JSON.parse(browser.localStorage._store[STORAGE_KEY]).refreshToken).toBe('refresh-new');
    });

    it('should renew a token close to expiry before handing it over', async () => {
      const browser = mockBrowser();
      const expiring = jwt({ app_id: APP_ID, exp: Math.floor(Date.now() / 1_000) + 10 });
      storedSession(browser.localStorage, expiring, exclusiveRefresh);
      const fetchMock = mockFetchSequence([
        { body: { accessToken: 'access-fresh', refreshToken: exclusiveRefresh, tokenType: 'Bearer' } },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      void auth.changePassword().catch(() => undefined);
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage(sessionRequest(state));
      await flushMicrotasks();

      expect(fetchMock.mock.calls[0][0]).toBe(`${IAM_URL}/api/v1/auth/refresh-token`);
      expect(browser.popup.postMessage).toHaveBeenCalledExactlyOnceWith(
        { type: 'mitra-auth-session', state, accessToken: 'access-fresh' },
        API_URL
      );
    });

    it.each([
      ['the result arrives', (browser: BrowserHarness, state: string) => {
        browser.dispatchMessage({ type: 'mitra-oauth-result', success: false, state, error: 'Cancelled' });
      }],
      ['the popup is closed', (browser: BrowserHarness) => {
        (browser.popup as { closed: boolean }).closed = true;
        vi.advanceTimersByTime(500);
      }],
    ])('should not hand the token over when %s while it is being read', async (_case, settle) => {
      vi.useFakeTimers();
      try {
        const browser = mockBrowser();
        const expiring = jwt({ app_id: APP_ID, exp: Math.floor(Date.now() / 1_000) + 10 });
        storedSession(browser.localStorage, expiring, exclusiveRefresh);
        const refresh = deferred<Response>();
        vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(refresh.promise));
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        const change = auth.changePassword();
        const state = browser.getStartUrl().searchParams.get('state')!;
        browser.dispatchMessage(sessionRequest(state));
        settle(browser, state);
        await expect(change).rejects.toThrow();

        refresh.resolve(jsonResponse({ accessToken: 'access-fresh', refreshToken: exclusiveRefresh, tokenType: 'Bearer' }));
        await vi.runAllTimersAsync();

        expect(browser.popup.postMessage).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should clear the session when the password changed but signing in again failed', async () => {
      const browser = mockBrowser();
      storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
      const fetchMock = mockFetchSequence([]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const change = auth.changePassword();
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage({
        type: 'mitra-oauth-result', success: false, passwordChanged: true, state, error: 'Login failed',
      });

      await expect(change).rejects.toMatchObject({
        name: 'MitraApiError',
        status: 401,
        code: 'PASSWORD_CHANGED_SIGN_IN_AGAIN',
      });
      expect(auth.accessToken).toBeNull();
      expect(browser.localStorage._store[STORAGE_KEY]).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['a failure without the password changed', { passwordChanged: false }, 'Change failed'],
      ['a password changed for another state', { passwordChanged: true, state: 'password.forged' }, 'possible CSRF'],
    ])('should keep the session on %s', async (_case, result, message) => {
      const browser = mockBrowser();
      storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const change = auth.changePassword();
      const state = browser.getStartUrl().searchParams.get('state')!;
      browser.dispatchMessage({ type: 'mitra-oauth-result', success: false, state, error: 'Change failed', ...result });

      await expect(change).rejects.toThrow(message);
      expect(auth.accessToken).toBe('access-123');
    });

    it('should end the popup when the session is gone by the time the page asks for it', async () => {
      const browser = mockBrowser();
      storedSession(browser.localStorage, 'access-123', 'refresh-456');
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const change = auth.changePassword();
      const state = browser.getStartUrl().searchParams.get('state')!;
      auth.signOut();
      browser.dispatchMessage(sessionRequest(state));

      await expect(change).rejects.toThrow('Password popup needs a signed-in session.');
      expect(browser.popup.postMessage).not.toHaveBeenCalled();
      expect(browser.popup.close).toHaveBeenCalled();
    });
  });

  describe('requestPasswordReset', () => {
    it('should send only the address, the app, this origin and the language, without a session', async () => {
      const browser = mockBrowser();
      storedSession(browser.localStorage, 'access-123', 'refresh-456');
      const fetchMock = mockFetchSequence([{ status: 202, body: { resendAfterSeconds: 60 } }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(auth.requestPasswordReset('person@example.com', { language: 'en' }))
        .resolves.toEqual({ resendAfterSeconds: 60 });

      expect(fetchMock.mock.calls[0][0]).toBe(RESET_URL);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        email: 'person@example.com',
        appId: APP_ID,
        origin: 'https://app.example.com',
        language: 'en',
      });
      expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    });

    it('should surface the IAM error, retry delay included', async () => {
      mockBrowser();
      mockFetchSequence([{
        status: 429,
        body: { message: 'Too many requests', error_code: 'RATE_LIMITED' },
        headers: { 'Retry-After': '30' },
      }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(auth.requestPasswordReset('person@example.com')).rejects.toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
        retryAfterSeconds: 30,
      });
    });

    it('should refuse an answer without the resend delay', async () => {
      mockBrowser();
      mockFetchSequence([{ status: 202, body: {} }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(auth.requestPasswordReset('person@example.com')).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    });

    it('should require a browser', async () => {
      vi.stubGlobal('window', undefined);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(auth.requestPasswordReset('person@example.com')).rejects.toThrow('only available in a browser');
    });
  });

  describe('password form', () => {
    const PASSWORD_URL = `${IAM_URL}/api/v1/auth/password`;
    const LOGIN_URL = `${PASSWORD_URL}/login`;
    const SIGNUP_URL = `${PASSWORD_URL}/signup`;
    const SIGNUP_VERIFY_URL = `${PASSWORD_URL}/signup/verify`;
    const RESET_CONFIRM_URL = `${PASSWORD_URL}/reset/confirm`;
    const formNotEnabled = {
      status: 403,
      body: { message: 'Forbidden', error_code: 'PASSWORD_FORM_NOT_ENABLED' },
    };
    const newSession = { accessToken: 'access-new', refreshToken: 'refresh-new', tokenType: 'Bearer' };

    function requestBody(fetchMock: ReturnType<typeof vi.fn>, call: number): unknown {
      return JSON.parse(fetchMock.mock.calls[call][1].body);
    }

    describe('signInWithPasswordForm', () => {
      it('should send the password with this origin, without a session, and redeem the exchange code', async () => {
        const browser = mockBrowser();
        const fetchMock = mockFetchSequence([
          { body: { exchangeCode: 'exchange-code', expiresInSeconds: 60 } },
          { body: fakeTokenResponse },
          { body: currentUserResponse },
        ]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.signInWithPasswordForm({ email: 'person@example.com', password: 'secret' }))
          .resolves.toEqual(apiUser);

        expect(fetchMock.mock.calls[0][0]).toBe(LOGIN_URL);
        expect(requestBody(fetchMock, 0)).toEqual({
          email: 'person@example.com',
          password: 'secret',
          appId: APP_ID,
          origin: 'https://app.example.com',
        });
        expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
        expect(fetchMock.mock.calls[1][0]).toBe(EXCHANGE_URL);
        expect(requestBody(fetchMock, 1)).toEqual({ appId: APP_ID, code: 'exchange-code' });
        expect(auth.accessToken).toBe('access-123');
        expect(JSON.parse(browser.localStorage._store[STORAGE_KEY]).refreshToken).toBe('refresh-456');
        expect(browser.window.open).not.toHaveBeenCalled();
      });

      it('should surface the IAM refusal as it came', async () => {
        mockBrowser();
        mockFetchSequence([{ status: 401, body: { message: 'Invalid credentials', error_code: 'INVALID_CREDENTIALS' } }]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.signInWithPasswordForm({ email: 'person@example.com', password: 'wrong' }))
          .rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
        expect(auth.accessToken).toBeNull();
      });

      it('should store nothing when the exchange code is refused', async () => {
        const browser = mockBrowser();
        storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
        const stored = browser.localStorage._store[STORAGE_KEY];
        const fetchMock = mockFetchSequence([
          { body: { exchangeCode: 'exchange-code', expiresInSeconds: 60 } },
          { status: 401, body: { message: 'Invalid exchange code', error_code: 'INVALID_EXCHANGE_CODE' } },
        ]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.signInWithPasswordForm({ email: 'person@example.com', password: 'secret' }))
          .rejects.toMatchObject({ status: 401, code: 'INVALID_EXCHANGE_CODE' });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(auth.accessToken).toBe('access-123');
        expect(browser.localStorage._store[STORAGE_KEY]).toBe(stored);
      });
    });

    describe('startPasswordSignUp and completePasswordSignUp', () => {
      it('should ask for the code with this origin and the language, and return the receipt', async () => {
        mockBrowser();
        const fetchMock = mockFetchSequence([
          { status: 202, body: { receipt: 'receipt-1', resendAfterSeconds: 60 } },
          { status: 202, body: { receipt: 'receipt-2', resendAfterSeconds: 60 } },
        ]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.startPasswordSignUp({ email: 'person@example.com', language: 'en' }))
          .resolves.toEqual({ receipt: 'receipt-1', resendAfterSeconds: 60 });
        await auth.startPasswordSignUp({ email: 'person@example.com' });

        expect(fetchMock.mock.calls[0][0]).toBe(SIGNUP_URL);
        expect(requestBody(fetchMock, 0)).toEqual({
          email: 'person@example.com',
          appId: APP_ID,
          origin: 'https://app.example.com',
          language: 'en',
        });
        expect(requestBody(fetchMock, 1)).toMatchObject({ language: 'pt-BR' });
      });

      it('should verify the code with the password and establish the session', async () => {
        const browser = mockBrowser();
        const fetchMock = mockFetchSequence([
          { body: { exchangeCode: 'exchange-code', expiresInSeconds: 60 } },
          { body: fakeTokenResponse },
          { body: currentUserResponse },
        ]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.completePasswordSignUp({ receipt: 'receipt-1', code: '123456', password: 'secret' }))
          .resolves.toEqual(apiUser);

        expect(fetchMock.mock.calls[0][0]).toBe(SIGNUP_VERIFY_URL);
        expect(requestBody(fetchMock, 0)).toEqual({ receipt: 'receipt-1', code: '123456', password: 'secret' });
        expect(fetchMock.mock.calls[1][0]).toBe(EXCHANGE_URL);
        expect(JSON.parse(browser.localStorage._store[STORAGE_KEY]).token).toBe('access-123');
      });
    });

    describe('changePasswordForm', () => {
      it('should change the password with this session and sign in again with its address and the new password', async () => {
        const browser = mockBrowser();
        storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
        const fetchMock = mockFetchSequence([
          { status: 204, body: undefined },
          { body: { exchangeCode: 'exchange-code', expiresInSeconds: 60 } },
          { body: newSession },
          { body: currentUserResponse },
        ]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.changePasswordForm({ currentPassword: 'old-secret', newPassword: 'new-secret' }))
          .resolves.toEqual(apiUser);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(PASSWORD_URL);
        expect(init.method).toBe('PUT');
        expect(init.headers.Authorization).toBe('Bearer access-123');
        expect(JSON.parse(init.body)).toEqual({ currentPassword: 'old-secret', newPassword: 'new-secret' });
        expect(fetchMock.mock.calls[1][0]).toBe(LOGIN_URL);
        expect(requestBody(fetchMock, 1)).toMatchObject({ email: fakeUser.email, password: 'new-secret' });
        expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
        expect(auth.accessToken).toBe('access-new');
        expect(JSON.parse(browser.localStorage._store[STORAGE_KEY]).refreshToken).toBe('refresh-new');
      });

      it('should leave the current password out for a first password', async () => {
        const browser = mockBrowser();
        storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
        const fetchMock = mockFetchSequence([
          { status: 204, body: undefined },
          { body: { exchangeCode: 'exchange-code', expiresInSeconds: 60 } },
          { body: newSession },
          { body: currentUserResponse },
        ]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await auth.changePasswordForm({ newPassword: 'new-secret' });

        expect(requestBody(fetchMock, 0)).toEqual({ newPassword: 'new-secret' });
      });

      it('should read the address first when the session was adopted without a user', async () => {
        mockBrowser();
        const fetchMock = mockFetchSequence([
          { body: currentUserResponse },
          { status: 204, body: undefined },
          { body: { exchangeCode: 'exchange-code', expiresInSeconds: 60 } },
          { body: newSession },
          { body: currentUserResponse },
        ]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
        auth.setSession({ accessToken: 'access-123', refreshToken: exclusiveRefresh });

        await auth.changePasswordForm({ currentPassword: 'old-secret', newPassword: 'new-secret' });

        expect(fetchMock.mock.calls[0][0]).toBe(`${IAM_URL}/api/v1/auth/me`);
        expect(fetchMock.mock.calls[1][0]).toBe(PASSWORD_URL);
        expect(requestBody(fetchMock, 2)).toMatchObject({ email: 'user@test.com' });
      });

      it('should not send the change when the address of an adopted session cannot be read', async () => {
        mockBrowser();
        const fetchMock = mockFetchSequence([{ status: 500, body: { message: 'Boom' } }]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
        auth.setSession({ accessToken: 'access-123', refreshToken: exclusiveRefresh });

        await expect(auth.changePasswordForm({ currentPassword: 'old-secret', newPassword: 'new-secret' }))
          .rejects.toMatchObject({ status: 500 });

        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${IAM_URL}/api/v1/auth/me`, expect.anything());
        expect(auth.accessToken).toBe('access-123');
      });

      it('should spend a wrong current password once, without refreshing or retrying, and keep the session', async () => {
        const browser = mockBrowser();
        storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
        const fetchMock = mockFetchSequence([
          { status: 401, body: { message: 'Invalid credentials', error_code: 'INVALID_CREDENTIALS' } },
        ]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.changePasswordForm({ currentPassword: 'wrong', newPassword: 'new-secret' }))
          .rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(auth.accessToken).toBe('access-123');
      });

      it('should clear the session when the password changed but signing in again failed', async () => {
        const browser = mockBrowser();
        storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
        mockFetchSequence([
          { status: 204, body: undefined },
          { status: 401, body: { message: 'Invalid credentials', error_code: 'INVALID_CREDENTIALS' } },
        ]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
        const listener = vi.fn();
        auth.onAuthStateChange(listener);

        const failure = await auth.changePasswordForm({ currentPassword: 'old-secret', newPassword: 'new-secret' })
          .catch((error: unknown) => error);

        expect(failure).toMatchObject({
          name: 'MitraApiError',
          status: 401,
          code: 'PASSWORD_CHANGED_SIGN_IN_AGAIN',
          message: 'The password was changed, but signing in again failed. Sign in with the new password.',
          cause: { status: 401, code: 'INVALID_CREDENTIALS' },
        });
        expect(auth.accessToken).toBeNull();
        expect(browser.localStorage._store[STORAGE_KEY]).toBeUndefined();
        expect(listener).toHaveBeenLastCalledWith(null);
      });

      it('should not clear a session that replaced this one while the password was changing', async () => {
        const browser = mockBrowser();
        storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
        const change = deferred<Response>();
        const fetchMock = vi.fn()
          .mockReturnValueOnce(change.promise)
          .mockResolvedValueOnce(jsonResponse({ message: 'Invalid credentials', error_code: 'INVALID_CREDENTIALS' }, 401));
        vi.stubGlobal('fetch', fetchMock);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        const changing = auth.changePasswordForm({ currentPassword: 'old-secret', newPassword: 'new-secret' });
        await flushMicrotasks();
        auth.setSession({ accessToken: 'access-other', refreshToken: 'refresh-other' });
        change.resolve(new Response(null, { status: 204 }));

        await expect(changing).rejects.toMatchObject({ code: 'PASSWORD_CHANGED_SIGN_IN_AGAIN' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(auth.accessToken).toBe('access-other');
        expect(JSON.parse(browser.localStorage._store[STORAGE_KEY]).token).toBe('access-other');
      });

      it('should refuse without sending the password when the session ends while it is renewed', async () => {
        const browser = mockBrowser();
        const expiring = jwt({ app_id: APP_ID, exp: Math.floor(Date.now() / 1_000) + 10 });
        storedSession(browser.localStorage, expiring, exclusiveRefresh);
        const fetchMock = mockFetchSequence([{ status: 401, body: { error_code: 'INVALID_TOKEN' } }]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.changePasswordForm({ currentPassword: 'old-secret', newPassword: 'new-secret' }))
          .rejects.toMatchObject({ name: 'MitraApiError', status: 401, message: 'Sign in before changing the password.' });
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${IAM_URL}/api/v1/auth/refresh-token`, expect.anything());
      });

      it('should refuse without a session before any request', async () => {
        mockBrowser();
        const fetchMock = mockFetchSequence([]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.changePasswordForm({ newPassword: 'new-secret' }))
          .rejects.toMatchObject({ name: 'MitraApiError', status: 401 });
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    describe('readPasswordResetToken and confirmPasswordReset', () => {
      it('should return the token of the link and take the fragment out of the URL', () => {
        const browser = mockBrowser();
        (browser.window.location as { hash: string }).hash = '#resetToken=reset-token-1&lang=en';
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        expect(auth.readPasswordResetToken()).toBe('reset-token-1');
        expect(browser.window.history.replaceState).toHaveBeenCalledExactlyOnceWith({}, '', '/orders?status=open');
      });

      it.each([
        ['no fragment', '', false],
        ['a fragment the app routes on', '#/orders/1', false],
        ['an empty token', '#resetToken=', true],
      ])('should return null for %s', (_case, hash, cleared) => {
        const browser = mockBrowser();
        (browser.window.location as { hash: string }).hash = hash;
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        expect(auth.readPasswordResetToken()).toBeNull();
        expect(vi.mocked(browser.window.history.replaceState).mock.calls).toHaveLength(cleared ? 1 : 0);
      });

      it('should send the token and the new password, without a session', async () => {
        const browser = mockBrowser();
        storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
        const fetchMock = mockFetchSequence([{ status: 204, body: undefined }]);
        const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

        await expect(auth.confirmPasswordReset({ token: 'reset-token-1', newPassword: 'new-secret' }))
          .resolves.toBeUndefined();

        expect(fetchMock.mock.calls[0][0]).toBe(RESET_CONFIRM_URL);
        expect(requestBody(fetchMock, 0)).toEqual({ token: 'reset-token-1', newPassword: 'new-secret' });
        expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
      });
    });

    it.each([
      ['signInWithPasswordForm', (auth: AuthModule) => auth.signInWithPasswordForm({ email: 'a@b.c', password: 'p' })],
      ['completePasswordSignUp', (auth: AuthModule) => auth.completePasswordSignUp({ receipt: 'r', code: '123456', password: 'p' })],
      ['changePasswordForm', (auth: AuthModule) => auth.changePasswordForm({ newPassword: 'p' })],
      ['confirmPasswordReset', (auth: AuthModule) => auth.confirmPasswordReset({ token: 't', newPassword: 'p' })],
    ])('%s should explain how to turn the form mode on when IAM refuses it', async (_method, call) => {
      const browser = mockBrowser();
      storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
      const fetchMock = mockFetchSequence([formNotEnabled]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(call(auth)).rejects.toMatchObject({
        name: 'MitraApiError',
        status: 403,
        code: 'PASSWORD_FORM_NOT_ENABLED',
        message: expect.stringContaining('signInWithPassword(), signUpWithPassword() and changePassword()'),
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(auth.accessToken).toBe('access-123');
      expect(JSON.parse(browser.localStorage._store[STORAGE_KEY]).token).toBe('access-123');
    });

    it.each([
      ['startPasswordSignUp', (auth: AuthModule) => auth.startPasswordSignUp({ email: 'a@b.c' })],
      ['requestPasswordReset', (auth: AuthModule) => auth.requestPasswordReset('a@b.c')],
    ])('%s should hand an IAM refusal over as it came, being free in either mode', async (_method, call) => {
      mockBrowser();
      mockFetchSequence([formNotEnabled]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(call(auth)).rejects.toMatchObject({ status: 403, code: 'PASSWORD_FORM_NOT_ENABLED', message: 'Forbidden' });
    });

    it.each([
      ['a login without the exchange code', LOGIN_URL, (auth: AuthModule) => auth.signInWithPasswordForm({ email: 'a@b.c', password: 'p' })],
      ['a sign-up request without the receipt', SIGNUP_URL, (auth: AuthModule) => auth.startPasswordSignUp({ email: 'a@b.c' })],
      ['a sign-up verification without the exchange code', SIGNUP_VERIFY_URL, (auth: AuthModule) => auth.completePasswordSignUp({ receipt: 'r', code: '123456', password: 'p' })],
    ])('should refuse %s', async (_case, url, call) => {
      mockBrowser();
      const fetchMock = mockFetchSequence([{ body: { resendAfterSeconds: 60 } }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(call(auth)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, expect.anything());
      expect(auth.accessToken).toBeNull();
    });

    it.each([
      ['signInWithPasswordForm', (auth: AuthModule) => auth.signInWithPasswordForm({ email: 'a@b.c', password: 'p' })],
      ['startPasswordSignUp', (auth: AuthModule) => auth.startPasswordSignUp({ email: 'a@b.c' })],
      ['completePasswordSignUp', (auth: AuthModule) => auth.completePasswordSignUp({ receipt: 'r', code: '123456', password: 'p' })],
      ['confirmPasswordReset', (auth: AuthModule) => auth.confirmPasswordReset({ token: 't', newPassword: 'p' })],
      ['readPasswordResetToken', async (auth: AuthModule) => auth.readPasswordResetToken()],
    ])('%s should require a browser', async (_method, call) => {
      vi.stubGlobal('window', undefined);
      const fetchMock = mockFetchSequence([]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(call(auth)).rejects.toThrow(new Error('Password login is only available in a browser.'));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('signOut', () => {
    it('should end an exclusive app session on the server, with keepalive and no access token', () => {
      const storage = mockLocalStorage();
      storedSession(storage, 'access-123', exclusiveRefresh);
      const fetchMock = mockFetchSequence([{ status: 204, body: undefined }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      auth.signOut();

      expect(auth.accessToken).toBeNull();
      expect(storage._store[STORAGE_KEY]).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(LOGOUT_URL);
      expect(init).toMatchObject({ method: 'POST', keepalive: true });
      expect(JSON.parse(init.body)).toEqual({ refreshToken: exclusiveRefresh });
      expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('should clear the local state even when the logout request fails', async () => {
      const storage = mockLocalStorage();
      storedSession(storage, 'access-123', exclusiveRefresh);
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      vi.stubGlobal('fetch', fetchMock);
      const auth = new AuthModule(APP_ID, IAM_URL);
      const listener = vi.fn();
      auth.onAuthStateChange(listener);

      expect(() => auth.signOut()).not.toThrow();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(auth.isAuthenticated).toBe(false);
      expect(storage._store[STORAGE_KEY]).toBeUndefined();
      expect(listener).toHaveBeenLastCalledWith(null);
    });

    it.each([
      ['a shared app session', sharedRefresh],
      ['an opaque refresh token', 'refresh-456'],
      ['no refresh token', null],
    ])('should not call the logout for %s', (_case, refreshToken) => {
      const storage = mockLocalStorage();
      storage._store[STORAGE_KEY] = JSON.stringify({ user: fakeUser, token: 'access-123', refreshToken });
      const fetchMock = mockFetchSequence([]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      auth.signOut();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(auth.accessToken).toBeNull();
    });

    it('should not call the logout twice when signing out of a session already gone', () => {
      const storage = mockLocalStorage();
      storedSession(storage, 'access-123', exclusiveRefresh);
      const fetchMock = mockFetchSequence([{ status: 204, body: undefined }]);
      const auth = new AuthModule(APP_ID, IAM_URL);

      auth.signOut();
      auth.signOut();

      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});

describe('AuthModule calls that predate the password form', () => {
  const RESET_URL = `${IAM_URL}/api/v1/auth/password/reset`;
  const MAGIC_LINK_URL = `${IAM_URL}/api/v1/auth/magic-link`;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The whole `fetch` init of a public JSON POST: no credentials, no keepalive, no extra header. */
  function expectPublicJsonPost(init: RequestInit, body: unknown): void {
    expect(init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  }

  describe('requestPasswordReset', () => {
    it('should send the same request', async () => {
      mockBrowser();
      const fetchMock = mockFetchSequence([{ status: 202, body: { resendAfterSeconds: 60 } }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await auth.requestPasswordReset('person@example.com', { language: 'en' });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(RESET_URL);
      expectPublicJsonPost(fetchMock.mock.calls[0][1], {
        email: 'person@example.com',
        appId: APP_ID,
        origin: 'https://app.example.com',
        language: 'en',
      });
    });

    it('should fail with the same messages', async () => {
      mockBrowser();
      mockFetchSequence([{ status: 202, body: {} }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(auth.requestPasswordReset('person@example.com')).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        message: 'Password reset request response has an invalid resendAfterSeconds field',
      });
      vi.stubGlobal('window', undefined);
      await expect(auth.requestPasswordReset('person@example.com'))
        .rejects.toThrow(new Error('Password reset is only available in a browser.'));
    });
  });

  describe('email code', () => {
    it('should send the same requests to ask for the code, verify it and redeem the exchange code', async () => {
      mockBrowser();
      const fetchMock = mockFetchSequence([
        { status: 202, body: { receipt: 'receipt-1', resendAfterSeconds: 60 } },
        { body: { exchangeCode: 'exchange-code', expiresInSeconds: 60 } },
        { body: fakeTokenResponse },
        { body: currentUserResponse },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
      auth.setBrand('mitra');

      await auth.requestEmailCode({ email: 'person@example.com', language: 'en' });
      await auth.verifyEmailCode({ receipt: 'receipt-1', code: '123456' });

      const requested = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(fetchMock.mock.calls[0][0]).toBe(MAGIC_LINK_URL);
      expectPublicJsonPost(fetchMock.mock.calls[0][1], {
        email: 'person@example.com',
        brand: 'mitra',
        language: 'en',
        appId: APP_ID,
        origin: 'https://app.example.com',
        state: requested.state,
      });
      expect(requested.state).toEqual(expect.stringMatching(/^email\./));
      expect(fetchMock.mock.calls[1][0]).toBe(`${MAGIC_LINK_URL}/verify`);
      expectPublicJsonPost(fetchMock.mock.calls[1][1], { receipt: 'receipt-1', code: '123456' });
      expect(fetchMock.mock.calls[2][0]).toBe(EXCHANGE_URL);
      expectPublicJsonPost(fetchMock.mock.calls[2][1], { appId: APP_ID, code: 'exchange-code' });
    });

    it('should fail with the same messages on a malformed answer', async () => {
      mockBrowser();
      mockFetchSequence([
        { status: 202, body: { resendAfterSeconds: 60 } },
        { status: 202, body: { receipt: 'receipt-1' } },
        { body: {} },
      ]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
      auth.setBrand('mitra');

      await expect(auth.requestEmailCode({ email: 'person@example.com' })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        message: 'Email code request response has an invalid receipt field',
      });
      await expect(auth.requestEmailCode({ email: 'person@example.com' })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        message: 'Email code request response has an invalid resendAfterSeconds field',
      });
      await expect(auth.verifyEmailCode({ receipt: 'receipt-1', code: '123456' })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        message: 'Email sign-in exchange code response has an invalid exchangeCode field',
      });
      vi.stubGlobal('window', undefined);
      await expect(auth.verifyEmailCode({ receipt: 'receipt-1', code: '123456' }))
        .rejects.toThrow(new Error('Email sign-in is only available in a browser.'));
    });
  });

  describe('password popup', () => {
    it.each([
      ['signInWithPassword', 'login'],
      ['signUpWithPassword', 'signup'],
    ] as const)('%s should open the same URL and redeem the code with the same request', async (method, view) => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([{ body: fakeTokenResponse }, { body: currentUserResponse }]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      const signIn = auth[method]();
      const startUrl = browser.getStartUrl();
      const state = startUrl.searchParams.get('state')!;
      browser.dispatchMessage(authPageResult(state, { code: 'exchange-code' }));
      await signIn;

      expect(startUrl.origin + startUrl.pathname).toBe(AUTH_PAGE_URL);
      expect([...startUrl.searchParams.entries()]).toEqual([
        ['provider', 'password'],
        ['state', state],
        ['appId', APP_ID],
        ['apiUrl', API_URL],
        ['origin', 'https://app.example.com'],
        ['responseType', 'code'],
        ['view', view],
      ]);
      expect(fetchMock.mock.calls[0][0]).toBe(EXCHANGE_URL);
      expectPublicJsonPost(fetchMock.mock.calls[0][1], { appId: APP_ID, code: 'exchange-code' });
    });

    it('changePassword should open the change view and fail with the same messages', async () => {
      const browser = mockBrowser();
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
      await expect(auth.changePassword()).rejects.toMatchObject({
        status: 401,
        message: 'Sign in before changing the password.',
      });

      storedSession(browser.localStorage, 'access-123', exclusiveRefresh);
      const signedIn = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
      const change = signedIn.changePassword();
      const startUrl = browser.getStartUrl();
      const state = startUrl.searchParams.get('state')!;
      browser.dispatchMessage({ type: 'mitra-oauth-result', success: false, passwordChanged: true, state });

      await expect(change).rejects.toMatchObject({
        status: 401,
        code: 'PASSWORD_CHANGED_SIGN_IN_AGAIN',
        message: 'The password was changed, but signing in again failed. Sign in with the new password.',
      });
      expect(startUrl.searchParams.get('view')).toBe('change');
      expect([...startUrl.searchParams.keys()]).toEqual(
        ['provider', 'state', 'appId', 'apiUrl', 'origin', 'responseType', 'view']
      );
    });
  });
});
