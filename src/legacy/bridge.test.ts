import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConfig, type LoginResponse } from 'mitra-interactions-sdk';
import { createClient } from '../client';
import { exchangeSsoCodeMitra } from './index';
import { adoptLegacySession, resetActiveBridge } from './bridge';
import { mockFetch, mockLocalStorage, mockSessionStorage } from '../test-utils';

const APP_ID = 'app-1';
const API_URL = 'https://api.mitra.io';
const STORAGE_KEY = `mitra_auth_${APP_ID}`;

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
    createClient({ appId: APP_ID, apiUrl: API_URL });

    expect(getConfig().baseURL).toBe(API_URL);
    expect(getConfig().projectId).toBe(APP_ID);
    expect(typeof getConfig().onTokenRefresh).toBe('function');
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

  it('should drop a refresh token the legacy SDK considers out of scope', () => {
    storage._store[STORAGE_KEY] = JSON.stringify({
      user: null,
      token: 'persisted-access-token',
      refreshToken: fakeJwt({ sub: 'u1' }),
    });

    createClient({ appId: APP_ID, apiUrl: API_URL });

    expect(getConfig().token).toBe('persisted-access-token');
    expect(getConfig().refreshToken).toBeUndefined();
  });

  it('should persist the session of a real legacy SSO exchange', async () => {
    const sessionStore = mockSessionStorage();
    sessionStore._store['mitra_sso_redirect'] = JSON.stringify({
      state: 'nonce-1',
      authUrl: API_URL,
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

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_URL}/auth/google`);
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
