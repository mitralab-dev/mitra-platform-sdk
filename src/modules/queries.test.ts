import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test-utils';
import { HttpClient } from '../utils/http-client';
import { QueriesModule } from './queries';

const BASE = 'https://api.mitra.io/data-manager';
const response = { rows: [{ id: 1 }], durationMs: 3 };
const result = { ...response, affectedRows: null };

describe('QueriesModule compatibility facade', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps setDataSourceId and sends the canonical query body', async () => {
    const fetchMock = mockFetch(response);
    const queries = new QueriesModule(new HttpClient({ baseUrl: BASE }));
    queries.setDataSourceId('ds-123');

    await expect(queries.execute('query/one', { status: 'active' })).resolves.toEqual(result);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/custom-queries/query%2Fone/execute`);
    expect(JSON.parse(options.body)).toEqual({
      dataSourceId: 'ds-123',
      parameters: { status: 'active' },
    });
  });

  it('requires init and defaults parameters to an empty object', async () => {
    const queries = new QueriesModule(new HttpClient({ baseUrl: BASE }));

    await expect(queries.execute('query-id')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });

    const fetchMock = mockFetch(response);
    queries.setDataSourceId('ds-123');
    await queries.execute('query-id');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      dataSourceId: 'ds-123',
      parameters: {},
    });
  });

  it('rejects a response without the canonical duration field', async () => {
    mockFetch({ rows: [] });
    const queries = new QueriesModule(new HttpClient({ baseUrl: BASE }));
    queries.setDataSourceId('ds-123');

    await expect(queries.execute('query-id')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});
