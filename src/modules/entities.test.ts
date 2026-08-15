import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test-utils';
import { HttpClient, MitraApiError } from '../utils/http-client';
import { EntitiesModule, type EntitiesProxy } from './entities';

const BASE = 'https://api.mitra.io/data-manager';

function createEntities(): EntitiesProxy {
  const httpClient = new HttpClient({ baseUrl: BASE });
  return EntitiesModule.createProxy(httpClient, 'legacy-data-source') as EntitiesProxy;
}

describe('EntitiesModule compatibility facade', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps dynamic and typed access on the current records path', async () => {
    const fetchMock = mockFetch({
      data: [{ id: 1 }],
      limit: 10,
      skip: 5,
      total: 1,
      hasMore: false,
    });
    const entities = createEntities();

    const dynamic = entities.Task;
    expect(dynamic).toBe(entities.Task);
    await expect(
      entities.getTable<{ id: number }>('Order items').list('-created_at', 10, 5)
    ).resolves.toEqual([{ id: 1 }]);

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/v1/tables/Order%20items/records');
    expect(calledUrl).not.toContain('data-sources');
    expect(calledUrl).toContain('sort=-created_at');
    expect(calledUrl).toContain('limit=10');
    expect(calledUrl).toContain('skip=5');
  });

  it('delegates writes through the browser transport', async () => {
    const fetchMock = mockFetch({ id: '1', title: 'Created' });
    const entities = createEntities();

    await expect(entities.Task!.create({ title: 'Created' })).resolves.toEqual({
      id: '1',
      title: 'Created',
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/tables/Task/records`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ title: 'Created' });
  });

  it('preserves setDataSourceId and clears cached table facades', () => {
    mockFetch({ data: [] });
    const entities = createEntities();

    const before = entities.getTable('Task');
    entities.setDataSourceId('new-data-source');
    const after = entities.getTable('Task');

    expect(before).not.toBe(after);
  });

  it('maps core contract failures to the Platform MitraApiError', async () => {
    mockFetch({ records: [] });
    const entities = createEntities();

    await expect(entities.Task!.list()).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_RESPONSE',
    });
    await expect(entities.Task!.deleteMany({})).rejects.toBeInstanceOf(MitraApiError);
  });
});
