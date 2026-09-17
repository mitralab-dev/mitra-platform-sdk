import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOCK_API_URL as API_URL,
  mockBrowser,
  mockFetchSequence,
  type BrowserHarness,
} from '../test-utils';
import { createClient } from '../client';
import { AuthModule } from './auth';

const APP_ID = '11111111-1111-1111-1111-111111111111';
const IAM_URL = `${API_URL}/iam`;
const AUTH_PAGE_URL = `${API_URL}/sdk-auth.html`;
const MAGIC_LINK_URL = `${IAM_URL}/api/v1/auth/magic-link`;
const VERIFY_URL = `${MAGIC_LINK_URL}/verify`;
const CONFIRM_URL = `${MAGIC_LINK_URL}/confirm`;
const EXCHANGE_URL = `${MAGIC_LINK_URL}/exchange`;
const APP_ORIGIN = 'https://app.example.com';
const APP_PAGE = '/orders?status=open';
const BRAND = 'mitra';
const PENDING_KEY = `mitra_email_redirect_${APP_ID}`;
const SESSION_KEY = `mitra_auth_${APP_ID}`;
const LINK_TOKEN = 'link-token';
/** The state the deterministic `crypto` of the browser harness produces. */
const REQUEST_STATE = `email.${'07'.repeat(16)}`;
const TEN_MINUTES_MS = 10 * 60 * 1_000;
const EMAIL = 'user@test.com';
const RECEIPT = '0e4e1b1c-0000-4000-8000-000000000001';
const REQUEST_ACCEPTED = { receipt: RECEIPT, resendAfterSeconds: 60 };
const EXCHANGE_CODE_RESPONSE = { exchangeCode: 'exchange-code', expiresInSeconds: 60 };
const TOKEN_RESPONSE = {
  accessToken: 'access-123',
  refreshToken: 'refresh-456',
  tokenType: 'Bearer',
};
const CURRENT_USER_RESPONSE = {
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
  email: EMAIL,
  name: 'Test User',
  imageUrl: null,
  planId: 'plan-1',
  onboardingCompleted: false,
  language: 'pt-BR',
};
const USER = { ...CURRENT_USER_RESPONSE, tenantId: 't1' };

/** An application whose `init()` already resolved the app info, brand included. */
function signedApp(): AuthModule {
  const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });
  auth.setBrand(BRAND);
  return auth;
}

function pendingRequest(
  browser: BrowserHarness,
  state: string = REQUEST_STATE,
  createdAt: number = Date.now(),
  redirectUri: string = APP_ORIGIN
): void {
  browser.localStorage._store[PENDING_KEY] = JSON.stringify({ state, redirectUri, createdAt });
}

function landOnLink(browser: BrowserHarness, fragment = `emailToken=${LINK_TOKEN}`): void {
  browser.window.location.hash = `#${fragment}`;
}

/** What `GET /magic-link/confirm` answers about a link, without consuming it. */
function inspection(overrides: Record<string, unknown> = {}) {
  return {
    state: 'OK',
    email: EMAIL,
    appId: APP_ID,
    origin: APP_ORIGIN,
    sdkState: REQUEST_STATE,
    ...overrides,
  };
}

function requestBody(fetchMock: ReturnType<typeof mockFetchSequence>, call: number) {
  return JSON.parse(fetchMock.mock.calls[call][1].body);
}

describe('Headless email sign-in', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('requesting a code', () => {
    it('asks IAM for a message and writes down the request its link will need', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([{ body: REQUEST_ACCEPTED, status: 202 }]);
      const auth = signedApp();

      await expect(auth.requestEmailCode({ email: EMAIL })).resolves.toEqual({
        receipt: RECEIPT,
        resendAfterSeconds: 60,
      });

      expect(fetchMock.mock.calls[0][0]).toBe(MAGIC_LINK_URL);
      expect(requestBody(fetchMock, 0)).toEqual({
        email: EMAIL,
        brand: BRAND,
        language: 'pt-BR',
        appId: APP_ID,
        origin: APP_ORIGIN,
        state: REQUEST_STATE,
      });
      expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
      expect(JSON.parse(browser.localStorage._store[PENDING_KEY])).toEqual({
        state: REQUEST_STATE,
        redirectUri: APP_ORIGIN,
        createdAt: expect.any(Number),
      });
    });

    it.each([
      ['takes the language the application asked for', 'en' as const, 'pt-BR', 'en'],
      ['falls back to the browser language', undefined, 'en-US', 'en'],
      ['writes in Portuguese for a language the platform does not write', undefined, 'fr-FR', 'pt-BR'],
      ['writes in Portuguese when the browser says nothing', undefined, undefined, 'pt-BR'],
    ])('%s', async (_case, requested, browserLanguage, expected) => {
      const browser = mockBrowser();
      if (browserLanguage) {
        Object.assign(browser.window, { navigator: { language: browserLanguage } });
      }
      const fetchMock = mockFetchSequence([{ body: REQUEST_ACCEPTED, status: 202 }]);

      await signedApp().requestEmailCode({
        email: EMAIL,
        ...(requested ? { language: requested } : {}),
      });

      expect(requestBody(fetchMock, 0).language).toBe(expected);
    });

    it('refuses to ask before init() resolved the app info, instead of guessing a brand', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([]);
      const auth = new AuthModule(APP_ID, IAM_URL, { apiUrl: API_URL });

      await expect(auth.requestEmailCode({ email: EMAIL })).rejects.toMatchObject({
        name: 'MitraApiError',
        status: 0,
        code: 'INVALID_CONFIGURATION',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
    });

    it('sends the brand init() read from the app info', async () => {
      mockBrowser();
      const fetchMock = mockFetchSequence([
        {
          body: {
            dataSourceId: null,
            allowSignup: true,
            emailLoginEnabled: true,
            brand: 'acme',
          },
        },
        { body: REQUEST_ACCEPTED, status: 202 },
      ]);
      const mitra = createClient({ appId: APP_ID, apiUrl: API_URL });

      await mitra.init();
      await mitra.auth.requestEmailCode({ email: EMAIL });

      expect(requestBody(fetchMock, 1).brand).toBe('acme');
    });

    it('replaces the pending request when the person asks for another message', async () => {
      const browser = mockBrowser();
      mockFetchSequence([
        { body: REQUEST_ACCEPTED, status: 202 },
        { body: REQUEST_ACCEPTED, status: 202 },
      ]);
      const auth = signedApp();

      await auth.requestEmailCode({ email: EMAIL });
      await auth.requestEmailCode({ email: EMAIL });

      expect(
        vi.mocked(browser.localStorage.setItem).mock.calls.filter(([key]) => key === PENDING_KEY)
      ).toHaveLength(2);
    });

    it('keeps the request of the message already sent when IAM refuses a resend', async () => {
      const browser = mockBrowser();
      mockFetchSequence([
        { body: REQUEST_ACCEPTED, status: 202 },
        { status: 429, body: { message: 'Too many requests', error_code: 'RATE_LIMITED' } },
      ]);
      const auth = signedApp();

      await auth.requestEmailCode({ email: EMAIL });
      const pending = browser.localStorage._store[PENDING_KEY];

      await expect(auth.requestEmailCode({ email: EMAIL })).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });

      expect(browser.localStorage._store[PENDING_KEY]).toBe(pending);
      expect(
        vi.mocked(browser.localStorage.setItem).mock.calls.filter(([key]) => key === PENDING_KEY)
      ).toHaveLength(1);
    });

    it.each([
      ['reports how long IAM asked the person to wait', { 'Retry-After': '30' }, 30],
      ['reports no delay when CORS withholds the header', undefined, null],
    ])('%s', async (_case, headers, expected) => {
      mockBrowser();
      mockFetchSequence([{
        status: 429,
        body: { message: 'Too many requests', error_code: 'RATE_LIMITED' },
        ...(headers ? { headers } : {}),
      }]);

      await expect(signedApp().requestEmailCode({ email: EMAIL })).rejects.toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
        retryAfterSeconds: expected,
      });
    });

    it.each([
      [{ resendAfterSeconds: 60 }],
      [{ receipt: '', resendAfterSeconds: 60 }],
      [{ receipt: RECEIPT }],
      [{ receipt: RECEIPT, resendAfterSeconds: '60' }],
    ])('rejects an accepted request it cannot read %#', async (body) => {
      mockBrowser();
      mockFetchSequence([{ body, status: 202 }]);

      await expect(signedApp().requestEmailCode({ email: EMAIL })).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    });

    it('requires browser APIs', async () => {
      vi.stubGlobal('window', undefined);
      const auth = signedApp();

      await expect(auth.requestEmailCode({ email: EMAIL })).rejects.toThrow(
        'only available in a browser'
      );
      await expect(auth.verifyEmailCode({ receipt: RECEIPT, code: '123456' })).rejects.toThrow(
        'only available in a browser'
      );
    });
  });

  describe('verifying the code', () => {
    it('redeems the exchange code the verification returns and hydrates the session', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([
        { body: EXCHANGE_CODE_RESPONSE },
        { body: TOKEN_RESPONSE },
        { body: CURRENT_USER_RESPONSE },
      ]);
      pendingRequest(browser);
      const auth = signedApp();

      await expect(auth.verifyEmailCode({ receipt: RECEIPT, code: '123456' })).resolves.toEqual(USER);

      expect(fetchMock.mock.calls[0][0]).toBe(VERIFY_URL);
      expect(requestBody(fetchMock, 0)).toEqual({ receipt: RECEIPT, code: '123456' });
      expect(fetchMock.mock.calls[1][0]).toBe(EXCHANGE_URL);
      expect(requestBody(fetchMock, 1)).toEqual({ appId: APP_ID, code: 'exchange-code' });
      expect(JSON.parse(browser.localStorage._store[SESSION_KEY])).toEqual({
        user: USER,
        token: 'access-123',
        refreshToken: 'refresh-456',
      });
      // The challenge is spent, and so is the link the same message carried.
      expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
    });

    it.each([
      [401, 'INVALID_CODE'],
      [401, 'MAGIC_LINK_INVALID'],
      [409, 'MAGIC_LINK_EXPIRED'],
      [409, 'MAGIC_LINK_USED'],
      [409, 'APP_ACCESS_LIMIT_REACHED'],
      [403, 'SIGNUP_NOT_ALLOWED'],
      [403, 'APP_ACCESS_REQUIRED'],
      [403, 'APP_ACCESS_REVOKED'],
      [400, 'VALIDATION_FAILED'],
    ])('surfaces %i %s without spending the pending request', async (status, code) => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([{ status, body: { message: 'Refused', error_code: code } }]);
      pendingRequest(browser);
      const auth = signedApp();

      await expect(auth.verifyEmailCode({ receipt: RECEIPT, code: '123456' })).rejects.toMatchObject({
        name: 'MitraApiError',
        status,
        code,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(auth.accessToken).toBeNull();
      expect(browser.localStorage._store[PENDING_KEY]).toBeDefined();
    });

    it.each([
      [{}],
      [{ exchangeCode: '' }],
      [{ exchangeCode: 42 }],
    ])('rejects a verification it cannot read %#', async (body) => {
      mockBrowser();
      const fetchMock = mockFetchSequence([{ body }]);

      await expect(
        signedApp().verifyEmailCode({ receipt: RECEIPT, code: '123456' })
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('landing on the link', () => {
    it('inspects the link, spends it, and signs the person in', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([
        { body: inspection() },
        { body: EXCHANGE_CODE_RESPONSE },
        { body: TOKEN_RESPONSE },
        { body: CURRENT_USER_RESPONSE },
      ]);
      pendingRequest(browser);
      const auth = signedApp();

      landOnLink(browser);
      await expect(auth.completeEmailSignInRedirect()).resolves.toEqual(USER);

      expect(fetchMock.mock.calls[0][0]).toBe(`${CONFIRM_URL}?token=${LINK_TOKEN}`);
      expect(fetchMock.mock.calls[0][1].method).toBe('GET');
      expect(fetchMock.mock.calls[1][0]).toBe(CONFIRM_URL);
      expect(fetchMock.mock.calls[1][1].method).toBe('POST');
      expect(requestBody(fetchMock, 1)).toEqual({ token: LINK_TOKEN });
      expect(fetchMock.mock.calls[2][0]).toBe(EXCHANGE_URL);
      expect(requestBody(fetchMock, 2)).toEqual({ appId: APP_ID, code: 'exchange-code' });
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', APP_PAGE);
      expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
      expect(JSON.parse(browser.localStorage._store[SESSION_KEY]).user).toEqual(USER);
    });

    it('takes only the link out of a fragment the application routes on', async () => {
      const browser = mockBrowser();
      mockFetchSequence([
        { body: inspection() },
        { body: EXCHANGE_CODE_RESPONSE },
        { body: TOKEN_RESPONSE },
        { body: CURRENT_USER_RESPONSE },
      ]);
      pendingRequest(browser);
      const auth = signedApp();

      landOnLink(browser, `/orders/1&emailToken=${LINK_TOKEN}&tab=items`);
      await expect(auth.completeEmailSignInRedirect()).resolves.toEqual(USER);

      expect(browser.window.history.replaceState).toHaveBeenCalledWith(
        {},
        '',
        `${APP_PAGE}#/orders/1&tab=items`
      );
    });

    it('spends nothing when this browser never asked for the message', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([]);
      const auth = signedApp();

      landOnLink(browser);
      await expect(auth.completeEmailSignInRedirect()).resolves.toBeNull();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', APP_PAGE);
    });

    it.each([['emailToken'], ['emailToken=']])(
      'reads no link out of a fragment that only carries %s',
      async (fragment) => {
        const browser = mockBrowser();
        const fetchMock = mockFetchSequence([]);
        pendingRequest(browser);
        const auth = signedApp();

        landOnLink(browser, fragment);
        await expect(auth.completeEmailSignInRedirect()).resolves.toBeNull();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(browser.localStorage._store[PENDING_KEY]).toBeDefined();
      }
    );

    it('spends nothing when the request pending here is older than ten minutes', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([]);
      pendingRequest(browser, REQUEST_STATE, Date.now() - TEN_MINUTES_MS - 1);
      const auth = signedApp();

      landOnLink(browser);
      await expect(auth.completeEmailSignInRedirect()).resolves.toBeNull();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.localStorage._store[PENDING_KEY]).toBeUndefined();
    });

    it('does not consume a link that names another request, and keeps that one pending', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([{ body: inspection({ sdkState: 'email.deadbeef' }) }]);
      pendingRequest(browser);
      const auth = signedApp();

      landOnLink(browser);
      await expect(auth.completeEmailSignInRedirect()).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(browser.localStorage._store[PENDING_KEY]).toBeDefined();
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', APP_PAGE);
    });

    it('does not consume a link IAM validated for another origin', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([
        { body: inspection({ origin: 'https://other.example.com' }) },
      ]);
      pendingRequest(browser);
      const auth = signedApp();

      landOnLink(browser);
      await expect(auth.completeEmailSignInRedirect()).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(browser.localStorage._store[PENDING_KEY]).toBeDefined();
    });

    it.each([
      ['EXPIRED', 409, 'MAGIC_LINK_EXPIRED'],
      ['USED', 409, 'MAGIC_LINK_USED'],
      ['INVALID', 401, 'MAGIC_LINK_INVALID'],
      ['A_VERDICT_FROM_A_NEWER_IAM', 401, 'MAGIC_LINK_INVALID'],
    ])('reports a %s link once, without consuming it', async (state, status, code) => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([{ body: inspection({ state }) }]);
      pendingRequest(browser);
      const auth = signedApp();

      landOnLink(browser);
      await expect(auth.completeEmailSignInRedirect()).rejects.toMatchObject({
        name: 'MitraApiError',
        status,
        code,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', APP_PAGE);
    });

    it('rejects an inspection it cannot read without consuming the link', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([{ body: { email: EMAIL } }]);
      pendingRequest(browser);
      const auth = signedApp();

      landOnLink(browser);
      await expect(auth.completeEmailSignInRedirect()).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', APP_PAGE);
    });

    it('still completes the platform auth page fragment, which knows nothing of links', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([
        { body: TOKEN_RESPONSE },
        { body: CURRENT_USER_RESPONSE },
      ]);
      const pageState = 'email.0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
      pendingRequest(browser, pageState, Date.now(), AUTH_PAGE_URL);
      const auth = signedApp();

      browser.window.location.hash = `#codeMitra=page-code&stateMitra=${pageState}`;
      await expect(auth.completeEmailSignInRedirect()).resolves.toEqual(USER);

      expect(fetchMock.mock.calls[0][0]).toBe(EXCHANGE_URL);
      expect(requestBody(fetchMock, 0)).toEqual({ appId: APP_ID, code: 'page-code' });
      expect(browser.window.history.replaceState).toHaveBeenCalledWith({}, '', APP_PAGE);
    });

    it('leaves a link alone at a startup that also asks Google and Microsoft', async () => {
      const browser = mockBrowser();
      const fetchMock = mockFetchSequence([]);
      pendingRequest(browser);
      const auth = signedApp();

      landOnLink(browser);

      await expect(auth.completeGoogleSignInRedirect()).resolves.toBeNull();
      await expect(auth.completeMicrosoftSignInRedirect()).resolves.toBeNull();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(browser.window.history.replaceState).not.toHaveBeenCalled();
      expect(browser.localStorage._store[PENDING_KEY]).toBeDefined();
    });
  });
});
