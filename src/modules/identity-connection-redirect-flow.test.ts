import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_API_URL as API_URL, mockBrowser, mockFetchSequence, type BrowserHarness } from '../test-utils';
import { HttpClient } from '../utils/http-client';
import { IdentityConnectionRedirectFlow } from './identity-connection-redirect-flow';

const APP_ID = '11111111-1111-1111-1111-111111111111';
const IAM_URL = `${API_URL}/iam`;
const STORAGE_KEY = `mitra_identity_connection_redirect_${APP_ID}`;
const CONNECTION_URL = `${IAM_URL}/api/v1/auth/identity-connections/sankhya-pass`;
const AUTHORIZATION_ENDPOINT = 'https://pass.sankhya.com.br/realms/pass/protocol/openid-connect/auth';
const TOKEN_ENDPOINT = 'https://pass.sankhya.com.br/realms/pass/protocol/openid-connect/token';
const CONNECTION = {
  slug: 'sankhya-pass',
  name: 'Sankhya Pass',
  allowedOrigins: ['https://*.sankhyacloud.com.br'],
  authorizationEndpoint: AUTHORIZATION_ENDPOINT,
  tokenEndpoint: TOKEN_ENDPOINT,
  clientId: 'mitra-apps',
};
const STATE = `connection.sankhya-pass.${'07'.repeat(16)}`;
const TOKENS = { accessToken: 'access-123', refreshToken: 'refresh-456', tokenType: 'Bearer' };

function flow(): IdentityConnectionRedirectFlow {
  return new IdentityConnectionRedirectFlow({
    appId: APP_ID,
    client: new HttpClient({ baseUrl: IAM_URL, getToken: () => null }),
    storageKey: STORAGE_KEY,
  });
}

function tabStorage(browser: BrowserHarness): Record<string, string> {
  return (browser.window.sessionStorage as unknown as { _store: Record<string, string> })._store;
}

function storeContext(browser: BrowserHarness, overrides: Record<string, unknown> = {}): void {
  tabStorage(browser)[STORAGE_KEY] = JSON.stringify({
    state: STATE,
    codeVerifier: 'verifier-1',
    slug: 'sankhya-pass',
    redirectUri: 'https://app.example.com/orders',
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'mitra-apps',
    language: 'pt-BR',
    createdAt: Date.now(),
    ...overrides,
  });
}

function returnedWith(query: string): BrowserHarness {
  const browser = mockBrowser();
  browser.window.location.search = query;
  return browser;
}

describe('IdentityConnectionRedirectFlow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('start', () => {
    it('should store the pending request and send the page to the provider with PKCE', async () => {
      const browser = mockBrowser();
      browser.window.location.hash = '#section';
      const fetchMock = mockFetchSequence([{ body: CONNECTION }]);

      void flow().start('sankhya-pass');
      await vi.waitFor(() => expect(browser.window.location.assign).toHaveBeenCalled());

      expect(fetchMock.mock.calls[0][0]).toBe(CONNECTION_URL);
      const context = JSON.parse(tabStorage(browser)[STORAGE_KEY]);
      expect(context).toMatchObject({
        state: STATE,
        slug: 'sankhya-pass',
        redirectUri: 'https://app.example.com/orders',
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: 'mitra-apps',
      });
      expect(context.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

      const target = browser.getRedirectUrl();
      expect(`${target.origin}${target.pathname}`).toBe(AUTHORIZATION_ENDPOINT);
      expect(Object.fromEntries(target.searchParams)).toEqual({
        response_type: 'code',
        client_id: 'mitra-apps',
        redirect_uri: 'https://app.example.com/orders',
        scope: 'openid email profile',
        state: STATE,
        code_challenge: createHash('sha256').update(context.codeVerifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      expect(target.search).toContain('scope=openid%20email%20profile');
    });

    it('should send the provider back to the redirect URI the app chose', async () => {
      const browser = mockBrowser();
      mockFetchSequence([{ body: CONNECTION }]);

      void flow().start('sankhya-pass', { redirectUri: 'https://app.example.com/callback', language: 'en' });
      await vi.waitFor(() => expect(browser.window.location.assign).toHaveBeenCalled());

      expect(browser.getRedirectUrl().searchParams.get('redirect_uri')).toBe('https://app.example.com/callback');
      expect(JSON.parse(tabStorage(browser)[STORAGE_KEY])).toMatchObject({
        redirectUri: 'https://app.example.com/callback',
        language: 'en',
      });
    });

    it.each(['authorizationEndpoint', 'tokenEndpoint', 'clientId'])(
      'should refuse a connection without %s, before storing or navigating',
      async (field) => {
        const browser = mockBrowser();
        mockFetchSequence([{ body: { ...CONNECTION, [field]: undefined } }]);

        await expect(flow().start('sankhya-pass')).rejects.toThrow('does not support redirect sign-in');

        expect(tabStorage(browser)[STORAGE_KEY]).toBeUndefined();
        expect(browser.window.location.assign).not.toHaveBeenCalled();
      }
    );

    it('should refuse an invalid slug without a request', async () => {
      mockBrowser();
      const fetchMock = mockFetchSequence([]);

      await expect(flow().start('../admin')).rejects.toThrow('invalid connection');

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it('should return null without a request and leave the URL alone when the query is not from this flow', async () => {
      const browser = returnedWith('?status=open&state=google.abc');
      storeContext(browser);
      const fetchMock = mockFetchSequence([]);

      await expect(flow().complete()).resolves.toBeNull();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.window.history.replaceState).not.toHaveBeenCalled();
      expect(tabStorage(browser)[STORAGE_KEY]).toBeDefined();
    });

    it.each([
      ['no pending request', () => undefined],
      ['another pending request', (browser: BrowserHarness) => storeContext(browser, { state: `connection.sankhya-pass.${'0a'.repeat(16)}` })],
    ])('should refuse a state with %s without a request, after clearing the query', async (_case, arrange) => {
      const browser = returnedWith(`?status=open&code=kc-code&state=${STATE}&session_state=s1&iss=https%3A%2F%2Fpass`);
      browser.window.location.hash = '#section';
      arrange(browser);
      const fetchMock = mockFetchSequence([]);

      await expect(flow().complete()).rejects.toThrow('possible CSRF');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders?status=open#section');
      expect(tabStorage(browser)[STORAGE_KEY]).toBeUndefined();
    });

    it('should report the provider error after clearing the query and spending the request', async () => {
      const browser = returnedWith(`?error=access_denied&state=${STATE}`);
      storeContext(browser);
      const fetchMock = mockFetchSequence([]);

      await expect(flow().complete()).rejects.toThrow('access_denied');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders');
      expect(tabStorage(browser)[STORAGE_KEY]).toBeUndefined();
    });

    it('should refuse a provider answer without an access token before signing in at IAM', async () => {
      const browser = returnedWith(`?code=kc-code&state=${STATE}`);
      storeContext(browser);
      const fetchMock = mockFetchSequence([{ body: { id_token: 'kc-id' } }]);

      await expect(flow().complete()).rejects.toThrow('did not receive an access token');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should report a code the provider refuses', async () => {
      const browser = returnedWith(`?code=kc-code&state=${STATE}`);
      storeContext(browser);
      mockFetchSequence([{ body: { error: 'invalid_grant', error_description: 'Code not valid' }, status: 400 }]);

      await expect(flow().complete()).rejects.toThrow('status 400, invalid_grant: Code not valid');
    });

    it('should redeem the code at the provider, sign in at IAM and redeem the exchange code', async () => {
      const browser = returnedWith(`?code=kc-code&state=${STATE}&session_state=s1`);
      storeContext(browser);
      const fetchMock = mockFetchSequence([
        { body: { access_token: 'kc-access', id_token: 'kc-id', refresh_token: 'kc-refresh' } },
        { body: { exchangeCode: 'exchange-1', expiresInSeconds: 60 } },
        { body: TOKENS },
      ]);

      await expect(flow().complete()).resolves.toEqual(TOKENS);

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        TOKEN_ENDPOINT,
        `${CONNECTION_URL}/login`,
        `${CONNECTION_URL}/exchange`,
      ]);
      const [, tokenRequest] = fetchMock.mock.calls[0];
      expect(tokenRequest).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      expect(Object.fromEntries(new URLSearchParams(tokenRequest.body))).toEqual({
        grant_type: 'authorization_code',
        client_id: 'mitra-apps',
        code: 'kc-code',
        redirect_uri: 'https://app.example.com/orders',
        code_verifier: 'verifier-1',
      });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        token: 'kc-access',
        appId: APP_ID,
        language: 'pt-BR',
      });
      expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ appId: APP_ID, code: 'exchange-1' });
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders');
    });
  });
});
