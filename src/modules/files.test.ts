import { createHash, webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createClient } from '../index';
import type { FileDownload, FileGrant, FileMetadata, FileUpload, FileUploadInput, FilesModule as PublicFilesModule } from '../index';
import { HttpClient, type HttpClientConfig } from '../utils/http-client';
import { FilesModule } from './files';

const PART = 5 * 1024 * 1024;
const ID = '00000000-0000-4000-8000-000000000001';
const GRANT = '00000000-0000-4000-8000-000000000002';
const UPLOAD = '00000000-0000-4000-8000-000000000003';
const API = 'https://api.example.com/data-manager';
const EXPIRY = '2030-01-01T00:00:00Z';
const URL = 'https://storage.example.com/object?versionId=immutable&signature=secret';

function makeFile(size = 3): File {
  return new NodeFile([new Uint8Array(size).fill(42)], 'report.txt', { type: 'text/plain' }) as unknown as File;
}

async function fixture(size = 3, auth: Partial<HttpClientConfig> = {}) {
  vi.stubGlobal('crypto', webcrypto);
  const file = makeFile(size);
  const bytes = Buffer.from(await file.arrayBuffer());
  const hashes = [];
  for (let offset = 0; offset < size; offset += PART) {
    hashes.push(createHash('sha256').update(bytes.subarray(offset, offset + PART)).digest());
  }
  const manifest = hashes.map((hash) => hash.toString('base64'));
  const checksum = {
    algorithm: 'SHA256' as const, type: 'COMPOSITE' as const,
    value: createHash('sha256').update(Buffer.concat(hashes)).digest('base64') + `-${hashes.length}`,
    partSize: PART, partCount: hashes.length,
  };
  const initial: FileMetadata = {
    fileId: ID, name: file.name, contentType: file.type, state: 'UPLOADING', size,
    checksum: null, pendingExpiresAt: EXPIRY,
  };
  const staged: FileMetadata = { ...initial, state: 'STAGED', checksum };
  const ready: FileMetadata = { ...staged, state: 'READY', pendingExpiresAt: null };
  const grant: FileGrant = { grantId: GRANT, fileId: ID, operation: 'UPLOAD', expiresAt: EXPIRY };
  const authorization: FileUpload = { file: initial, grant, uploadId: UPLOAD };
  const destinations = manifest.map((hash, index) => ({
    partNumber: index + 1, method: 'PUT', url: `${URL}&partNumber=${index + 1}`,
    headers: { 'x-amz-checksum-sha256': hash, 'content-length': String(Math.min(PART, size - index * PART)) },
    contentLength: Math.min(PART, size - index * PART), expiresAt: EXPIRY,
  }));
  const redeemed = { file: initial, uploadId: UPLOAD, operation: 'UPLOAD', destinations };
  const read = { file: ready, operation: 'READ', download: { method: 'GET', url: URL, headers: {}, expiresAt: EXPIRY } };
  const authorize = vi.fn(async (_metadata: FileUploadInput) => authorization);
  const readAuthorize = vi.fn(async (_id: string): Promise<FileGrant> => ({ ...grant, operation: 'READ' }));
  const onError = vi.fn();
  const http = new HttpClient({ baseUrl: API, getToken: () => 'session-secret', defaultHeaders: { 'X-App-Id': 'app' }, onError, ...auth });
  const files = new FilesModule(http);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).startsWith('https://storage.')) return new Response(init?.method === 'GET' ? bytes : null);
    if (String(url).endsWith('/redeem')) return Response.json(redeemed);
    if (String(url).endsWith('/complete')) return Response.json(staged);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetch);
  return { file, bytes, manifest, initial, staged, ready, grant, authorization, redeemed, read, authorize, readAuthorize, files, fetch, onError };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('files upload', () => {
  it.each([3, PART + 1, 25 * 1024 * 1024])('uploads %i bytes with fixed checksums, bounded concurrency and isolated credentials', async (size) => {
    const f = await fixture(size);
    let active = 0;
    let maximum = 0;
    const transferred: number[] = [];
    const defaultFetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (!String(url).startsWith('https://storage.')) return defaultFetch(url, init);
      active++;
      maximum = Math.max(maximum, active);
      const bytes = await (init?.body as Blob).arrayBuffer();
      transferred.push(bytes.byteLength);
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
      const headers = new Headers(init?.headers);
      expect(headers.has('Authorization')).toBe(false);
      expect(headers.has('X-App-Id')).toBe(false);
      expect(headers.has('Content-Length')).toBe(false);
      expect(headers.get('x-amz-checksum-sha256')).toBe(createHash('sha256').update(new Uint8Array(bytes)).digest('base64'));
      active--;
      return new Response(null);
    });
    const progress = vi.fn();
    const result = await f.files.upload(f.file, { authorize: f.authorize, onProgress: progress });
    expect(result).toEqual(f.staged);
    expect(f.authorize).toHaveBeenCalledExactlyOnceWith({ name: f.file.name, contentType: f.file.type, size, partChecksums: f.manifest });
    expect(maximum).toBeLessThanOrEqual(2);
    expect(transferred.reduce((total, part) => total + part, 0)).toBe(size);
    expect(transferred).toHaveLength(Math.ceil(size / PART));
    expect(progress).toHaveBeenLastCalledWith({ loaded: size, total: size });
    const apiCalls = f.fetch.mock.calls.filter(([url]) => String(url).startsWith(API));
    expect(apiCalls).toHaveLength(2);
    for (const [, init] of apiCalls) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-secret');
      expect(init?.body).toBeUndefined();
    }
    expectTypeOf(result).toEqualTypeOf<FileMetadata>();
  });

  it.each([0, 25 * 1024 * 1024 + 1])('rejects %i bytes before authorization', async (size) => {
    const f = await fixture();
    await expect(f.files.upload(makeFile(size), { authorize: f.authorize })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    'authorization header', 'cookies header', 'wrong checksum', 'wrong length', 'missing part',
    'wrong part', 'wrong upload', 'wrong file', 'http url', 'credentials url', 'redirect url',
  ])('rejects %s before sending bytes without discarding another invocation', async (kind) => {
    const f = await fixture();
    const part = f.redeemed.destinations[0];
    if (kind === 'authorization header') Object.assign(part.headers, { Authorization: 'session-secret' });
    if (kind === 'cookies header') Object.assign(part.headers, { Cookie: 'session-secret' });
    if (kind === 'wrong checksum') part.headers['x-amz-checksum-sha256'] = 'a'.repeat(43) + '=';
    if (kind === 'wrong length') part.contentLength++;
    if (kind === 'missing part') f.redeemed.destinations = [];
    if (kind === 'wrong part') part.partNumber = 2;
    if (kind === 'wrong upload') f.redeemed.uploadId = 'other';
    if (kind === 'wrong file') f.redeemed.file = { ...f.initial, fileId: UPLOAD };
    if (kind === 'http url') part.url = 'http://storage.example.com/file';
    if (kind === 'credentials url') part.url = 'https://user:password@storage.example.com/file';
    if (kind === 'redirect url') part.url = 'https://storage.example.com/file#fragment';
    await expect(f.files.upload(f.file, { authorize: f.authorize })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(f.fetch.mock.calls.every(([url]) => String(url).startsWith(API))).toBe(true);
    expect(f.fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('retries a failed part with identical bytes and manifest, counting progress once', async () => {
    const f = await fixture();
    const defaultFetch = f.fetch.getMockImplementation()!;
    let attempts = 0;
    f.fetch.mockImplementation(async (url, init) => {
      if (String(url).startsWith('https://storage.') && ++attempts === 1) return new Response(null, { status: 503 });
      return defaultFetch(url, init);
    });
    const progress = vi.fn();
    await f.files.upload(f.file, { authorize: f.authorize, onProgress: progress });
    const parts = f.fetch.mock.calls.filter(([url]) => String(url).startsWith('https://storage.'));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual(parts[1]);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });

  it('limits retries and never exposes a storage URL from a network error', async () => {
    const f = await fixture();
    const defaultFetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (String(url).startsWith('https://storage.')) throw new TypeError(`Failed to fetch ${url}`);
      return defaultFetch(url, init);
    });
    const error = await f.files.upload(f.file, { authorize: f.authorize }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'FILE_TRANSFER_FAILED' });
    expect(String(error)).not.toContain('signature');
    expect(f.fetch.mock.calls.filter(([url]) => String(url).startsWith('https://storage.'))).toHaveLength(3);
    expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith('/complete'))).toBe(false);
  });

  it.each(['grant', 'destination', 'storage'])('reports expired %s without renewing silently', async (where) => {
    const f = await fixture();
    if (where === 'grant') f.grant.expiresAt = '2000-01-01T00:00:00Z';
    if (where === 'destination') f.redeemed.destinations[0].expiresAt = '2000-01-01T00:00:00Z';
    if (where === 'storage') {
      const defaultFetch = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (url, init) => String(url).startsWith('https://storage.') ? new Response(null, { status: 403 }) : defaultFetch(url, init));
    }
    await expect(f.files.upload(f.file, { authorize: f.authorize })).rejects.toMatchObject({ code: 'FILE_GRANT_EXPIRED' });
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight parts and best-effort cancels with a fresh signal', async () => {
    const f = await fixture(PART + 1);
    const controller = new AbortController();
    const defaultFetch = f.fetch.getMockImplementation()!;
    let started = 0;
    let aborted = 0;
    f.fetch.mockImplementation(async (url, init) => {
      if (!String(url).startsWith('https://storage.')) return defaultFetch(url, init);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted++; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
        if (++started === 2) controller.abort();
      });
    });
    await expect(f.files.upload(f.file, { authorize: f.authorize, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(2);
    const cancel = f.fetch.mock.calls.at(-1);
    expect(cancel?.[0]).toBe(`${API}/api/v1/file-grants/${GRANT}/upload`);
    expect(cancel?.[1]?.signal?.aborted).toBe(false);
    expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith('/complete'))).toBe(false);
  });

  it('handles cancellation while the authorizer is pending', async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.authorize.mockImplementation(async () => { controller.abort(); return f.authorization; });
    await expect(f.files.upload(f.file, { authorize: f.authorize, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('refuses mismatched completion integrity', async () => {
    const f = await fixture();
    f.staged.checksum!.value = 'a'.repeat(43) + '=-1';
    await expect(f.files.upload(f.file, { authorize: f.authorize })).rejects.toMatchObject({ code: 'FILE_INTEGRITY_FAILED' });
  });

  it('returns an idempotent STAGED replay after verifying the original manifest without transferring again', async () => {
    const f = await fixture();
    f.authorize.mockResolvedValue({ ...f.authorization, file: f.staged });
    await expect(f.files.upload(f.file, { authorize: f.authorize })).resolves.toEqual(f.staged);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('rejects an idempotent STAGED replay with different content', async () => {
    const f = await fixture();
    f.staged.checksum!.value = 'a'.repeat(43) + '=-1';
    f.authorize.mockResolvedValue({ ...f.authorization, file: f.staged });
    await expect(f.files.upload(f.file, { authorize: f.authorize })).rejects.toMatchObject({ code: 'FILE_INTEGRITY_FAILED' });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('does not treat an already retained file as a pending upload', async () => {
    const f = await fixture();
    f.authorize.mockResolvedValue({ ...f.authorization, file: f.ready });
    await expect(f.files.upload(f.file, { authorize: f.authorize })).rejects.toMatchObject({ code: 'FILE_ALREADY_COMMITTED' });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(['redeem', 'complete'])('preserves a concurrent upload on %s conflict', async (action) => {
    const f = await fixture();
    const defaultFetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => String(url).endsWith(`/${action}`)
      ? Response.json({ error_code: 'FILE_OPERATION_IN_PROGRESS' }, { status: 409 })
      : defaultFetch(url, init));
    await expect(f.files.upload(f.file, { authorize: f.authorize })).rejects.toMatchObject({ status: 409, code: 'FILE_OPERATION_IN_PROGRESS' });
    expect(f.fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('recovers a lost completion response through STAGED redemption without deleting or retransferring', async () => {
    const f = await fixture();
    const defaultFetch = f.fetch.getMockImplementation()!;
    let completed = false;
    f.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/complete')) {
        completed = true;
        throw new TypeError(`Response lost ${URL}`);
      }
      if (completed && String(url).endsWith('/redeem')) {
        return Response.json({ ...f.redeemed, file: f.staged, destinations: [] });
      }
      return defaultFetch(url, init);
    });
    await expect(f.files.upload(f.file, { authorize: f.authorize })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(f.files.upload(f.file, { authorize: f.authorize })).resolves.toEqual(f.staged);
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/complete'))).toHaveLength(1);
    expect(f.fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it.each(['valid', 'identity', 'size', 'checksum'])('validates %s STAGED redemption with empty destinations', async (kind) => {
    const f = await fixture();
    const staged = { ...f.staged, checksum: { ...f.staged.checksum! } };
    if (kind === 'identity') staged.fileId = UPLOAD;
    if (kind === 'size') staged.size++;
    if (kind === 'checksum') staged.checksum.value = 'a'.repeat(43) + '=-1';
    f.fetch.mockResolvedValueOnce(Response.json({ ...f.redeemed, file: staged, destinations: [] }));
    const upload = f.files.upload(f.file, { authorize: f.authorize });
    if (kind === 'valid') await expect(upload).resolves.toEqual(f.staged);
    else await expect(upload).rejects.toMatchObject({ code: 'FILE_INTEGRITY_FAILED' });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not delete when the caller aborts after completion was dispatched', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const defaultFetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/complete')) {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      }
      return defaultFetch(url, init);
    });
    await expect(f.files.upload(f.file, { authorize: f.authorize, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it.each(['before', 'unauthorized'])('bounds cleanup while %s authentication remains pending', async (phase) => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => controller.signal);
    let release!: () => void;
    const refresh = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const hook = () => { entered(); return refresh; };
    const f = await fixture(3, phase === 'before'
      ? { beforeAuthenticatedRequest: hook }
      : { onUnauthorized: () => hook().then(() => true) });
    if (phase === 'unauthorized') f.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const cancellation = f.files.cancel(GRANT);
    const rejected = expect(cancellation).rejects.toMatchObject({ name: 'AbortError' });
    await entry;
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5000);
    controller.abort();
    await rejected;
    // A second caller can still await the shared refresh, which was not aborted.
    release();
    await expect(refresh).resolves.toBeUndefined();
    await Promise.resolve();
    expect(f.fetch).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
  });
});

describe('files download', () => {
  async function downloadFixture(size = 3) {
    const f = await fixture(size);
    const defaultFetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => String(url).endsWith('/redeem') ? Response.json(f.read) : defaultFetch(url, init));
    return f;
  }

  it.each([3, PART + 1])('verifies %i bytes against SHA256 COMPOSITE and returns an opaque Blob', async (size) => {
    const f = await downloadFixture(size);
    const result = await f.files.download(ID, { authorize: f.readAuthorize });
    expect(result.file).toEqual(f.ready);
    expect(result.blob.type).toBe('application/octet-stream');
    expect(Buffer.from(await result.blob.arrayBuffer()).equals(f.bytes)).toBe(true);
    expect(f.readAuthorize).toHaveBeenCalledExactlyOnceWith(ID);
    expect(f.fetch.mock.calls[1]).toMatchObject([URL, { credentials: 'omit', redirect: 'error', headers: {} }]);
    expectTypeOf(result).toEqualTypeOf<FileDownload>();
  });

  it.each(['oversized', 'truncated', 'corrupted', 'checksum type', 'other file', 'other grant', 'not ready'])('rejects %s content or metadata', async (kind) => {
    const f = await downloadFixture();
    if (kind === 'checksum type') Object.assign(f.ready.checksum!, { type: 'FULL_OBJECT' });
    if (kind === 'other file') f.read.file = { ...f.ready, fileId: UPLOAD };
    if (kind === 'other grant') f.readAuthorize.mockResolvedValue({ ...f.grant, fileId: UPLOAD, operation: 'READ' });
    if (kind === 'not ready') f.read.file = f.staged;
    if (['oversized', 'truncated', 'corrupted'].includes(kind)) {
      const defaultFetch = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (url, init) => String(url).startsWith('https://storage.')
        ? new Response(new Uint8Array(kind === 'oversized' ? 4 : kind === 'truncated' ? 2 : 3)) : defaultFetch(url, init));
    }
    await expect(f.files.download(ID, { authorize: f.readAuthorize })).rejects.toMatchObject({ code: ['oversized', 'truncated', 'corrupted'].includes(kind) ? 'FILE_INTEGRITY_FAILED' : 'INVALID_RESPONSE' });
  });

  it('cancels an oversized stream before reading the rest', async () => {
    const f = await downloadFixture();
    const cancel = vi.fn();
    f.fetch.mockResolvedValueOnce(Response.json(f.read)).mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4)); }, cancel,
    })));
    await expect(f.files.download(ID, { authorize: f.readAuthorize })).rejects.toMatchObject({ code: 'FILE_INTEGRITY_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a truncated stream even when its checksum matches the received bytes', async () => {
    const f = await downloadFixture();
    const truncated = f.bytes.subarray(0, 2);
    const partHash = createHash('sha256').update(truncated).digest();
    f.ready.checksum!.value = createHash('sha256').update(partHash).digest('base64') + '-1';
    f.fetch.mockResolvedValueOnce(Response.json(f.read)).mockResolvedValueOnce(new Response(truncated));
    await expect(f.files.download(ID, { authorize: f.readAuthorize })).rejects.toMatchObject({ code: 'FILE_INTEGRITY_FAILED' });
  });

  it('fails clearly on expired storage access and lets the caller authorize again', async () => {
    const f = await downloadFixture();
    f.fetch.mockResolvedValueOnce(Response.json(f.read)).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(f.files.download(ID, { authorize: f.readAuthorize })).rejects.toMatchObject({ code: 'FILE_GRANT_EXPIRED' });
    expect(f.readAuthorize).toHaveBeenCalledTimes(1);
    await expect(f.files.download(ID, { authorize: f.readAuthorize })).resolves.toHaveProperty('blob');
    expect(f.readAuthorize).toHaveBeenCalledTimes(2);
  });

  it('redacts grant and URL values from API errors and onError', async () => {
    const f = await downloadFixture();
    f.fetch.mockResolvedValueOnce(Response.json({ error_code: 'FILE_GRANT_EXPIRED', message: URL, details: { grant: GRANT, url: URL } }, { status: 410 }));
    const error = await f.files.download(ID, { authorize: f.readAuthorize }).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 410, code: 'FILE_GRANT_EXPIRED' });
    expect(JSON.stringify(error)).not.toMatch(/signature|00000000/);
    expect(f.onError).toHaveBeenCalledWith(error);
  });

  it('redacts network errors and honors cancellation before any API call', async () => {
    const f = await downloadFixture();
    f.fetch.mockRejectedValueOnce(new Error(`Network ${GRANT} ${URL}`));
    await expect(f.files.download(ID, { authorize: f.readAuthorize })).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'File API request failed' });
    const controller = new AbortController();
    controller.abort();
    await expect(f.files.download(ID, { authorize: f.readAuthorize, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.readAuthorize).toHaveBeenCalledTimes(1);
  });

  it('sanitizes errors while consuming the API response body', async () => {
    const f = await downloadFixture();
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(new Error(`Response stream failed ${URL}`)); },
    })));
    const error = await f.files.download(ID, { authorize: f.readAuthorize }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', message: 'File API request failed' });
    expect(String(error)).not.toContain('signature');
    expect(JSON.stringify(error)).not.toContain('signature');
  });

  it.each(['ECONNRESET', 'FILE_INTEGRITY_FAILED'])('sanitizes external stream errors even with code %s', async (code) => {
    const f = await downloadFixture();
    const external = Object.assign(new Error(`Download stream failed ${URL}`), { code });
    f.fetch.mockResolvedValueOnce(Response.json(f.read)).mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(external); },
    })));
    const error = await f.files.download(ID, { authorize: f.readAuthorize }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'FILE_TRANSFER_FAILED', message: 'File operation failed' });
    expect(error).not.toBe(external);
    expect(String(error)).not.toContain('signature');
    expect(JSON.stringify(error)).not.toContain('signature');
  });
});

it('exposes only recipient operations on the public browser client', () => {
  const client = createClient({ apiUrl: 'https://api.example.com', appId: 'app' });
  expectTypeOf(client.files).toEqualTypeOf<PublicFilesModule>();
  expect(client.files).not.toHaveProperty('createUpload');
  expect(client.files).not.toHaveProperty('commit');
  expect(client.files).not.toHaveProperty('createReadGrant');
});
