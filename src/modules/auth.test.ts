import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthModule, getAuthSessionPort } from './auth';
import { mockFetchSequence, mockLocalStorage } from '../test-utils';

const APP_ID = 'test-app';
const IAM_URL = 'https://api.mitra.io/iam';
const STORAGE_KEY = `mitra_auth_${APP_ID}`;

const fakeUser = { id: 'u1', tenantId: 't1', email: 'user@test.com', name: 'Test User' };
const currentUserResponse = {
  id: 'u1',
  tenant: {
    id: 't1',
    shortId: 'AAAAAAAAAAAAAAAAAAAAEA',
    legacyId: null,
    slug: 'test-tenant',
    plan: { id: 'plan-1', name: 'Free' },
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
  onboardingCompleted: false,
};
const apiUser = { ...currentUserResponse, tenantId: 't1' };
const fakeTokenResponse = { accessToken: 'access-123', refreshToken: 'refresh-456', tokenType: 'Bearer' };

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

  it('should sign in with credentials and return user', async () => {
    const fetchMock = mockFetchSequence([
      { body: fakeTokenResponse },
      { body: currentUserResponse },
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const user = await auth.signIn({ email: 'user@test.com', password: 'pass' });

    expect(user).toEqual(apiUser);
    expect(auth.currentUser).toEqual(apiUser);
    expect(auth.accessToken).toBe('access-123');

    // Verify POST /login was called with credentials and appId
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${IAM_URL}/api/v1/auth/login`);
    expect(JSON.parse(options.body)).toEqual({ email: 'user@test.com', password: 'pass', appId: APP_ID });
  });

  it('should reject sign-in JWTs issued for another app before user hydration', async () => {
    const fetchMock = mockFetchSequence([{
      body: {
        accessToken: jwt({ app_id: 'other-app' }),
        refreshToken: jwt({ app_id: 'other-app' }),
        tokenType: 'Bearer',
      },
    }]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(
      auth.signIn({ email: 'user@test.com', password: 'pass' })
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'Authentication returned a token for a different app',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.accessToken).toBeNull();
    expect(storage._store[STORAGE_KEY]).toBeUndefined();
  });

  it('should reject an invalid canonical current-user response', async () => {
    const invalidTenant = { ...currentUserResponse.tenant } as Record<string, unknown>;
    delete invalidTenant.active;
    mockFetchSequence([
      { body: fakeTokenResponse },
      { body: { ...currentUserResponse, tenant: invalidTenant } },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(
      auth.signIn({ email: 'user@test.com', password: 'pass' })
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'Current user response tenant has an invalid active field',
    });
  });

  it('should save auth state to localStorage after sign in', async () => {
    mockFetchSequence([
      { body: fakeTokenResponse },
      { body: currentUserResponse },
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    await auth.signIn({ email: 'user@test.com', password: 'pass' });

    expect(storage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      expect.any(String)
    );
    const stored = JSON.parse(storage._store[STORAGE_KEY]);
    expect(stored.user).toEqual(apiUser);
    expect(stored.token).toBe('access-123');
    expect(stored.refreshToken).toBe('refresh-456');
  });

  it('should sign up and then sign in automatically', async () => {
    const fetchMock = mockFetchSequence([
      { body: { id: 'u1' } },           // POST /register
      { body: fakeTokenResponse },       // POST /tokens (signIn)
      { body: currentUserResponse },    // GET /me (signIn)
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const user = await auth.signUp({ email: 'new@test.com', password: 'pass', name: 'New' });

    expect(user).toEqual(apiUser);

    // Verify register call includes appId
    const registerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(registerBody.appId).toBe(APP_ID);
    expect(registerBody.email).toBe('new@test.com');
  });

  it('should clear auth state on sign out', async () => {
    mockFetchSequence([
      { body: fakeTokenResponse },
      { body: currentUserResponse },
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    await auth.signIn({ email: 'user@test.com', password: 'pass' });

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

  it('should not let an old refresh overwrite a newer credential login', async () => {
    storedSession(storage, 'old-access', 'old-refresh');
    const pendingRefresh = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(pendingRefresh.promise)
      .mockResolvedValueOnce(jsonResponse({
        accessToken: 'login-access',
        refreshToken: 'login-refresh',
        tokenType: 'Bearer',
      }))
      .mockResolvedValueOnce(jsonResponse(currentUserResponse));
    vi.stubGlobal('fetch', fetchMock);
    const auth = new AuthModule(APP_ID, IAM_URL);

    const oldRefresh = auth.refreshSession();
    await expect(
      auth.signIn({ email: 'user@test.com', password: 'pass' })
    ).resolves.toEqual(apiUser);
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

    mockFetchSequence([
      { body: fakeTokenResponse },
      { body: currentUserResponse },
    ]);

    await auth.signIn({ email: 'user@test.com', password: 'pass' });
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

  it('should call onAuthStateChange listener immediately and on sign in', async () => {
    const auth = new AuthModule(APP_ID, IAM_URL);
    const listener = vi.fn();

    auth.onAuthStateChange(listener);

    // Called immediately with null (not authenticated)
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);

    mockFetchSequence([
      { body: fakeTokenResponse },
      { body: currentUserResponse },
    ]);

    await auth.signIn({ email: 'user@test.com', password: 'pass' });

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

    mockFetchSequence([
      { body: fakeTokenResponse },
      { body: currentUserResponse },
    ]);

    await auth.signIn({ email: 'user@test.com', password: 'pass' });

    // Should NOT have been called again after unsubscribe
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
