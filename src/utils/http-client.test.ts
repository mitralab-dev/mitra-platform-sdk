import { describe, it, expect, vi, afterEach } from 'vitest';
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
      redirect: 'manual',
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
      redirect: 'manual',
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
      redirect: 'manual',
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
      redirect: 'manual',
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
      redirect: 'manual',
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
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'manual' });
    expect(result).toEqual({ id: 1 });
  });

  it.each([307, 308])('should block status %i without following or replaying', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status,
      redirected: false,
      type: 'basic',
      json: vi.fn().mockResolvedValue({ message: 'Redirect blocked' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      getToken: () => 'current-token',
      onUnauthorized,
    });

    await expect(client.post('/orders', { id: 'order-1' })).rejects.toMatchObject({ status });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('should reject a response already followed by the fetch implementation', async () => {
    const json = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      redirected: true,
      type: 'basic',
      json,
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    await expect(client.get('/users')).rejects.toMatchObject({
      status: 200,
      code: 'REDIRECT_NOT_ALLOWED',
      message: 'Redirected responses are not allowed',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
  });

  it('should reject an opaque redirect response without reading or replaying it', async () => {
    const json = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 0,
      redirected: false,
      type: 'opaqueredirect',
      json,
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpClient({ baseUrl: 'https://api.mitra.io' });

    await expect(client.get('/users')).rejects.toMatchObject({
      status: 0,
      code: 'REDIRECT_NOT_ALLOWED',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    ['redirected', { redirected: true, type: 'basic' }],
    ['opaque redirect', { redirected: false, type: 'opaqueredirect' }],
  ])('should not refresh or replay a 401 %s response', async (_label, redirectState) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      ...redirectState,
      json: vi.fn().mockResolvedValue({ message: 'Unauthorized' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      onUnauthorized,
    });

    await expect(client.get('/users')).rejects.toMatchObject({
      status: 401,
      code: 'REDIRECT_NOT_ALLOWED',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('should stop when the single 401 retry receives an opaque redirect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        redirected: false,
        type: 'basic',
        json: vi.fn().mockResolvedValue({ message: 'Unauthorized' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 0,
        redirected: false,
        type: 'opaqueredirect',
        json: vi.fn(),
      });
    vi.stubGlobal('fetch', fetchMock);
    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      onUnauthorized,
    });

    await expect(client.get('/users')).rejects.toMatchObject({
      status: 0,
      code: 'REDIRECT_NOT_ALLOWED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'manual' });
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

  it('should recursively redact the current token and bearer credentials from errors', async () => {
    const currentToken = 'current-secret-token';
    const credentials = {
      message: 'foreign-message-secret',
      code: 'foreign-code-secret',
      key: 'foreign-key-secret',
      value: 'foreign-value-secret',
    };
    mockFetch(
      {
        message: `Rejected ${currentToken} and Bearer ${credentials.message}`,
        error_code: `UPSTREAM ${currentToken} Bearer ${credentials.code}`,
        details: {
          [`key ${currentToken} Bearer ${credentials.key}`]: [
            `value ${currentToken}`,
            { nested: `Bearer ${credentials.value}` },
          ],
        },
      },
      500
    );
    const onError = vi.fn();
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      getToken: () => currentToken,
      onError,
    });

    let error: unknown;
    try {
      await client.get('/sensitive');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MitraApiError);
    const apiError = error as MitraApiError;
    expect(apiError.message).toBe('Rejected [REDACTED] and Bearer [REDACTED]');
    expect(apiError.code).toBe('UPSTREAM [REDACTED] Bearer [REDACTED]');
    expect(apiError.details).toEqual({
      message: 'Rejected [REDACTED] and Bearer [REDACTED]',
      error_code: 'UPSTREAM [REDACTED] Bearer [REDACTED]',
      details: {
        'key [REDACTED] Bearer [REDACTED]': [
          'value [REDACTED]',
          { nested: 'Bearer [REDACTED]' },
        ],
      },
    });
    expect(onError).toHaveBeenCalledWith(apiError);

    const serialized = JSON.stringify(apiError);
    for (const credential of [currentToken, ...Object.values(credentials)]) {
      expect(apiError.message).not.toContain(credential);
      expect(apiError.code).not.toContain(credential);
      expect(serialized).not.toContain(credential);
    }
  });

  it('should redact foreign credentials when the current access token is the literal Bearer', async () => {
    const currentToken = 'Bearer';
    const credentials = {
      message: 'foreign-message-secret',
      code: 'foreign-code-secret',
      key: 'foreign-key-secret',
      value: 'foreign-value-secret',
    };
    mockFetch(
      {
        message: `Bearer ${credentials.message}`,
        error_code: `Bearer ${credentials.code}`,
        details: {
          [`Bearer ${credentials.key}`]: `Bearer ${credentials.value}`,
        },
      },
      500
    );
    const client = new HttpClient({
      baseUrl: 'https://api.mitra.io',
      getToken: () => currentToken,
    });

    let error: unknown;
    try {
      await client.get('/sensitive');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MitraApiError);
    const apiError = error as MitraApiError;
    const serialized = JSON.stringify(apiError);
    expect(apiError.message).toBe('[REDACTED] [REDACTED]');
    expect(apiError.code).toBe('[REDACTED] [REDACTED]');
    expect(apiError.details).toEqual({
      message: '[REDACTED] [REDACTED]',
      error_code: '[REDACTED] [REDACTED]',
      details: {
        '[REDACTED] [REDACTED]': '[REDACTED] [REDACTED]',
      },
    });
    for (const credential of Object.values(credentials)) {
      expect(serialized).not.toContain(credential);
    }
  });
});
