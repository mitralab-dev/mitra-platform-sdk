import { describe, it, expect, vi, afterEach } from 'vitest';
import { EntitiesModule } from './entities';
import { HttpClient } from '../utils/http-client';
import { mockFetch } from '../test-utils';

const DS_ID = 'ds-123';
const BASE = 'https://api.mitra.io/data-manager';

function createEntities() {
  const httpClient = new HttpClient({ baseUrl: BASE });
  return EntitiesModule.createProxy(httpClient, DS_ID);
}

describe('EntitiesModule', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should create a table accessor dynamically via Proxy', async () => {
    mockFetch({ data: [], limit: 100, skip: 0, total: 0, hasMore: false });
    const entities = createEntities() as any;

    const result = await entities.users.list();

    expect(result).toEqual([]);
  });

  it('should cache table accessors on repeated access', () => {
    mockFetch({ data: [] });
    const entities = createEntities() as any;

    const first = entities.users;
    const second = entities.users;

    expect(first).toBe(second);
  });

  it('should list records with sort, limit, skip params', async () => {
    const fetchMock = mockFetch({ data: [{ id: 1 }], limit: 10, skip: 5, total: 1, hasMore: false });
    const entities = createEntities();

    const result = await entities.getTable('Task').list('-created_at', 10, 5);

    expect(result).toEqual([{ id: 1 }]);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`/api/v1/data-sources/${DS_ID}/tables/Task/records`);
    expect(calledUrl).toContain('sort=-created_at');
    expect(calledUrl).toContain('limit=10');
    expect(calledUrl).toContain('skip=5');
  });

  it('should list records with options object', async () => {
    const fetchMock = mockFetch({ data: [{ id: 1 }], limit: 10, skip: 0, total: 1, hasMore: false });
    const entities = createEntities();

    await entities.getTable('Task').list({ sort: '-name', limit: 10, fields: ['id', 'name'] });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('sort=-name');
    expect(calledUrl).toContain('limit=10');
    expect(calledUrl).toContain('fields=id%2Cname');
  });

  it('should filter records with query serialized as JSON', async () => {
    const fetchMock = mockFetch({ data: [{ id: 1, status: 'active' }], limit: 100, skip: 0, total: 1, hasMore: false });
    const entities = createEntities();

    await entities.getTable('Task').filter({ status: 'active' });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`q=${encodeURIComponent(JSON.stringify({ status: 'active' }))}`);
  });

  it('should get a record by ID', async () => {
    const fetchMock = mockFetch({ id: '42', name: 'Test' });
    const entities = createEntities();

    const result = await entities.getTable('Task').get('42');

    expect(result).toEqual({ id: '42', name: 'Test' });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(`${BASE}/api/v1/data-sources/${DS_ID}/tables/Task/records/42`);
  });

  it('should create a record with POST', async () => {
    const fetchMock = mockFetch({ id: '1', title: 'New' });
    const entities = createEntities();

    const result = await entities.getTable('Task').create({ title: 'New' });

    expect(result).toEqual({ id: '1', title: 'New' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/data-sources/${DS_ID}/tables/Task/records`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ title: 'New' });
  });

  it('should update a record with PUT', async () => {
    const fetchMock = mockFetch({ id: '1', title: 'Updated' });
    const entities = createEntities();

    const result = await entities.getTable('Task').update('1', { title: 'Updated' });

    expect(result).toEqual({ id: '1', title: 'Updated' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/data-sources/${DS_ID}/tables/Task/records/1`);
    expect(options.method).toBe('PUT');
  });

  it('should delete a record by ID', async () => {
    const fetchMock = mockFetch(undefined, 204);
    const entities = createEntities();

    await entities.getTable('Task').delete('1');

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/data-sources/${DS_ID}/tables/Task/records/1`);
    expect(options.method).toBe('DELETE');
  });

  it('should delete many records with query', async () => {
    const fetchMock = mockFetch({ deleted: 3 });
    const entities = createEntities();

    const result = await entities.getTable('Task').deleteMany({ status: 'done' });

    expect(result).toEqual({ deleted: 3 });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain(`/api/v1/data-sources/${DS_ID}/tables/Task/records`);
    expect(url).toContain(`q=${encodeURIComponent(JSON.stringify({ status: 'done' }))}`);
    expect(options.method).toBe('DELETE');
  });

  it('should bulk create records', async () => {
    const created = [{ id: '1', title: 'A' }, { id: '2', title: 'B' }];
    const fetchMock = mockFetch(created);
    const entities = createEntities();

    const result = await entities.getTable('Task').bulkCreate([{ title: 'A' }, { title: 'B' }]);

    expect(result).toEqual(created);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/data-sources/${DS_ID}/tables/Task/records/bulk`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual([{ title: 'A' }, { title: 'B' }]);
  });

  it('should clear proxy cache when dataSourceId changes', () => {
    mockFetch({ data: [] });
    const entities = createEntities();

    const before = entities.getTable('Task');
    entities.setDataSourceId('ds-new');
    const after = entities.getTable('Task');

    expect(before).not.toBe(after);
  });
});
