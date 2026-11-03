import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_API_URL as API_URL, mockBrowser, mockFetchSequence, type BrowserHarness } from '../test-utils';
import { HttpClient } from '../utils/http-client';
import { IdentityConnectionFlow, isAllowedOrigin } from './identity-connection-flow';

const APP_ID = '11111111-1111-1111-1111-111111111111';
const IAM_URL = `${API_URL}/iam`;
const CONNECTION_URL = `${IAM_URL}/api/v1/auth/identity-connections/sankhya-pass`;
const EXCHANGE_URL = `${CONNECTION_URL}/exchange`;
const CONNECTION = { slug: 'sankhya-pass', name: 'Sankhya Pass', allowedOrigins: ['https://*.sankhyacloud.com.br'] };
const TOKENS = { accessToken: 'access-123', refreshToken: 'refresh-456', tokenType: 'Bearer' };
const STATE = 'connection.0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const ALL_TOKENS = {
  platform: { accessToken: 'session-access', refreshToken: 'session-refresh', tokenType: 'Bearer' },
  mitraSpace: { token: 'space-token', tokenType: 'Bearer' },
  b2bToken: null,
  backoffice: null,
};

function flow(): IdentityConnectionFlow {
  return new IdentityConnectionFlow({
    appId: APP_ID,
    client: new HttpClient({ baseUrl: IAM_URL, getToken: () => null }),
  });
}

const HOST_ORIGIN = 'https://pampulha01.sankhyacloud.com.br';

function framedWithFragment(fragment: string, hostOrigin: string | null = HOST_ORIGIN): BrowserHarness {
  const browser = mockBrowser(undefined, { framed: true, hostOrigin });
  browser.window.location.hash = fragment;
  return browser;
}

function expectFragmentCleared(browser: BrowserHarness): void {
  expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', '/orders?status=open');
}

describe('IdentityConnectionFlow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return null without a request when the URL carries no fragment', async () => {
    const browser = framedWithFragment('');
    const fetchMock = mockFetchSequence([]);

    await expect(flow().completeRedirect()).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.window.history.replaceState).not.toHaveBeenCalled();
  });

  it.each([
    ['another flow state', `#codeMitra=code-1&stateMitra=google.${'0a'.repeat(16)}`],
    ['no connection', `#codeMitra=code-1&stateMitra=${STATE}`],
    ['a connection without the connection state', '#codeMitra=code-1&stateMitra=google.abc&connectionMitra=sankhya-pass'],
    ['a connection without state', '#codeMitra=code-1&connectionMitra=sankhya-pass'],
  ])('should leave the fragment untouched for %s', async (_case, fragment) => {
    const browser = framedWithFragment(fragment);
    const fetchMock = mockFetchSequence([]);

    await expect(flow().completeRedirect()).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.window.history.replaceState).not.toHaveBeenCalled();
  });

  it('should refuse a code in a top-level tab after clearing the fragment', async () => {
    const browser = mockBrowser();
    browser.window.location.hash = `#codeMitra=code-1&stateMitra=${STATE}&connectionMitra=sankhya-pass`;
    const fetchMock = mockFetchSequence([]);

    await expect(flow().completeRedirect()).rejects.toThrow('only accepted inside the host system iframe');

    expectFragmentCleared(browser);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['Sankhya-Pass', '../admin', 'a'.repeat(65), ''])(
    'should refuse the invalid connection slug %j',
    async (slug) => {
      const browser = framedWithFragment(
        `#codeMitra=code-1&stateMitra=${STATE}&connectionMitra=${encodeURIComponent(slug)}`
      );
      const fetchMock = mockFetchSequence([]);

      await expect(flow().completeRedirect()).rejects.toThrow('invalid connection');

      expectFragmentCleared(browser);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('should report the error the bridge sent instead of redeeming', async () => {
    const browser = framedWithFragment(
      `#errorMitra=access_denied&stateMitra=${STATE}&connectionMitra=sankhya-pass`
    );
    const fetchMock = mockFetchSequence([]);

    await expect(flow().completeRedirect()).rejects.toThrow('access_denied');

    expectFragmentCleared(browser);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should refuse a fragment without code', async () => {
    const browser = framedWithFragment(`#codeMitra=%20&stateMitra=${STATE}&connectionMitra=sankhya-pass`);
    const fetchMock = mockFetchSequence([]);

    await expect(flow().completeRedirect()).rejects.toThrow('missing code');

    expectFragmentCleared(browser);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should redeem the code at the connection exchange with the app id', async () => {
    const browser = framedWithFragment(
      `#codeMitra=code-1&stateMitra=${STATE}&connectionMitra=sankhya-pass`
    );
    const fetchMock = mockFetchSequence([
      { body: CONNECTION },
      {
        body: {
          accessToken: 'access-123',
          refreshToken: 'refresh-456',
          tokenType: 'Bearer',
          allTokens: ALL_TOKENS,
        },
      },
    ]);

    const response = await flow().completeRedirect();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, request] = fetchMock.mock.calls[1];
    expect(url).toBe(EXCHANGE_URL);
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({ appId: APP_ID, code: 'code-1' });
    expect(response).toEqual({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      tokenType: 'Bearer',
      allTokens: ALL_TOKENS,
    });
    expectFragmentCleared(browser);
  });

  it('should redeem the code under a host system the connection allows', async () => {
    const browser = mockBrowser(undefined, { framed: true, hostOrigin: 'https://pampulha01.sankhyacloud.com.br' });
    browser.window.location.hash = `#codeMitra=code-1&stateMitra=${STATE}&connectionMitra=sankhya-pass`;
    const fetchMock = mockFetchSequence([{ body: CONNECTION }, { body: TOKENS }]);

    await expect(flow().completeRedirect()).resolves.toEqual(TOKENS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(CONNECTION_URL);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe(EXCHANGE_URL);
    expectFragmentCleared(browser);
  });

  it('should refuse the code under a host system the connection does not allow, without redeeming it', async () => {
    const browser = mockBrowser(undefined, { framed: true, hostOrigin: 'https://evil.example.com' });
    browser.window.location.hash = `#codeMitra=code-1&stateMitra=${STATE}&connectionMitra=sankhya-pass`;
    const fetchMock = mockFetchSequence([{ body: CONNECTION }, { body: TOKENS }]);

    await expect(flow().completeRedirect()).rejects.toThrow('not accepted under this host system');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CONNECTION_URL);
    expectFragmentCleared(browser);
  });

  it('should refuse the code when the connection publishes no origin', async () => {
    const browser = mockBrowser(undefined, { framed: true, hostOrigin: 'https://pampulha01.sankhyacloud.com.br' });
    browser.window.location.hash = `#codeMitra=code-1&stateMitra=${STATE}&connectionMitra=sankhya-pass`;
    const fetchMock = mockFetchSequence([{ body: { slug: 'sankhya-pass', name: 'Sankhya Pass' } }, { body: TOKENS }]);

    await expect(flow().completeRedirect()).rejects.toThrow('not accepted under this host system');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should refuse the code without a request when the browser does not expose the host system', async () => {
    const browser = framedWithFragment(`#codeMitra=code-1&stateMitra=${STATE}&connectionMitra=sankhya-pass`, null);
    const fetchMock = mockFetchSequence([{ body: TOKENS }]);

    await expect(flow().completeRedirect()).rejects.toThrow('exposes the host system origin');

    expect(fetchMock).not.toHaveBeenCalled();
    expectFragmentCleared(browser);
  });

  it('should clear the fragment before a refused exchange fails', async () => {
    const browser = framedWithFragment(
      `#codeMitra=code-1&stateMitra=${STATE}&connectionMitra=sankhya-pass`
    );
    mockFetchSequence([
      { body: CONNECTION },
      { body: { message: 'Invalid code', error_code: 'INVALID_EXCHANGE_CODE' }, status: 401 },
    ]);

    await expect(flow().completeRedirect()).rejects.toMatchObject({ status: 401 });

    expectFragmentCleared(browser);
  });

  it('should require a browser', async () => {
    vi.stubGlobal('window', undefined);

    await expect(flow().completeRedirect()).rejects.toThrow('only available in a browser');
  });
});

describe('isAllowedOrigin', () => {
  const allowed = ['https://skw.example.com', 'https://*.sankhyacloud.com.br'];

  it.each([
    ['https://skw.example.com', true],
    ['HTTPS://SKW.EXAMPLE.COM', true],
    ['https://pampulha01.sankhyacloud.com.br', true],
    ['https://a.b.sankhyacloud.com.br', true],
    ['https://sankhyacloud.com.br', false],
    ['https://pampulha01.sankhyacloud.com.br:8443', false],
    ['http://pampulha01.sankhyacloud.com.br', false],
    ['https://evil-sankhyacloud.com.br', false],
    ['https://sankhyacloud.com.br.evil.com', false],
    ['null', false],
  ])('should decide %s as %s', (origin, expected) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(expected);
  });

  it('should allow nothing when the connection publishes no origin', () => {
    expect(isAllowedOrigin('https://skw.example.com', [])).toBe(false);
  });
});
