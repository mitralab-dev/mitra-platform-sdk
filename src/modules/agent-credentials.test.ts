import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test-utils';
import { HttpClient } from '../utils/http-client';
import { createBrowserAgentCredentialsModule } from './agent-credentials';

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

function credentials() {
  return createBrowserAgentCredentialsModule(
    new HttpClient({ baseUrl: 'https://api.mitra.io/copilot' })
  );
}
