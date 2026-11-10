import { MitraApiError } from '../utils/http-client';
import type { FileGrant, FileMetadata } from './files.types';

export const FILE_PART_SIZE = 5 * 1024 * 1024;
export const MAX_FILE_SIZE = 5 * FILE_PART_SIZE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FileOperationError extends MitraApiError {}

export function fileError(code = 'INVALID_RESPONSE'): FileOperationError {
  return new FileOperationError(
    code === 'FILE_GRANT_EXPIRED' ? 'File grant expired; authorize the operation again' : 'File operation failed',
    0, code
  );
}

export function fileId(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw fileError('INVALID_CONFIGURATION');
  return value;
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

export function checkExpiry(value: unknown, upperBound?: string): void {
  if (!isDate(value) || (upperBound && Date.parse(value) > Date.parse(upperBound))) throw fileError();
  if (Date.parse(value) <= Date.now()) throw fileError('FILE_GRANT_EXPIRED');
}

export function fileMetadata(value: FileMetadata, state: FileMetadata['state']): FileMetadata {
  if (!value || typeof value.fileId !== 'string' || !UUID.test(value.fileId) || value.state !== state ||
    typeof value.name !== 'string' || !value.name || typeof value.contentType !== 'string' ||
    !value.contentType || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_FILE_SIZE ||
    (value.pendingExpiresAt !== null && !isDate(value.pendingExpiresAt))) throw fileError();
  const checksum = value.checksum;
  if (state !== 'UPLOADING' || checksum !== null) {
    if (checksum?.algorithm !== 'SHA256' || checksum.type !== 'COMPOSITE' ||
      checksum.partSize !== FILE_PART_SIZE || checksum.partCount !== Math.ceil(value.size / FILE_PART_SIZE) ||
      !new RegExp(`^[A-Za-z0-9+/]{43}=-${checksum.partCount}$`).test(checksum.value)) throw fileError();
  }
  return {
    fileId: value.fileId, name: value.name, state: value.state, contentType: value.contentType,
    size: value.size, pendingExpiresAt: value.pendingExpiresAt,
    checksum: checksum === null ? null : {
      algorithm: checksum.algorithm, type: checksum.type, value: checksum.value,
      partSize: checksum.partSize, partCount: checksum.partCount,
    },
  };
}

export function fileGrant(value: FileGrant, expectedFileId: string, operation: FileGrant['operation']): FileGrant {
  if (!value || typeof value.grantId !== 'string' || !UUID.test(value.grantId) ||
    value.fileId !== expectedFileId || value.operation !== operation) throw fileError();
  checkExpiry(value.expiresAt);
  return { grantId: value.grantId, fileId: value.fileId, operation, expiresAt: value.expiresAt };
}

export interface FileDestination {
  method: 'PUT' | 'GET';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface FilePartDestination extends FileDestination {
  partNumber: number;
  contentLength: number;
}

export function destination(value: FileDestination, method: 'PUT' | 'GET', expiresAt: string): FileDestination {
  if (value?.method !== method || typeof value.url !== 'string') throw fileError();
  let url: URL;
  try { url = new URL(value.url); } catch { throw fileError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fileError();
  checkExpiry(value.expiresAt, expiresAt);
  if (!value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers)) throw fileError();
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value.headers)) {
    const lower = name.toLowerCase();
    if (typeof header !== 'string' || /[\r\n]/.test(header) ||
      !['content-type', 'content-length', 'x-amz-checksum-sha256'].includes(lower) ||
      Object.hasOwn(headers, lower)) throw fileError();
    headers[lower] = header;
  }
  return { method, url: url.href, headers, expiresAt: value.expiresAt };
}
