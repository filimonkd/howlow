/**
 * Object storage. Only references and metadata are kept in PostgreSQL; the
 * bytes live in the S3-compatible bucket, and never pass through the API.
 */
export {
  buildImageKey,
  createUploadSlot,
  deleteObject,
  readUrl,
  READ_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
} from './s3.js';
export type { StorageSettings, UploadSlot } from './s3.js';
