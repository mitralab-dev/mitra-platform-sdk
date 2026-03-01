import { describe, it, expect, vi, afterEach } from 'vitest';
import { IntegrationModule } from './integration';
import { HttpClient } from '../utils/http-client';
import { mockFetch } from '../test-utils';

const BASE = 'https://api.mitra.io/integration';

const fakeProxyResult = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: { data: 'test' },
  durationMs: 100,
  executionId: 'exec-1',
};

describe('IntegrationModule', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should execute a resource with params', async () => {
    const fetchMock = mockFetch(fakeProxyResult);
    const client = new HttpClient({ baseUrl: BASE });
    const integration = new IntegrationModule(client);

    const result = await integration.executeResource('res-1', { limit: 10 });

    expect(result).toEqual(fakeProxyResult);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/proxy/resources/res-1/execute`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ params: { limit: 10 } });
  });

  it('should add source SDK to execute request', async () => {
    const fetchMock = mockFetch(fakeProxyResult);
    const client = new HttpClient({ baseUrl: BASE });
    const integration = new IntegrationModule(client);

    await integration.execute('config-1', {
      method: 'GET',
      endpoint: '/users',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.source).toBe('SDK');
  });

  it('should include all fields from the proxy request', async () => {
    const fetchMock = mockFetch(fakeProxyResult);
    const client = new HttpClient({ baseUrl: BASE });
    const integration = new IntegrationModule(client);

    await integration.execute('config-1', {
      method: 'POST',
      endpoint: '/orders',
      headers: { 'X-Custom': 'value' },
      body: { item: 'test' },
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/proxy/template-configs/config-1/execute`);
    const body = JSON.parse(options.body);
    expect(body.method).toBe('POST');
    expect(body.endpoint).toBe('/orders');
    expect(body.headers).toEqual({ 'X-Custom': 'value' });
    expect(body.body).toEqual({ item: 'test' });
    expect(body.source).toBe('SDK');
  });
});
