import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthModule } from './auth';
import { MitraApiError } from '../utils/http-client';
import { mockFetchSequence, mockLocalStorage } from '../test-utils';

const APP_ID = 'test-app';
const IAM_URL = 'https://api.mitra.io/iam';
const STORAGE_KEY = `mitra_auth_${APP_ID}`;

const fakeUser = { id: 'u1', tenantId: 't1', email: 'user@test.com', name: 'Test User' };
const fakeTokenResponse = { accessToken: 'access-123', refreshToken: 'refresh-456', tokenType: 'Bearer' };

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
      { body: fakeUser },
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const user = await auth.signIn({ email: 'user@test.com', password: 'pass' });

    expect(user).toEqual(fakeUser);
    expect(auth.currentUser).toEqual(fakeUser);
    expect(auth.accessToken).toBe('access-123');

    // Verify POST /login was called with credentials and appId
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${IAM_URL}/api/v1/auth/login`);
    expect(JSON.parse(options.body)).toEqual({ email: 'user@test.com', password: 'pass', appId: APP_ID });
  });

  it('should save auth state to localStorage after sign in', async () => {
    mockFetchSequence([
      { body: fakeTokenResponse },
      { body: fakeUser },
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    await auth.signIn({ email: 'user@test.com', password: 'pass' });

    expect(storage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      expect.any(String)
    );
    const stored = JSON.parse(storage._store[STORAGE_KEY]);
    expect(stored.user).toEqual(fakeUser);
    expect(stored.token).toBe('access-123');
    expect(stored.refreshToken).toBe('refresh-456');
  });

  it('should sign up and then sign in automatically', async () => {
    const fetchMock = mockFetchSequence([
      { body: { id: 'u1' } },           // POST /register
      { body: fakeTokenResponse },       // POST /tokens (signIn)
      { body: fakeUser },               // GET /me (signIn)
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const user = await auth.signUp({ email: 'new@test.com', password: 'pass', name: 'New' });

    expect(user).toEqual(fakeUser);

    // Verify register call includes appId
    const registerBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(registerBody.appId).toBe(APP_ID);
    expect(registerBody.email).toBe('new@test.com');
  });

  it('should clear auth state on sign out', async () => {
    mockFetchSequence([
      { body: fakeTokenResponse },
      { body: fakeUser },
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
    const fetchMock = mockFetchSequence([
      { body: newTokenResponse },  // POST /tokens/refresh
      { body: fakeUser },          // GET /me
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const result = await auth.refreshSession();

    expect(result).toBe(true);
    expect(auth.accessToken).toBe('new-access');

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
      { body: fakeUser },
    ]);

    const auth = new AuthModule(APP_ID, IAM_URL);

    const [r1, r2] = await Promise.all([
      auth.refreshSession(),
      auth.refreshSession(),
    ]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // Only one refresh request should be made (2 fetch calls: refresh + me)
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('should fetch current user via me()', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'access-123',
      refreshToken: 'refresh-456',
    });

    const updatedUser = { ...fakeUser, name: 'Updated Name' };
    mockFetchSequence([{ body: updatedUser }]);

    const auth = new AuthModule(APP_ID, IAM_URL);
    const user = await auth.me();

    expect(user).toEqual(updatedUser);
    expect(auth.currentUser).toEqual(updatedUser);
  });

  it('should clear auth state when me() returns 401', async () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: fakeUser,
      token: 'expired-token',
      refreshToken: 'refresh-456',
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
      { body: fakeUser },
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

    mockFetchSequence([{ body: fakeUser }]);

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
      { body: fakeUser },
    ]);

    await auth.signIn({ email: 'user@test.com', password: 'pass' });

    // Called again with the user
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(fakeUser);
  });

  it('should unsubscribe listener when unsub function is called', async () => {
    const auth = new AuthModule(APP_ID, IAM_URL);
    const listener = vi.fn();

    const unsub = auth.onAuthStateChange(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();

    mockFetchSequence([
      { body: fakeTokenResponse },
      { body: fakeUser },
    ]);

    await auth.signIn({ email: 'user@test.com', password: 'pass' });

    // Should NOT have been called again after unsubscribe
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
