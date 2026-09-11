import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuthModule, getAuthSessionPort } from './auth';
import { mockFetchSequence } from '../test-utils';

const APP_ID = 'test-app';
const IAM_URL = 'https://api.mitra.io/iam';
const API_KEY = 'chave-de-teste-nunca-real';

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

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

const appToken = jwt({ token_use: 'app', app_id: APP_ID, exp: 9_999_999_999 });
const otherAppToken = jwt({ token_use: 'app', app_id: 'another-app', exp: 9_999_999_999 });
const workspaceToken = jwt({ token_use: 'session', exp: 9_999_999_999 });

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('signInWithApiKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('signs in with a product key using the token the exchange returns', async () => {
    const fetchMock = mockFetchSequence([
      { body: { accessToken: appToken, refreshToken: null, tokenType: 'Bearer' } },
      { body: currentUserResponse },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    const user = await auth.signInWithApiKey(API_KEY);

    expect(user.email).toBe('user@test.com');
    expect(auth.accessToken).toBe(appToken);
    expect(requestedUrls(fetchMock)[0]).toContain('/api/v1/auth/exchange');
    expect(requestedUrls(fetchMock)).toHaveLength(2);
  });

  it('issues the app token when the key belongs to a workspace', async () => {
    const fetchMock = mockFetchSequence([
      { body: { accessToken: workspaceToken, refreshToken: null, tokenType: 'Bearer' } },
      { body: { accessToken: appToken, tokenType: 'Bearer' } },
      { body: currentUserResponse },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await auth.signInWithApiKey(API_KEY);

    expect(requestedUrls(fetchMock)[1]).toContain(`/api/v1/auth/apps/${APP_ID}/access-token`);
    expect(auth.accessToken).toBe(appToken);
  });

  it('refuses a key bound to another app instead of attempting an impossible call', async () => {
    // IAM issues an app token only from a workspace session, so trying it with another
    // product's token would come back as an opaque 401.
    const fetchMock = mockFetchSequence([
      { body: { accessToken: otherAppToken, refreshToken: null, tokenType: 'Bearer' } },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.signInWithApiKey(API_KEY)).rejects.toThrow(/belongs to app/i);
    expect(auth.accessToken).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('holds no refresh token, because the key itself is what renews the session', async () => {
    mockFetchSequence([
      { body: { accessToken: appToken, refreshToken: null, tokenType: 'Bearer' } },
      { body: currentUserResponse },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    await auth.signInWithApiKey(API_KEY);

    expect(getAuthSessionPort(auth).readSessionTokens().refreshToken).toBeNull();
  });

  it('uses the key from the client configuration when none is passed', async () => {
    const fetchMock = mockFetchSequence([
      { body: { accessToken: appToken, refreshToken: null, tokenType: 'Bearer' } },
      { body: currentUserResponse },
    ]);
    const auth = new AuthModule(APP_ID, IAM_URL, { apiKey: API_KEY });

    await auth.signInWithApiKey();

    expect(requestedUrls(fetchMock)).toHaveLength(2);
  });

  it('asks for a key when neither the call nor the configuration carries one', async () => {
    const auth = new AuthModule(APP_ID, IAM_URL);

    await expect(auth.signInWithApiKey()).rejects.toThrow(/No api key was given/i);
  });

  it('keeps the key out of the error when the exchange refuses it', async () => {
    mockFetchSequence([{ status: 401, body: { message: `bad key ${API_KEY}` } }]);
    const auth = new AuthModule(APP_ID, IAM_URL);

    const failure = await auth.signInWithApiKey(API_KEY).catch((error: unknown) => error);

    expect(String(failure)).not.toContain(API_KEY);
  });
});

describe('signInWithApiKey in a browser', () => {
  // The suite runs in node, where there is no window; standing one up is what puts the guard
  // under test.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to run, because the key would be served with the bundle', async () => {
    vi.stubGlobal('window', {});
    const auth = new AuthModule(APP_ID, IAM_URL, { apiKey: API_KEY });

    await expect(auth.signInWithApiKey()).rejects.toThrow(/only on a server/i);
  });
});
