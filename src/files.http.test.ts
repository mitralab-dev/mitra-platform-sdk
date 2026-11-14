import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  FileTransferError,
  MitraApiError,
  type FileMetadata,
  type FilesModule,
  type FileUploadOptions,
} from './index';
import { mockLocalStorage } from './test-utils';

// The gateway and the storage the signed links point at are one real HTTP server on an ephemeral
// port, reached through the global fetch, as in a browser app; no test replaces fetch, so the
// client sends what it would send in production. Each test gets its own server, so its own origin:
// undici pools connections by origin, and a socket a held request left behind is never offered to
// the next test.

interface ReceivedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

type Answer = (request: ReceivedRequest, response: ServerResponse) => void;

const appId = 'app-1';
const accessToken = 'user-access-token';
const fileId = '0b6f3c1e-8d2a-4c55-9a77-5f1e2d3c4b5a';
const filesPath = '/data-manager/api/v1/files';
const signature = '5e1f'.repeat(16);
// A link signed by the role of an ECS task carries this token, and decoding it changes it.
const securityToken = 'IQoJb3JpZ2luX2VjEA%2FexampleSession%2BToken%3D%3D';
const sessionHeaders = { authorization: `Bearer ${accessToken}`, 'x-app-id': appId };
const readyFile: FileMetadata = {
  id: fileId,
  name: 'notes.txt',
  contentType: 'text/plain',
  sizeBytes: 5,
  kind: 'TEMPORARY',
  visibility: 'PRIVATE',
  status: 'READY',
  ownerUserId: 'user-1',
  createdBy: 'USER',
  createdAt: '2026-11-14T12:00:00Z',
  confirmedAt: '2026-11-14T12:00:03Z',
  expiresAt: '2026-11-21T12:00:00Z',
};
const uploadOptions: FileUploadOptions = { kind: 'TEMPORARY', visibility: 'PRIVATE' };

let server: Server;
let origin: string;
const received: ReceivedRequest[] = [];
let api: Record<string, Answer>;
let storage: Answer;
let storageArrived: () => void = () => undefined;

function reply(response: ServerResponse, status: number, body = '', headers = {}): void {
  response.writeHead(status, headers);
  response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  reply(response, status, JSON.stringify(body), { 'content-type': 'application/json' });
}

// The query S3 signs, so the check on errors meets the values a real link carries.
function signedLink(leadingQuery = ''): string {
  return (
    `${origin}/bucket/files/tmp/tenant/t1/app/${appId}/${fileId}?${leadingQuery}` +
    'X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261114%2Fsa-east-1%2Fs3%2Faws4_request' +
    `&X-Amz-Date=20261114T120000Z&X-Amz-Expires=300&X-Amz-Security-Token=${securityToken}` +
    `&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match&X-Amz-Signature=${signature}`
  );
}

function uploadLink(): string {
  return signedLink();
}

// A read link pins the version recorded at confirmation.
function readLink(): string {
  return signedLink('versionId=v1&');
}

function linkPath(link: string): string {
  return link.slice(origin.length);
}

function requestLine({ method, path }: ReceivedRequest): string {
  return `${method} ${path}`;
}

function healthyDataManager(): Record<string, Answer> {
  return {
    [`POST ${filesPath}`]: (_request, response) =>
      json(response, 201, {
        fileId,
        uploadUrl: uploadLink(),
        uploadMethod: 'PUT',
        uploadHeaders: { 'content-type': 'text/plain', 'if-none-match': '*' },
        expiresAt: '2026-11-14T12:05:00Z',
      }),
    [`POST ${filesPath}/${fileId}/confirm`]: (_request, response) => json(response, 200, readyFile),
    [`POST ${filesPath}/${fileId}/read-url`]: (_request, response) =>
      json(response, 200, { url: readLink(), expiresAt: '2026-11-14T12:05:00Z' }),
    [`DELETE ${filesPath}/${fileId}`]: (_request, response) => reply(response, 204),
  };
}

function nextStorageRequest(): Promise<void> {
  return new Promise((resolve) => (storageArrived = resolve));
}

// The session an app has after its person signs in, restored by createClient from localStorage.
function signedInClient(onError?: (error: MitraApiError) => void): FilesModule {
  const localStorage = mockLocalStorage();
  localStorage._store[`mitra_auth_${appId}`] = JSON.stringify({
    user: { id: 'user-1', tenantId: 't1', email: 'user@test.com', name: null },
    token: accessToken,
    refreshToken: 'user-refresh-token',
  });
  return createClient({ appId, apiUrl: `${origin}/`, onError }).files;
}

// File is a global only from Node 20, and the CI also runs on Node 18. upload reads the name of
// any Blob that has one, as it does for the File an <input type="file"> gives.
function pickedFile(): Blob {
  return Object.assign(new Blob(['hello'], { type: 'text/plain' }), { name: 'notes.txt' });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (reason: unknown) => reason
  );
}

// Everything reachable from the error, hidden properties included, so no copy of the
// request, cause or stack keeps the signature or the AWS security token.
function expectNoSignedLink(error: unknown): void {
  const secrets = [signature, securityToken, decodeURIComponent(securityToken)];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      secrets.forEach((secret) => expect(value).not.toContain(secret));
      return;
    }
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    if (seen.has(value)) return;
    seen.add(value);
    Reflect.ownKeys(value).forEach((key) => visit((value as Record<PropertyKey, unknown>)[key]));
  };
  visit(error);
}

beforeEach(async () => {
  api = healthyDataManager();
  storage = (_request, response) => reply(response, 200);
  server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      };
      received.push(request);
      if (request.path.startsWith('/bucket/')) {
        storage(request, response);
        storageArrived();
        return;
      }
      const route = api[requestLine(request)];
      if (route) route(request, response);
      else json(response, 404, { message: 'Resource not found', error_code: 'NOT_FOUND' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  received.length = 0;
  storageArrived = () => undefined;
  vi.unstubAllGlobals();
});

describe('client.files.upload over HTTP', () => {
  it('requests, sends the bytes to the signed link without the session headers, and confirms', async () => {
    await expect(signedInClient().upload(pickedFile(), uploadOptions)).resolves.toEqual(readyFile);

    expect(received.map(requestLine)).toEqual([
      `POST ${filesPath}`,
      `PUT ${linkPath(uploadLink())}`,
      `POST ${filesPath}/${fileId}/confirm`,
    ]);
    const [requested, sent, confirmed] = received;
    expect(requested?.headers).toMatchObject(sessionHeaders);
    expect(JSON.parse(requested?.body.toString() ?? '')).toEqual({
      name: 'notes.txt',
      contentType: 'text/plain',
      sizeBytes: 5,
      kind: 'TEMPORARY',
      visibility: 'PRIVATE',
    });
    expect(sent?.body.toString()).toBe('hello');
    expect(sent?.headers).toMatchObject({
      'content-type': 'text/plain',
      'if-none-match': '*',
      'content-length': '5',
    });
    expect(sent?.headers).not.toHaveProperty('authorization');
    expect(sent?.headers).not.toHaveProperty('x-app-id');
    expect(confirmed?.headers).toMatchObject(sessionHeaders);
  });

  it('deletes the pending file when storage refuses the bytes, with no part of the link in the error', async () => {
    // S3 quotes the canonical request, query included, when it refuses a signature.
    storage = (request, response) =>
      reply(
        response,
        403,
        `<Error><Code>SignatureDoesNotMatch</Code><CanonicalRequest>PUT ${request.path}</CanonicalRequest></Error>`,
        { 'content-type': 'application/xml' }
      );
    const onError = vi.fn();

    const error = await rejectionOf(signedInClient(onError).upload(pickedFile(), uploadOptions));

    expect(error).toBeInstanceOf(FileTransferError);
    expect(error).toMatchObject({ step: 'send', fileId, status: 403, cleanedUp: true });
    const deleted = received.at(-1);
    expect(deleted && requestLine(deleted)).toBe(`DELETE ${filesPath}/${fileId}`);
    expect(deleted?.headers).toMatchObject(sessionHeaders);
    expect(onError).not.toHaveBeenCalled();
    expectNoSignedLink(error);
  });

  it('says in cleanedUp and in onError that the pending file could not be deleted', async () => {
    storage = (_request, response) => reply(response, 503);
    api[`DELETE ${filesPath}/${fileId}`] = (_request, response) =>
      json(response, 429, { message: 'Too many requests', error_code: 'RATE_LIMIT_EXCEEDED' });
    const onError = vi.fn();

    const error = await rejectionOf(signedInClient(onError).upload(pickedFile(), uploadOptions));

    expect(error).toBeInstanceOf(FileTransferError);
    expect(error).toMatchObject({ step: 'send', fileId, status: 503, cleanedUp: false });
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 429, code: 'RATE_LIMIT_EXCEEDED' })
    );
  });

  it('deletes the pending file and rejects with the reason of the signal when cancelled midway', async () => {
    storage = () => undefined;
    const controller = new AbortController();
    const arrival = nextStorageRequest();

    const uploading = signedInClient().upload(pickedFile(), {
      ...uploadOptions,
      signal: controller.signal,
    });
    await arrival;
    controller.abort();

    await expect(uploading).rejects.toBe(controller.signal.reason);
    expect(controller.signal.reason).toMatchObject({ name: 'AbortError' });
    expect(received.map(requestLine)).toEqual([
      `POST ${filesPath}`,
      `PUT ${linkPath(uploadLink())}`,
      `DELETE ${filesPath}/${fileId}`,
    ]);
  });

  it('rejects a Blob without a name with the Platform error factory, before any request', async () => {
    const unnamed = new Blob(['hello'], { type: 'text/plain' });

    const error = await rejectionOf(signedInClient().upload(unnamed, uploadOptions));

    expect(error).toBeInstanceOf(MitraApiError);
    expect(error).toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(received).toEqual([]);
  });

  it('rejects with MitraApiError and sends nothing to storage when the API refuses the upload', async () => {
    api[`POST ${filesPath}`] = (_request, response) =>
      json(response, 413, { message: 'File too large', error_code: 'FILE_TOO_LARGE' });
    const onError = vi.fn();

    const error = await rejectionOf(signedInClient(onError).upload(pickedFile(), uploadOptions));

    expect(error).toBeInstanceOf(MitraApiError);
    expect(error).toMatchObject({ status: 413, code: 'FILE_TOO_LARGE' });
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(received.map(requestLine)).toEqual([`POST ${filesPath}`]);
  });
});

describe('client.files reads over HTTP', () => {
  it('downloads from the read link without the session headers', async () => {
    storage = (_request, response) => reply(response, 200, 'hello', { 'content-type': 'text/plain' });

    const content = await signedInClient().download(fileId);

    expect(await content.text()).toBe('hello');
    expect(received.map(requestLine)).toEqual([
      `POST ${filesPath}/${fileId}/read-url`,
      `GET ${linkPath(readLink())}`,
    ]);
    expect(received[0]?.headers).toMatchObject(sessionHeaders);
    expect(received[1]?.headers).not.toHaveProperty('authorization');
    expect(received[1]?.headers).not.toHaveProperty('x-app-id');
  });
});
