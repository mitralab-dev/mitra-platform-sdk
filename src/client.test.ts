import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClient } from './client';
import { mockFetch, mockFetchSequence, mockLocalStorage } from './test-utils';

describe('createClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should create a client with all modules and correct service URLs', () => {
    mockLocalStorage();
    mockFetch({});

    const config = {
      appId: 'app-1',
      apiUrl: 'https://api.mitra.io',
    };
    const mitra = createClient(config);

    expect(mitra.auth).toBeDefined();
    expect(mitra.entities).toBeDefined();
    expect(mitra.functions).toBeDefined();
    expect(mitra.integration).toBeDefined();
    expect(mitra.queries).toBeDefined();
    expect(mitra.config.appId).toBe('app-1');
    expect(mitra.config).toBe(config);
    expect(mitra.allowSignup).toBe(true);
  });

  it('should fetch app info and set dataSourceId on init', async () => {
    mockLocalStorage();
    const fetchMock = mockFetch({ dataSourceId: 'ds-resolved', allowSignup: false });

    const mitra = createClient({
      appId: 'app-1',
      apiUrl: 'https://api.mitra.io',
    });

    await mitra.init();

    // Verify the correct endpoint was called
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://api.mitra.io/code-studio/api/v1/apps/app-1/info');
    expect(mitra.allowSignup).toBe(false);
  });

  it('should not execute init twice', async () => {
    mockLocalStorage();
    const fetchMock = mockFetch({ dataSourceId: 'ds-1', allowSignup: true });

    const mitra = createClient({
      appId: 'app-1',
      apiUrl: 'https://api.mitra.io',
    });

    await mitra.init();
    await mitra.init();

    // Only one fetch call for init
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { dataSourceId: '', allowSignup: true },
    { dataSourceId: 'ds-1' },
    { dataSourceId: 'ds-1', allowSignup: 'true' },
  ])('should reject invalid app info payload %#', async (response) => {
    mockLocalStorage();
    mockFetch(response);
    const mitra = createClient({
      appId: 'app-1',
      apiUrl: 'https://api.mitra.io',
    });

    await expect(mitra.init()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(mitra.allowSignup).toBe(true);
  });

  it('should retry init after an invalid response', async () => {
    mockLocalStorage();
    const fetchMock = mockFetchSequence([
      { body: { dataSourceId: 'ds-1' } },
      { body: { dataSourceId: 'ds-1', allowSignup: false } },
    ]);
    const mitra = createClient({
      appId: 'app-1',
      apiUrl: 'https://api.mitra.io',
    });

    await expect(mitra.init()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(mitra.init()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mitra.allowSignup).toBe(false);
  });

  it('should not serialize persisted access or refresh tokens', () => {
    const accessToken = 'persisted-access-token';
    const refreshToken = 'persisted-refresh-token';
    const storage = mockLocalStorage();
    storage._store['mitra_auth_app-1'] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: accessToken,
      refreshToken,
    });
    mockFetch({});

    const mitra = createClient({
      appId: 'app-1',
      apiUrl: 'https://api.mitra.io',
    });
    const serialized = JSON.stringify(mitra);

    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(refreshToken);
    expect(Object.keys(mitra.auth)).not.toContain('_accessToken');
    expect(Object.keys(mitra.auth)).not.toContain('_refreshToken');
  });
});
