import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClient } from './client';
import { mockFetch, mockFetchSequence, mockLocalStorage } from './test-utils';

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

const functionExecution = {
  id: 'exec-1',
  functionId: 'fn-1',
  functionVersionId: 'version-1',
  status: 'PENDING',
  input: {},
  output: null,
  errorMessage: null,
  logs: null,
  durationMs: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-08-22T00:00:00Z',
};

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
    expect(mitra.publicFunctions).toBeDefined();
    expect(mitra.agentTasks).toBeDefined();
    expect(mitra.agentCredentials).toBeDefined();
    expect(mitra.integration).toBeDefined();
    expect(mitra.queries).toBeDefined();
    expect(mitra.config.appId).toBe('app-1');
    expect(mitra.config).toBe(config);
    expect(mitra.allowSignup).toBe(true);
  });

  it('should fetch app info and update public app config on init', async () => {
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

  it('should initialize an app without a Data Source', async () => {
    mockLocalStorage();
    mockFetchSequence([
      { body: { dataSourceId: null, allowSignup: false } },
      { body: { rows: [], affectedRows: null, durationMs: 1 } },
    ]);

    const mitra = createClient({
      appId: 'app-1',
      apiUrl: 'https://api.mitra.io',
    });

    await expect(mitra.init()).resolves.toBeUndefined();
    expect(mitra.allowSignup).toBe(false);
    await expect(mitra.queries.execute('query-1')).resolves.toMatchObject({ rows: [] });
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

  it('keeps public Functions anonymous and routes Agent modules directly to Copilot', async () => {
    const storage = mockLocalStorage();
    storage._store['mitra_auth_app-1'] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: 'app-access',
      refreshToken: 'app-refresh',
    });
    const fetchMock = mockFetchSequence([
      { body: { success: true, output: { value: 42 }, error: null } },
      { body: { id: 'exec-public', status: 'PENDING' } },
      { body: [{
        provider: 'ANTHROPIC',
        connected: true,
        credentialType: 'OAUTH',
        accountEmail: 'user@example.com',
        maskedApiKey: null,
      }] },
    ]);
    const mitra = createClient({ appId: 'app-1', apiUrl: 'https://api.mitra.io' });

    await expect(mitra.publicFunctions.execute('public-fn', { value: 42 })).resolves.toEqual({
      success: true,
      output: { value: 42 },
      error: null,
    });
    await expect(mitra.publicFunctions.executeAsync('public-fn')).resolves.toEqual({
      id: 'exec-public',
      status: 'PENDING',
    });
    await expect(mitra.agentCredentials.list()).resolves.toHaveLength(1);

    const [, publicOptions] = fetchMock.mock.calls[0];
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.mitra.io/functions/public/v1/functions/public-fn/execute'
    );
    expect(publicOptions.headers.Authorization).toBeUndefined();
    expect(publicOptions.headers['X-App-Id']).toBeUndefined();
    expect(publicOptions.headers['X-Invocation-Type']).toBe('sync');

    expect(fetchMock.mock.calls[1][1].headers['X-Invocation-Type']).toBe('async');
    const [, agentOptions] = fetchMock.mock.calls[2];
    expect(fetchMock.mock.calls[2][0]).toBe('https://api.mitra.io/copilot/api/v1/credentials');
    expect(agentOptions.headers.Authorization).toBe('Bearer app-access');
    expect(agentOptions.headers['X-App-Id']).toBe('app-1');
  });

  it('should proceed after a transient proactive failure and use reactive refresh on 401', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const oldAccess = jwt({ app_id: 'app-1', exp: nowSeconds - 1 });
    const oldRefresh = jwt({ app_id: 'app-1', exp: nowSeconds + 3_600 });
    const newAccess = jwt({ app_id: 'app-1', exp: nowSeconds + 3_600 });
    const newRefresh = jwt({ app_id: 'app-1', exp: nowSeconds + 7_200 });
    const storage = mockLocalStorage();
    storage._store['mitra_auth_app-1'] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: oldAccess,
      refreshToken: oldRefresh,
    });
    const fetchMock = mockFetchSequence([
      { body: { message: 'Unavailable' }, status: 503 },
      { body: { message: 'Expired' }, status: 401 },
      {
        body: { accessToken: newAccess, refreshToken: newRefresh, tokenType: 'Bearer' },
      },
      { body: functionExecution },
    ]);
    const mitra = createClient({ appId: 'app-1', apiUrl: 'https://api.mitra.io' });

    await expect(mitra.functions.execute('fn-1')).resolves.toEqual(functionExecution);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.mitra.io/iam/api/v1/auth/refresh-token'
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${oldAccess}`);
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://api.mitra.io/iam/api/v1/auth/refresh-token'
    );
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe(`Bearer ${newAccess}`);
  });

  it('should run proactive refresh on every protected native service transport', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredAccess = () => jwt({ app_id: 'app-1', exp: nowSeconds - 1 });
    const freshAccess = () => jwt({ app_id: 'app-1', exp: nowSeconds + 3_600 });
    const freshRefresh = jwt({ app_id: 'app-1', exp: nowSeconds + 7_200 });
    const storage = mockLocalStorage();
    storage._store['mitra_auth_app-1'] = JSON.stringify({
      user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
      token: expiredAccess(),
      refreshToken: freshRefresh,
    });
    const tokenResponse = () => ({
      accessToken: freshAccess(),
      refreshToken: freshRefresh,
      tokenType: 'Bearer',
    });
    const integrationResult = {
      status: 200,
      headers: {},
      body: { ok: true },
      durationMs: 2,
      executionId: 'integration-exec-1',
    };
    const fetchMock = mockFetchSequence([
      { body: tokenResponse() },
      { body: { id: 'record-1' } },
      { body: tokenResponse() },
      { body: functionExecution },
      { body: tokenResponse() },
      { body: integrationResult },
    ]);
    const mitra = createClient({ appId: 'app-1', apiUrl: 'https://api.mitra.io' });

    await mitra.entities.Task!.create({ title: 'Task' });
    mitra.auth.setToken(expiredAccess());
    await mitra.functions.execute('fn-1');
    mitra.auth.setToken(expiredAccess());
    await mitra.integration.executeResource('resource-1');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.mitra.io/iam/api/v1/auth/refresh-token',
      'https://api.mitra.io/data-manager/api/v1/tables/Task/records',
      'https://api.mitra.io/iam/api/v1/auth/refresh-token',
      'https://api.mitra.io/functions/api/v1/functions/fn-1/execute',
      'https://api.mitra.io/iam/api/v1/auth/refresh-token',
      'https://api.mitra.io/integration/api/v1/proxy/resources/resource-1/execute',
    ]);
  });
});
