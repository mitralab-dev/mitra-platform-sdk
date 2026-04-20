import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueriesModule } from './queries';
import { HttpClient } from '../utils/http-client';
import { mockFetch } from '../test-utils';

const BASE = 'https://api.mitra.io/data-manager';

const fakeResult = { rows: [{ id: 1, name: 'Test' }], affectedRows: null };

describe('QueriesModule', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should execute a query with parameters', async () => {
    const fetchMock = mockFetch(fakeResult);
    const client = new HttpClient({ baseUrl: BASE });
    const queries = new QueriesModule(client);
    queries.setDataSourceId('ds-123');

    const result = await queries.execute('q-1', { status: 'active' });

    expect(result).toEqual(fakeResult);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/custom-queries/q-1/execute`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      datasourceId: 'ds-123',
      parameters: { status: 'active' },
    });
  });

  it('should execute a query without parameters', async () => {
    const fetchMock = mockFetch(fakeResult);
    const client = new HttpClient({ baseUrl: BASE });
    const queries = new QueriesModule(client);
    queries.setDataSourceId('ds-123');

    await queries.execute('q-1');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ datasourceId: 'ds-123', parameters: undefined });
  });
});
