export interface FileChecksum {
  algorithm: 'SHA256';
  type: 'COMPOSITE';
  value: string;
  partSize: number;
  partCount: number;
}

export interface FileMetadata {
  fileId: string;
  state: 'UPLOADING' | 'STAGED' | 'READY' | 'DELETING' | 'DELETED';
  name: string;
  contentType: string;
  size: number;
  checksum: FileChecksum | null;
  pendingExpiresAt: string | null;
}

export interface FileGrant {
  grantId: string;
  fileId: string;
  operation: 'UPLOAD' | 'READ';
  expiresAt: string;
}

export interface FileUploadInput {
  name: string;
  contentType: string;
  size: number;
  partChecksums: string[];
}

export interface FileUpload {
  file: FileMetadata;
  uploadId: string;
  grant: FileGrant;
}

export interface FileUploadOptions {
  authorize: (metadata: FileUploadInput) => Promise<FileUpload>;
  /** Completed bytes, reported after each successful part, without counting retries twice. */
  onProgress?: (progress: { loaded: number; total: number }) => void;
  signal?: AbortSignal;
}

export interface FileDownloadOptions {
  authorize: (fileId: string) => Promise<FileGrant>;
  signal?: AbortSignal;
}

export interface FileDownload {
  file: FileMetadata;
  blob: Blob;
}
