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

    const mitra = createClient({
      appId: 'app-1',
      apiUrl: 'https://api.mitra.io',
    });

    expect(mitra.auth).toBeDefined();
    expect(mitra.entities).toBeDefined();
    expect(mitra.functions).toBeDefined();
    expect(mitra.integration).toBeDefined();
    expect(mitra.queries).toBeDefined();
    expect(mitra.config.appId).toBe('app-1');
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
});
