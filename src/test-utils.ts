import { vi } from 'vitest';

export interface MockedResponse {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Response headers a mocked response answers, case-insensitively like the real
 * ones. Responses declared without headers keep answering without a `headers`
 * property at all, which is what a consumer reading one has to survive.
 */
function mockHeaders(headers: Record<string, string>) {
  const entries = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]);
  return {
    get: vi.fn(
      (name: string) => entries.find(([key]) => key === name.toLowerCase())?.[1] ?? null
    ),
  };
}

function mockResponse({ body, status = 200, headers }: MockedResponse) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    ...(headers ? { headers: mockHeaders(headers) } : {}),
  };
}

export function mockFetch(response: unknown, status = 200, headers?: Record<string, string>) {
  const fn = vi.fn().mockResolvedValue(mockResponse({ body: response, status, headers }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function mockFetchSequence(responses: Array<MockedResponse>) {
  const fn = vi.fn();
  responses.forEach((response) => {
    fn.mockResolvedValueOnce(mockResponse(response));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function memoryStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    _store: store,
  };
}

export function mockLocalStorage() {
  const storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  return storage;
}

export function mockSessionStorage() {
  const storage = memoryStorage();
  vi.stubGlobal('sessionStorage', storage);
  return storage;
}

/** API gateway both auth page test suites run against, and the origin that page posts its result from. */
export const MOCK_API_URL = 'https://api.mitra.io';

/** Successful result message the auth page posts back to the window that opened it. */
export function authPageResult(state: string, result: Record<string, unknown>) {
  return { type: 'mitra-oauth-result', success: true, state, ...result };
}

export interface BrowserHarness {
  popup: Window;
  window: Window & { __mitraEnv?: { authPageUrl?: unknown } };
  localStorage: ReturnType<typeof mockLocalStorage>;
  dispatchMessage(
    data: unknown,
    options?: { origin?: string; source?: MessageEventSource | null }
  ): void;
  getStartUrl(): URL;
  getRedirectUrl(): URL;
}

/**
 * A window that can run the auth page handshake: a popup that reports itself
 * closed, a location that records where it was sent, both storages, and a
 * deterministic `crypto`.
 *
 * `window.localStorage` and the global one are the same mock on purpose: the
 * pending request of an email redirect is read from the window, and the app
 * session from the global.
 *
 * @param injectedAuthPageUrl - Value for `window.__mitraEnv.authPageUrl`.
 * Omitted leaves `__mitraEnv` out of the window entirely.
 */
export function mockBrowser(injectedAuthPageUrl?: unknown): BrowserHarness {
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const popup = {
    closed: false,
    close: vi.fn(function close(this: { closed: boolean }) {
      this.closed = true;
    }),
  } as unknown as Window;
  const location = {
    origin: 'https://app.example.com',
    href: 'https://app.example.com/orders?status=open',
    pathname: '/orders',
    search: '?status=open',
    hash: '',
    assign: vi.fn(),
  };
  const localStorageMock = mockLocalStorage();
  const sessionStorageMock = mockSessionStorage();
  const browserWindow = {
    location,
    localStorage: localStorageMock,
    sessionStorage: sessionStorageMock,
    history: { replaceState: vi.fn() },
    outerWidth: 1280,
    outerHeight: 720,
    screenX: 0,
    screenY: 0,
    screen: { width: 1280, height: 720 },
    open: vi.fn(() => popup),
    addEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
      if (type === 'message') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MessageEvent<unknown>) => void) => {
      if (type === 'message') listeners.delete(listener);
    }),
    ...(injectedAuthPageUrl !== undefined
      ? { __mitraEnv: { authPageUrl: injectedAuthPageUrl } }
      : {}),
  } as unknown as BrowserHarness['window'];

  vi.stubGlobal('window', browserWindow);
  vi.stubGlobal('crypto', {
    getRandomValues: (bytes: Uint8Array) => {
      bytes.fill(7);
      return bytes;
    },
  });

  return {
    popup,
    window: browserWindow,
    localStorage: localStorageMock,
    dispatchMessage(data, options = {}) {
      const event = {
        data,
        origin: options.origin ?? MOCK_API_URL,
        source: options.source === undefined ? popup : options.source,
      } as MessageEvent<unknown>;
      listeners.forEach((listener) => listener(event));
    },
    getStartUrl() {
      const [url] = vi.mocked(browserWindow.open).mock.calls[0];
      return new URL(url as string);
    },
    getRedirectUrl() {
      return new URL(vi.mocked(browserWindow.location.assign).mock.calls[0][0] as string);
    },
  };
}
