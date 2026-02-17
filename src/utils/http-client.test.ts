import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient, MitraApiError } from './http-client';
import { mockFetch } from '../test-utils';

describe('HttpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should make a GET request with correct URL', async () => {
    const fetchMock = mockFetch({ id: 1 });
    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    await client.get('/users');

    expect(fetchMock).toHaveBeenCalledWith('https://api.mitra.io/users', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
  });

  it('should serialize query params in the URL', async () => {
    const fetchMock = mockFetch([]);
    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    await client.get('/users', { limit: 10, skip: 0, active: true });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('limit=10');
    expect(calledUrl).toContain('skip=0');
    expect(calledUrl).toContain('active=true');
  });

  it('should omit undefined query params', async () => {
    const fetchMock = mockFetch([]);
    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    await client.get('/users', { limit: 10, name: undefined });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('limit=10');
    expect(calledUrl).not.toContain('name');
  });

  it('should POST with JSON stringified body', async () => {
    const fetchMock = mockFetch({ id: 1, name: 'John' });
    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    await client.post('/users', { name: 'John' });

    expect(fetchMock).toHaveBeenCalledWith('https://api.mitra.io/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'John' }),
    });
  });

  it('should PUT with correct method and body', async () => {
    const fetchMock = mockFetch({ id: 1, name: 'Updated' });
    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    await client.put('/users/1', { name: 'Updated' });

    expect(fetchMock).toHaveBeenCalledWith('https://api.mitra.io/users/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    });
  });

  it('should DELETE with correct method', async () => {
    const fetchMock = mockFetch(undefined, 204);
    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    await client.delete('/users/1');

    expect(fetchMock).toHaveBeenCalledWith('https://api.mitra.io/users/1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
  });

  it('should include Authorization header when token is available', async () => {
    const fetchMock = mockFetch({ id: 1 });
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      getToken: () => 'my-jwt-token',
    });

    await client.get('/users');

    expect(fetchMock).toHaveBeenCalledWith('https://api.mitra.io/users', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer my-jwt-token',
      },
      body: undefined,
    });
  });

  it('should NOT include Authorization header when token is null', async () => {
    const fetchMock = mockFetch({ id: 1 });
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      getToken: () => null,
    });

    await client.get('/users');

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('should include default headers in every request', async () => {
    const fetchMock = mockFetch({ id: 1 });
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      defaultHeaders: { 'X-App-Id': 'app-123' },
    });

    await client.get('/users');

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-App-Id']).toBe('app-123');
  });

  it('should retry on 401 when onUnauthorized returns true', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: vi.fn().mockResolvedValue({ message: 'Unauthorized' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ id: 1 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      onUnauthorized,
    });

    const result = await client.get('/users');

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: 1 });
  });

  it('should throw MitraApiError on 401 when onUnauthorized returns false', async () => {
    mockFetch({ message: 'Unauthorized', error_code: 'AUTH_EXPIRED' }, 401);

    const onUnauthorized = vi.fn().mockResolvedValue(false);
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      onUnauthorized,
    });

    await expect(client.get('/users')).rejects.toThrow(MitraApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('should not retry infinitely on 401 (isRetry flag)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ message: 'Unauthorized' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      onUnauthorized,
    });

    await expect(client.get('/users')).rejects.toThrow(MitraApiError);
    // First call triggers 401 → onUnauthorized → retry
    // Retry also gets 401 → but isRetry=true → no more retries → throws
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should return undefined for 204 No Content', async () => {
    mockFetch(undefined, 204);
    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    const result = await client.delete('/users/1');

    expect(result).toBeUndefined();
  });

  it('should use generic message when response body is not valid JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    try {
      await client.get('/broken');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MitraApiError);
      const apiError = error as MitraApiError;
      expect(apiError.status).toBe(500);
      expect(apiError.message).toBe('Request failed with status 500');
    }
  });

  it('should throw MitraApiError with correct fields on HTTP error', async () => {
    mockFetch({ message: 'Not found', error_code: 'ENTITY_NOT_FOUND' }, 404);
    const onError = vi.fn();
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      onError,
    });

    try {
      await client.get('/users/999');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MitraApiError);
      const apiError = error as MitraApiError;
      expect(apiError.status).toBe(404);
      expect(apiError.message).toBe('Not found');
      expect(apiError.code).toBe('ENTITY_NOT_FOUND');
      expect(apiError.name).toBe('MitraApiError');
      expect(onError).toHaveBeenCalledWith(apiError);
    }
  });
});
