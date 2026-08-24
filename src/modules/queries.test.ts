import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test-utils';
import { HttpClient } from '../utils/http-client';
import { QueriesModule } from './queries';

const BASE = 'https://api.mitra.io/data-manager';
const response = { rows: [{ id: 1 }], durationMs: 3 };

describe('QueriesModule compatibility facade', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps setDataSourceId as a compatibility no-op and sends the producer body', async () => {
    const fetchMock = mockFetch(response);
    const queries = new QueriesModule(new HttpClient({ baseUrl: BASE }));
    queries.setDataSourceId('ds-123');

    const executed = await queries.execute('query/one', { status: 'active' });

    expect(executed).toEqual(response);
    expect(executed.durationMs).toBe(3);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/custom-queries/query%2Fone/execute`);
    expect(JSON.parse(options.body)).toEqual({
      parameters: { status: 'active' },
    });
  });

  it('does not require init and defaults parameters to an empty object', async () => {
    const fetchMock = mockFetch(response);
    const queries = new QueriesModule(new HttpClient({ baseUrl: BASE }));

    await queries.execute('query-id');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      parameters: {},
    });
  });

  it('rejects a response without the canonical duration field', async () => {
    mockFetch({ rows: [] });
    const queries = new QueriesModule(new HttpClient({ baseUrl: BASE }));

    await expect(queries.execute('query-id')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});
