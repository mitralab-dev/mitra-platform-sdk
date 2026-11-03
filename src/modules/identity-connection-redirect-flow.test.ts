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

    it.each([
      'https://app.example.com/callback?next=1',
      'https://app.example.com/callback#top',
      'callback',
      'https://other.example.com/callback',
      'ftp://app.example.com/callback',
    ])(
      'should refuse the redirect URI %s without a request or a stored request',
      async (redirectUri) => {
        const browser = mockBrowser();
        const fetchMock = mockFetchSequence([]);

        await expect(flow().start('sankhya-pass', { redirectUri })).rejects.toThrow('redirectUri must');

        expect(fetchMock).not.toHaveBeenCalled();
        expect(tabStorage(browser)[STORAGE_KEY]).toBeUndefined();
      }
    );

    it('should not navigate when the pending request cannot be stored', async () => {
      const browser = mockBrowser();
      vi.mocked(browser.window.sessionStorage.setItem).mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      mockFetchSequence([{ body: CONNECTION }]);

      await expect(flow().start('sankhya-pass')).rejects.toThrow('requires sessionStorage');

      expect(browser.window.location.assign).not.toHaveBeenCalled();
    });

    it('should refuse an invalid slug without a request', async () => {
      mockBrowser();
      const fetchMock = mockFetchSequence([]);

      await expect(flow().start('../admin')).rejects.toThrow('invalid connection');

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it.each([
      ['a query of another flow', '?status=open&state=google.abc', ''],
      ['the bridge fragment and no query', '', `#codeMitra=code-1&stateMitra=connection.${'0a'.repeat(16)}&connectionMitra=sankhya-pass`],
    ])('should return null without a request and leave the URL alone for %s', async (_case, query, fragment) => {
      const browser = returnedWith(query);
      browser.window.location.hash = fragment;
      storeContext(browser);
      const fetchMock = mockFetchSequence([]);

      await expect(flow().complete()).resolves.toBeNull();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.window.history.replaceState).not.toHaveBeenCalled();
      expect(browser.window.location.hash).toBe(fragment);
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

    it.each([
      ['the error code', '?error=access_denied', /^access_denied$/],
      ['the description over the error code', '?error=access_denied&error_description=User%20cancelled', /^User cancelled$/],
    ])('should report %s from the provider after clearing the query and spending the request', async (_case, query, expected) => {
      const browser = returnedWith(`${query}&state=${STATE}`);
      storeContext(browser);
      const fetchMock = mockFetchSequence([]);

      await expect(flow().complete()).rejects.toThrow(expected);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders');
      expect(tabStorage(browser)[STORAGE_KEY]).toBeUndefined();
    });

    it('should say the context was not found, not CSRF, when sessionStorage is unreadable', async () => {
      const browser = returnedWith(`?code=kc-code&state=${STATE}`);
      vi.mocked(browser.window.sessionStorage.getItem).mockImplementation(() => {
        throw new Error('SecurityError');
      });
      const fetchMock = mockFetchSequence([]);

      const message = await flow().complete().catch((error: Error) => error.message);

      expect(message).toContain('context was not found in this tab');
      expect(message).not.toContain('CSRF');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders');
    });

    it('should refuse a matching state without code, without a request, after clearing the query', async () => {
      const browser = returnedWith(`?state=${STATE}`);
      storeContext(browser);
      const fetchMock = mockFetchSequence([]);

      await expect(flow().complete()).rejects.toThrow('missing code');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders');
    });

    it('should refuse an IAM answer without an exchange code', async () => {
      const browser = returnedWith(`?code=kc-code&state=${STATE}`);
      storeContext(browser);
      const fetchMock = mockFetchSequence([
        { body: { access_token: 'kc-access' } },
        { body: { expiresInSeconds: 60 } },
      ]);

      await expect(flow().complete()).rejects.toThrow('did not return an exchange code');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should report a provider it cannot reach without the code or the verifier, and clear the timer', async () => {
      vi.useFakeTimers();
      try {
        const browser = returnedWith(`?code=kc-code&state=${STATE}`);
        storeContext(browser);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        const message = await flow().complete().catch((error: Error) => error.message);

        expect(message).toContain('could not reach the identity provider token endpoint');
        expect(message).toContain('Web Origins');
        expect(message).not.toContain('kc-code');
        expect(message).not.toContain('verifier-1');
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should report a provider error whose body is not JSON with the status alone', async () => {
      const browser = returnedWith(`?code=kc-code&state=${STATE}`);
      storeContext(browser);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
      }));

      await expect(flow().complete()).rejects.toThrow(/could not redeem the authorization code \(status 502\)\.$/);
    });

    it('should give up on a provider that does not answer within 15 seconds', async () => {
      vi.useFakeTimers();
      try {
        const browser = returnedWith(`?code=kc-code&state=${STATE}`);
        storeContext(browser);
        const fetchMock = vi.fn(() => new Promise(() => undefined));
        vi.stubGlobal('fetch', fetchMock);

        const failure = flow().complete().catch((error: Error) => error.message);
        await vi.advanceTimersByTimeAsync(15_000);
        const message = await failure;

        expect(message).toContain('timed out redeeming the authorization code');
        expect(message).not.toContain('kc-code');
        expect(message).not.toContain('verifier-1');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
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
      mockFetchSequence([{
        body: { error: 'invalid_grant', error_description: 'Code kc-code for verifier verifier-1 not valid' },
        status: 400,
      }]);

      const message = await flow().complete().catch((error: Error) => error.message);

      expect(message).toContain('status 400, invalid_grant: Code [redacted] for verifier [redacted] not valid');
      expect(message).not.toContain('kc-code');
      expect(message).not.toContain('verifier-1');
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
        redirect: 'error',
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
