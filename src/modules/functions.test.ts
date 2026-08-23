import { describe, it, expect, vi, afterEach } from 'vitest';
import { FunctionsModule } from './functions';
import { HttpClient } from '../utils/http-client';
import { mockFetch, mockFetchSequence } from '../test-utils';

const BASE = 'https://api.mitra.io/functions';

const fakeExecution = {
  id: 'exec-1',
  functionId: 'fn-1',
  functionVersionId: 'v-1',
  status: 'COMPLETED',
  input: { key: 'value' },
  output: { result: 42 },
  errorMessage: null,
  logs: null,
  durationMs: 150,
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('FunctionsModule', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should execute a function with input', async () => {
    const fetchMock = mockFetch(fakeExecution);
    const client = new HttpClient({ baseUrl: BASE });
    const functions = new FunctionsModule(client);

    const result = await functions.execute('fn-1', { key: 'value' });

    expect(result).toEqual(fakeExecution);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/functions/fn-1/execute`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ input: { key: 'value' } });
    expect(options.headers['X-Invocation-Type']).toBe('sync');
  });

  it('should execute a function without input', async () => {
    const fetchMock = mockFetch(fakeExecution);
    const client = new HttpClient({ baseUrl: BASE });
    const functions = new FunctionsModule(client);

    await functions.execute('fn-1');

    const [, options] = fetchMock.mock.calls[0];
    expect(options.body).toBeUndefined();
    expect(options.headers['X-Invocation-Type']).toBe('sync');
  });

  it('accepts the producer nullable input contract from Core', async () => {
    const nullableInputExecution = { ...fakeExecution, input: null };
    mockFetch(nullableInputExecution);
    const client = new HttpClient({ baseUrl: BASE });
    const functions = new FunctionsModule(client);

    await expect(functions.execute('fn-1')).resolves.toEqual(nullableInputExecution);
  });

  it('supports async execution, status polling, and cancellation through Core', async () => {
    const fetchMock = mockFetchSequence([
      { body: fakeExecution },
      { body: fakeExecution },
      { body: undefined, status: 204 },
    ]);
    const client = new HttpClient({ baseUrl: BASE });
    const functions = new FunctionsModule(client);

    await expect(functions.executeAsync('fn-1', { key: 'value' })).resolves.toEqual(fakeExecution);
    await expect(functions.getExecution('exec-1')).resolves.toEqual(fakeExecution);
    await expect(functions.cancelExecution('exec-1')).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/v1/functions/fn-1/execute`);
    expect(fetchMock.mock.calls[0][1].headers['X-Invocation-Type']).toBe('async');
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/api/v1/executions/exec-1`);
    expect(fetchMock.mock.calls[1][1].method).toBe('GET');
    expect(fetchMock.mock.calls[2][0]).toBe(`${BASE}/api/v1/executions/exec-1/cancel`);
    expect(fetchMock.mock.calls[2][1].method).toBe('POST');
  });
});
