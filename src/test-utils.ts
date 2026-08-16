import { vi } from 'vitest';

export function mockFetch(response: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(response),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function mockFetchSequence(responses: Array<{ body: unknown; status?: number }>) {
  const fn = vi.fn();
  responses.forEach(({ body, status = 200 }) => {
    fn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: vi.fn().mockResolvedValue(body),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function memoryStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    _store: store,
  };
}

export function mockLocalStorage() {
  const storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  return storage;
}

export function mockSessionStorage() {
  const storage = memoryStorage();
  vi.stubGlobal('sessionStorage', storage);
  return storage;
}
