import { createHash, createHmac, randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';

/**
 * S3-compatible object storage, against the MinIO the compose stack already
 * runs and the `S3_*` settings the environment already validates.
 *
 * ## Why presigned URLs rather than an SDK
 *
 * Image bytes never pass through the API. A caller asks for an upload slot,
 * the API returns a short-lived URL signed for **one key it generated itself**,
 * and the browser PUTs directly to storage. That keeps multi-megabyte uploads
 * off the API's event loop, and it means there is no code path where a caller
 * supplies an object path — which is what stops one seller writing over
 * another's objects, or escaping the bucket prefix entirely.
 *
 * Signing is SigV4, implemented here with `node:crypto`. The AWS SDK would add
 * a large dependency tree to do the same few lines of HMAC, and the storage
 * system itself is unchanged: this is a client for the MinIO already
 * configured, not a new store.
 */
const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
/** Presigned PUTs are signed without hashing the body, which the client holds. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface StorageSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
}

function settings(): StorageSettings {
  const env = loadConfig();
  return {
    endpoint: env.S3_ENDPOINT.replace(/\/+$/, ''),
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  };
}

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac('sha256', key).update(value, 'utf8').digest();

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` unescaped, and S3
 * expects them escaped — a key containing one would otherwise fail to verify.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Each path segment is encoded; the separators are not. */
const encodePath = (path: string): string => path.split('/').map(uriEncode).join('/');

function amzDate(now: Date): { long: string; short: string } {
  const long = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { long, short: long.slice(0, 8) };
}

function signingKey(secretKey: string, shortDate: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, shortDate), region), SERVICE), 'aws4_request');
}

/**
 * A safe object key.
 *
 * Built entirely from server-side values: the owning seller, the product, a
 * fresh uuid and an extension derived from the accepted content type. Nothing
 * a caller sent reaches the key, so `../` traversal, absolute paths and
 * collisions with another seller's prefix are all impossible by construction
 * rather than by filtering.
 */
export function buildImageKey(input: { sellerId: string; productId: string; contentType: string }): string {
  const extension = EXTENSION_BY_CONTENT_TYPE[input.contentType];
  if (extension === undefined) {
    throw new Error(`Refusing to build a key for unsupported content type ${input.contentType}`);
  }
  return `products/${input.sellerId}/${input.productId}/${randomUUID()}.${extension}`;
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string | undefined> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function objectPath(config: StorageSettings, key: string): string {
  return config.forcePathStyle ? `/${encodePath(config.bucket)}/${encodePath(key)}` : `/${encodePath(key)}`;
}

function hostFor(config: StorageSettings): string {
  const url = new URL(config.endpoint);
  return config.forcePathStyle ? url.host : `${config.bucket}.${url.host}`;
}

/**
 * Presign one request for a single key and method.
 *
 * `Content-Type` and `Content-Length` are signed for an upload, so the client
 * cannot present a slot issued for a small JPEG and then push a large
 * executable through it.
 */
export interface PresignInput {
  readonly method: 'GET' | 'PUT' | 'DELETE';
  readonly key: string;
  readonly expiresInSeconds: number;
  readonly signedHeaders?: Record<string, string> | undefined;
  readonly now?: Date | undefined;
}

export interface PresignResult {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** The bare signature, so the implementation can be checked against a known vector. */
  readonly signature: string;
}

/**
 * Sign against explicitly supplied settings.
 *
 * Separated from `presign` so the implementation can be run against AWS's
 * published SigV4 test vector, which fixes the credentials, region, bucket and
 * timestamp. An unverified signing implementation is indistinguishable from a
 * broken one until the first upload fails.
 */
export function presignWith(config: StorageSettings, input: PresignInput): PresignResult {
  const { long, short } = amzDate(input.now ?? new Date());
  const host = hostFor(config);

  const headers: Record<string, string> = { host, ...(input.signedHeaders ?? {}) };
  const headerNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = headerNames
    .map((name) => {
      const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
      return `${name}:${String(entry?.[1] ?? '').trim()}\n`;
    })
    .join('');
  const signedHeaderList = headerNames.join(';');

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${config.accessKey}/${short}/${config.region}/${SERVICE}/aws4_request`,
    'X-Amz-Date': long,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaderList,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name] ?? '')}`)
    .join('&');

  const path = objectPath(config, input.key);
  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const scope = `${short}/${config.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, long, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(config.secretKey, short, config.region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  const origin = config.forcePathStyle ? config.endpoint : `${new URL(config.endpoint).protocol}//${host}`;

  return {
    url: `${origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    headers: Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host')),
    signature,
  };
}

const presign = (input: PresignInput): PresignResult => presignWith(settings(), input);

/** Seconds an upload slot stays usable. Long enough for a slow connection. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** Seconds a read URL stays usable. Short, because pages re-fetch them. */
export const READ_URL_TTL_SECONDS = 60 * 60;

export interface UploadSlot {
  readonly key: string;
  readonly uploadUrl: string;
  readonly headers: Record<string, string>;
  readonly expiresInSeconds: number;
}

export function createUploadSlot(input: {
  sellerId: string;
  productId: string;
  contentType: string;
  sizeBytes: number;
}): UploadSlot {
  const key = buildImageKey(input);
  const { url, headers } = presign({
    method: 'PUT',
    key,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    signedHeaders: {
      'content-type': input.contentType,
      'content-length': String(input.sizeBytes),
    },
  });
  return { key, uploadUrl: url, headers, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
}

/** A time-limited URL for reading one object. */
export function readUrl(key: string): string {
  return presign({ method: 'GET', key, expiresInSeconds: READ_URL_TTL_SECONDS }).url;
}

/**
 * Remove an object.
 *
 * Deleting the row is what matters for correctness, so a storage failure is
 * reported to the caller rather than thrown: an orphaned object costs a little
 * disk, while a failed delete that rolls back the row would leave an image the
 * seller believes they removed.
 */
export async function deleteObject(key: string): Promise<{ deleted: boolean; reason?: string }> {
  const { url } = presign({ method: 'DELETE', key, expiresInSeconds: 60 });
  try {
    const response = await fetch(url, { method: 'DELETE' });
    // S3 answers 204 for a successful delete and for an absent key alike.
    if (response.ok || response.status === 404) return { deleted: true };
    return { deleted: false, reason: `storage responded ${response.status}` };
  } catch (error) {
    return { deleted: false, reason: error instanceof Error ? error.message : 'unknown error' };
  }
}
