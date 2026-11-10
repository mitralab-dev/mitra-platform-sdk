import { HttpClient, MitraApiError } from '../utils/http-client';
import {
  FILE_PART_SIZE, MAX_FILE_SIZE, destination, fileError, fileGrant, fileId, fileMetadata,
  type FileDestination, type FilePartDestination,
} from './files-contract';
import { compositeChecksum, downloadBlob, fileChecksums, uploadPart } from './file-transfer';
import type { FileDownload, FileDownloadOptions, FileMetadata, FileUploadOptions } from './files.types';

interface RedeemedUpload {
  operation: 'UPLOAD';
  file: FileMetadata;
  uploadId: string;
  destinations: FilePartDestination[];
}

interface RedeemedRead {
  operation: 'READ';
  file: FileMetadata;
  download: FileDestination;
}

export class FilesModule {
  constructor(private readonly httpClient: HttpClient) {}

  async upload(file: File, options: FileUploadOptions): Promise<FileMetadata> {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_SIZE ||
      typeof file.name !== 'string' || !file.name.trim()) throw fileError('INVALID_CONFIGURATION');
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.throwIfAborted();
    options.signal?.addEventListener('abort', abort, { once: true });
    let grantId: string | undefined;
    let completionMayHaveSucceeded = false;
    try {
      const checksums = await fileChecksums(file, controller.signal);
      const checksum = await compositeChecksum(checksums);
      const input = { name: file.name, contentType: file.type || 'application/octet-stream', size: file.size, partChecksums: [...checksums] };
      const authorized = await options.authorize(input);
      if (authorized?.file?.state === 'READY') throw fileError('FILE_ALREADY_COMMITTED');
      const initial = fileMetadata(authorized?.file, authorized?.file?.state === 'STAGED' ? 'STAGED' : 'UPLOADING');
      completionMayHaveSucceeded = initial.state === 'STAGED';
      const grant = fileGrant(authorized.grant, initial.fileId, 'UPLOAD');
      grantId = grant.grantId;
      if (initial.size !== file.size ||
        typeof authorized.uploadId !== 'string' || !authorized.uploadId) throw fileError();
      controller.signal.throwIfAborted();
      if (initial.state === 'STAGED') {
        return this.stagedFile(initial, initial, checksum);
      }
      const redeemed = await this.request<RedeemedUpload>(grantId, 'redeem', controller.signal);
      if (redeemed?.operation !== 'UPLOAD' || redeemed.uploadId !== authorized.uploadId) throw fileError();
      if (redeemed.file?.state === 'STAGED') {
        completionMayHaveSucceeded = true;
        if (!Array.isArray(redeemed.destinations) || redeemed.destinations.length !== 0) throw fileError();
        return this.stagedFile(redeemed.file, initial, checksum);
      }
      const targets = this.uploadDestinations(redeemed, initial, grant.expiresAt, checksums);
      await this.uploadParts(file, targets, controller, options.onProgress);
      controller.signal.throwIfAborted();
      // A failed response cannot prove that completion did not take effect.
      completionMayHaveSucceeded = true;
      const completed = this.stagedFile(await this.request<FileMetadata>(grantId, 'complete', controller.signal), initial, checksum);
      controller.signal.throwIfAborted();
      return completed;
    } catch (error) {
      controller.abort();
      if (options.signal?.aborted && grantId && !completionMayHaveSucceeded &&
        !(error instanceof MitraApiError && error.status === 409)) {
        await this.cancel(grantId).catch(() => undefined);
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async download(id: string, options: FileDownloadOptions): Promise<FileDownload> {
    fileId(id);
    options.signal?.throwIfAborted();
    const grant = fileGrant(await options.authorize(id), id, 'READ');
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const redeemed = await this.request<RedeemedRead>(grant.grantId, 'redeem', signal);
    if (redeemed?.operation !== 'READ') throw fileError();
    const file = fileMetadata(redeemed.file, 'READY');
    if (file.fileId !== id) throw fileError();
    const target = destination(redeemed.download, 'GET', grant.expiresAt);
    if (Object.keys(target.headers).length !== 0) throw fileError();
    const blob = await downloadBlob(target, file.size, signal);
    const checksum = await compositeChecksum(await fileChecksums(blob, signal));
    if (checksum !== file.checksum?.value) throw fileError('FILE_INTEGRITY_FAILED');
    signal.throwIfAborted();
    return { file, blob };
  }

  cancel(grantId: string): Promise<void> {
    // Cleanup uses its own bounded signal: the caller's signal is already aborted.
    return this.httpClient.request(`/api/v1/file-grants/${fileId(grantId)}/upload`, {
      method: 'DELETE', signal: AbortSignal.timeout(5000), redactErrors: true,
    });
  }

  private request<T>(grantId: string, action: 'redeem' | 'complete', signal: AbortSignal): Promise<T> {
    return this.httpClient.request(`/api/v1/file-grants/${grantId}/${action}`, {
      method: 'POST', signal, redactErrors: true,
    });
  }

  private uploadDestinations(
    response: RedeemedUpload, initial: FileMetadata, expiresAt: string, checksums: string[]
  ): FileDestination[] {
    if (!Array.isArray(response.destinations) || response.destinations.length !== checksums.length) throw fileError();
    const file = fileMetadata(response.file, 'UPLOADING');
    if (file.fileId !== initial.fileId || file.size !== initial.size) throw fileError();
    const ordered = [...response.destinations].sort((a, b) => a?.partNumber - b?.partNumber);
    return ordered.map((part, index) => {
      const target = destination(part, 'PUT', expiresAt);
      const size = Math.min(FILE_PART_SIZE, file.size - index * FILE_PART_SIZE);
      if (part.partNumber !== index + 1 || part.contentLength !== size ||
        target.headers['x-amz-checksum-sha256'] !== checksums[index] ||
        (target.headers['content-length'] !== undefined && target.headers['content-length'] !== String(size)) ||
        (target.headers['content-type'] !== undefined && target.headers['content-type'] !== initial.contentType)) throw fileError();
      return target;
    });
  }

  private stagedFile(value: FileMetadata, initial: FileMetadata, checksum: string): FileMetadata {
    const file = fileMetadata(value, 'STAGED');
    if (file.fileId !== initial.fileId || file.size !== initial.size || file.checksum?.value !== checksum) {
      throw fileError('FILE_INTEGRITY_FAILED');
    }
    return file;
  }

  private async uploadParts(
    file: File, targets: FileDestination[], controller: AbortController,
    onProgress?: FileUploadOptions['onProgress']
  ): Promise<void> {
    let next = 0;
    let loaded = 0;
    let failure: unknown;
    const worker = async () => {
      try {
        while (next < targets.length) {
          controller.signal.throwIfAborted();
          const index = next++;
          const part = file.slice(index * FILE_PART_SIZE, (index + 1) * FILE_PART_SIZE);
          await uploadPart(targets[index], part, controller.signal);
          loaded += part.size;
          onProgress?.({ loaded, total: file.size });
        }
      } catch (error) {
        failure ??= error;
        controller.abort();
        throw error;
      }
    };
    await Promise.allSettled([worker(), worker()]);
    if (failure) throw failure;
  }
}
