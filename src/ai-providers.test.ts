import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createClient,
  MitraApiError,
  type AiProviders,
  type AiProvidersModule,
  type IncludedAiQuota,
  type IncludedAiQuotaWindow,
  type ManagedAiProfile,
  type MitraClient,
  type OpencodeAiProvider,
} from './index';
import { mockFetch, mockLocalStorage } from './test-utils';

const managedAiProfile: ManagedAiProfile = {
  profile: 'IMMERSION',
  agentType: 'IMMERSION',
  selectionMode: 'FORCED',
  model: 'immersion',
  requiredScope: 'ACCOUNT',
};
const quotaWindow: IncludedAiQuotaWindow = {
  limit: 100,
  left: 0,
  leftCenticredits: 0,
  resetsAt: '2026-10-30T00:00:00Z',
};
const exhaustedQuota: IncludedAiQuota = {
  planCode: 'FREE',
  blockingWindow: 'DAY',
  windows: { day: quotaWindow },
  remainingTokens: 0,
};
const opencode: OpencodeAiProvider = {
  connected: false,
  presetId: null,
  presetName: null,
  authMethod: null,
  providerId: null,
  baseUrl: null,
  models: null,
};
const providers: AiProviders = {
  activeEngine: 'CODEX',
  includedAiAvailable: false,
  includedAiQuota: null,
  activeCustomProviderId: null,
  customProviders: [],
  opencode,
};

function authenticatedClient(onError?: (error: MitraApiError) => void) {
  const storage = mockLocalStorage();
  storage._store['mitra_auth_app-1'] = JSON.stringify({
    user: { id: 'u1', tenantId: 't1', email: 'user@test.com', name: null },
    token: 'app-access',
    refreshToken: 'app-refresh',
  });
  const client = createClient({ appId: 'app-1', apiUrl: 'https://api.mitra.io/', onError });
  return { client, storage };
}

describe('client.aiProviders', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['older backend', providers],
    ['ineligible', { ...providers, managedAiProfile: null }],
    ['managed without personal quota', { ...providers, managedAiProfile }],
    ['managed with exhausted quota', { ...providers, includedAiQuota: exhaustedQuota, managedAiProfile }],
  ])('reads %s with app and bearer headers without writing preferences', async (_case, response) => {
    const fetchMock = mockFetch(response);
    const { client, storage } = authenticatedClient();
    const persisted = { ...storage._store };
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
    storage.clear.mockClear();

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(client.aiProviders.get()).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://api.mitra.io/copilot/api/v1/ai-providers',
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Id': 'app-1',
          Authorization: 'Bearer app-access',
        },
        body: undefined,
        redirect: 'manual',
      }
    );
    expect(storage._store).toEqual(persisted);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it('exposes only the typed read module at the public client boundary', () => {
    const { client } = authenticatedClient();

    expect(Object.keys(client.aiProviders)).toEqual(['get']);
    expectTypeOf(client.aiProviders.get).returns.toEqualTypeOf<Promise<AiProviders>>();
    expectTypeOf<keyof AiProvidersModule>().toEqualTypeOf<'get'>();
    expectTypeOf<Pick<MitraClient, 'aiProviders'>>().toEqualTypeOf<{
      readonly aiProviders: AiProvidersModule;
    }>();
  });

  it.each([
    [403, 'IMMERSION_NOT_ELIGIBLE'],
    [409, 'IMMERSION_REQUIRED'],
    [503, 'IMMERSION_UNAVAILABLE'],
    [409, 'IMMERSION_PROFILE_IMMUTABLE'],
    [404, 'NOT_FOUND'],
  ])('propagates structured HTTP %s %s to the caller and onError', async (status, code) => {
    const body = { message: 'Provider request refused', error_code: code, profile: 'IMMERSION' };
    const fetchMock = mockFetch(body, status, { 'Retry-After': '30' });
    const onError = vi.fn();
    const { client } = authenticatedClient(onError);

    const error = await client.aiProviders.get().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MitraApiError);
    expect(error).toMatchObject({
      status,
      code,
      message: body.message,
      details: body,
      retryAfterSeconds: 30,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the Platform error factory for an invalid Core response', async () => {
    mockFetch({ managedAiProfile });
    const { client } = authenticatedClient();

    const error = await client.aiProviders.get().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MitraApiError);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
