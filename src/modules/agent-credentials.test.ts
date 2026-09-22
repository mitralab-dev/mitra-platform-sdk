import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test-utils';
import { HttpClient } from '../utils/http-client';
import { createBrowserAgentCredentialsModule, type AgentCredentialOptions } from './agent-credentials';

describe('createBrowserAgentCredentialsModule', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('delegates supported provider and flow pairs to Core', async () => {
    const fetchMock = mockFetch(undefined, 204);
    const credentials = createBrowserAgentCredentialsModule(
      new HttpClient({ baseUrl: 'https://api.mitra.io/copilot' })
    );

    await credentials.saveApiKey('ANTHROPIC', 'secret');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.mitra.io/copilot/api/v1/credentials/ANTHROPIC/api-key'
    );
  });

  it.each<[string, unknown, number, (options?: AgentCredentialOptions) => Promise<unknown>]>([
    ['list', [], 200, (options) => credentials().list(options)],
    ['listModels', [], 200, (options) => credentials().listModels(undefined, options)],
    ['saveApiKey', undefined, 204, (options) => credentials().saveApiKey('ANTHROPIC', 'secret', options)],
    ['remove', undefined, 204, (options) => credentials().remove('OPENAI', options)],
    ['startOAuth', { authUrl: 'https://auth', state: 's' }, 200, (options) => credentials().startOAuth('ANTHROPIC', options)],
    ['exchangeOAuth', { connected: true, email: null }, 200, (options) => credentials().exchangeOAuth('ANTHROPIC', { code: 'c', state: 's' }, options)],
    ['startDeviceAuthorization', { deviceAuthId: 'd', userCode: 'u', verificationUri: 'https://v', intervalSeconds: 5 }, 200, (options) => credentials().startDeviceAuthorization('OPENAI', options)],
    ['pollDeviceAuthorization', { connected: false, email: null }, 200, (options) => credentials().pollDeviceAuthorization('OPENAI', 'd', options)],
    ['listCustomProviders', [], 200, (options) => credentials().listCustomProviders(options)],
    ['createCustomProvider', [], 200, (options) => credentials().createCustomProvider(customProviderInput, options)],
    ['deleteCustomProvider', undefined, 204, (options) => credentials().deleteCustomProvider('p1', options)],
  ])('%s carries the scope as a query parameter only when it is given', async (_name, response, status, call) => {
    const fetchMock = mockFetch(response, status);

    await call({ scope: 'ACCOUNT' });
    await call();

    expect(fetchMock.mock.calls[0][0]).toMatch(/\?scope=ACCOUNT$/);
    expect(fetchMock.mock.calls[1][0]).not.toContain('scope');
  });

  it.each<[string, string, string | undefined, () => Promise<unknown>]>([
    ['listCustomProviders', 'GET', undefined, () => credentials().listCustomProviders()],
    ['createCustomProvider', 'POST', JSON.stringify(customProviderInput), () => credentials().createCustomProvider(customProviderInput)],
    ['deleteCustomProvider', 'DELETE', undefined, () => credentials().deleteCustomProvider('p 1')],
  ])('%s reaches the person\'s custom providers with the same arguments', async (_name, method, body, call) => {
    const fetchMock = mockFetch(method === 'DELETE' ? undefined : [], method === 'DELETE' ? 204 : 200);

    await call();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.mitra.io/copilot/api/v1/credentials/custom-providers${method === 'DELETE' ? '/p%201' : ''}`
    );
    expect(init.method).toBe(method);
    expect(init.body).toBe(body);
  });

  it.each([
    ['saveApiKey', () => credentials().saveApiKey('GOOGLE' as 'ANTHROPIC', 'secret')],
    ['remove', () => credentials().remove('GOOGLE' as 'OPENAI')],
    ['OAuth', () => credentials().startOAuth('OPENAI' as 'ANTHROPIC')],
    ['device authorization', () => credentials().startDeviceAuthorization('ANTHROPIC' as 'OPENAI')],
  ])('rejects unsupported providers at runtime for %s', (_flow, call) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(call).toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const customProviderInput = {
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'gsk-secret',
  models: ['llama-3.3-70b'],
};

function credentials() {
  return createBrowserAgentCredentialsModule(
    new HttpClient({ baseUrl: 'https://api.mitra.io/copilot' })
  );
}
