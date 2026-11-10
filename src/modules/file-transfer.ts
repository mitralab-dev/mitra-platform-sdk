import { FILE_PART_SIZE, FileOperationError, checkExpiry, fileError, type FileDestination } from './files-contract';

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes));
}

export async function fileChecksums(blob: Blob, signal?: AbortSignal): Promise<string[]> {
  const checksums: string[] = [];
  for (let start = 0; start < blob.size; start += FILE_PART_SIZE) {
    signal?.throwIfAborted();
    const bytes = await blob.slice(start, start + FILE_PART_SIZE).arrayBuffer();
    checksums.push(base64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))));
  }
  signal?.throwIfAborted();
  return checksums;
}

export async function compositeChecksum(checksums: string[]): Promise<string> {
  const bytes = new Uint8Array(checksums.length * 32);
  checksums.forEach((checksum, index) => {
    bytes.set(Uint8Array.from(atob(checksum), (character) => character.codePointAt(0)!), index * 32);
  });
  return `${base64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))}-${checksums.length}`;
}

async function transfer(target: FileDestination, signal: AbortSignal, body?: Blob): Promise<Response> {
  signal.throwIfAborted();
  checkExpiry(target.expiresAt);
  // Content-Length is signed but browsers compute it from the exact Blob themselves.
  const headers = Object.fromEntries(Object.entries(target.headers).filter(([name]) => name !== 'content-length'));
  let response: Response;
  try {
    response = await globalThis.fetch(target.url, {
      method: target.method, headers, body, signal, credentials: 'omit',
      redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
    });
  } catch {
    signal.throwIfAborted();
    throw fileError('FILE_TRANSFER_FAILED');
  }
  if (!response.ok || response.redirected || response.type === 'opaqueredirect') {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) throw fileError('FILE_GRANT_EXPIRED');
    throw fileError(response.status === 429 || response.status >= 500 ? 'FILE_TRANSFER_FAILED' : 'FILE_TRANSFER_REJECTED');
  }
  return response;
}

export async function uploadPart(target: FileDestination, blob: Blob, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await transfer(target, signal, blob);
      await response.body?.cancel().catch(() => undefined);
      return;
    } catch (error) {
      if (signal.aborted || attempt >= 2 || !(error instanceof FileOperationError) ||
        error.code !== 'FILE_TRANSFER_FAILED') throw error;
      await retryDelay(250 * 2 ** attempt, signal);
    }
  }
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(new DOMException('File operation aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function downloadBlob(target: FileDestination, size: number, signal: AbortSignal): Promise<Blob> {
  const response = await transfer(target, signal);
  const reader = response.body?.getReader();
  if (!reader) throw fileError();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > size) throw fileError('FILE_INTEGRITY_FAILED');
      chunks.push(new Uint8Array(value));
    }
    if (received !== size) throw fileError('FILE_INTEGRITY_FAILED');
    // Opaque by default: callers explicitly opt into a safe preview type.
    return new Blob(chunks, { type: 'application/octet-stream' });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof FileOperationError) throw error;
    throw fileError('FILE_TRANSFER_FAILED');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
