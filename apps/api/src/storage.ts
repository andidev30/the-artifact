import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from './env.js'
import { sha256 } from './files.js'
import { log } from './log.js'
import { s3Duration } from './metrics.js'

// Page content (entry HTML, files, thumbnails) lives in an S3-compatible bucket such as MinIO,
// stored once per distinct content under blobs/<sha256>. Postgres keeps only the hashes, so a
// republish that reuses a stylesheet, or a restored version, stores nothing new.
// Blobs are never changed; ones nothing refers to any more are removed by sweepStorage (src/gc.ts).

const PREFIX = 'blobs/'
// Direct uploads land here first. Only the API writes under blobs/, after checking the hash, since a
// blob is shared by every page with the same content.
const UPLOADS = 'uploads/'
export const UPLOAD_TTL_SECONDS = 15 * 60

function client(endpoint: string) {
  return new S3Client({
    region: env.storage.region,
    ...(endpoint ? { endpoint } : {}),
    // A custom endpoint (MinIO and most other stores) wants bucket/key paths, not bucket.host names
    forcePathStyle: Boolean(endpoint),
    // By default the SDK signs a CRC32 of the request body into presigned upload links, and at signing
    // time that body is empty, so AWS S3 would refuse every real upload. Many S3-compatible stores
    // don't support the default checksums either. Integrity is ours: the API hashes what arrives.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(env.storage.accessKeyId ? { credentials: { accessKeyId: env.storage.accessKeyId, secretAccessKey: env.storage.secretAccessKey } } : {}),
  })
}

const s3 = client(env.storage.endpoint)
const Bucket = env.storage.bucket

// Times every request, retries included. A 404 is its own outcome: looking up a blob that isn't
// there is routine, not a storage problem.
s3.middlewareStack.add(
  (next, context) => async (args) => {
    const end = s3Duration.startTimer({ operation: (context.commandName ?? 'unknown').replace(/Command$/, '') })
    try {
      const result = await next(args)
      end({ outcome: 'ok' })
      return result
    } catch (err) {
      end({ outcome: (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 ? 'not_found' : 'error' })
      throw err
    }
  },
  { step: 'initialize', name: 'artifactMetrics' },
)

// Upload links are signed for the host agents connect to, which can differ from the API's
let signer: { endpoint: string; s3: S3Client } | null = null
function signingClient(): S3Client {
  const endpoint = env.storage.publicEndpoint
  if (signer?.endpoint !== endpoint) signer = { endpoint, s3: client(endpoint) }
  return signer.s3
}

// Read on every call, so tests can switch uploads off by changing env
export const directUploads = () => Boolean(env.storage.publicEndpoint)

export function blobKey(hash: string): string {
  return `${PREFIX}${hash}`
}

// Recently read blobs, since the same page's files are fetched by every viewer. Blobs never change,
// so the only thing to keep in step is deletion.
const CACHE_BYTES = 64 * 1024 * 1024
const CACHE_ENTRY_BYTES = 2 * 1024 * 1024
const cache = new Map<string, Buffer>()
let cached = 0

function remember(hash: string, data: Buffer) {
  if (data.length > CACHE_ENTRY_BYTES) return
  cache.delete(hash)
  cache.set(hash, data)
  cached += data.length
  for (const [key, value] of cache) {
    if (cached <= CACHE_BYTES) break
    cache.delete(key)
    cached -= value.length
  }
}

function forget(hash: string) {
  const data = cache.get(hash)
  if (data) {
    cache.delete(hash)
    cached -= data.length
  }
}

// Stores content and returns its hash, the key everything else refers to it by
export async function putBlob(content: Buffer | string, hash = sha256(content)): Promise<string> {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  await s3.send(new PutObjectCommand({ Bucket, Key: blobKey(hash), Body: body, ContentType: 'application/octet-stream' }))
  return hash
}

// The content stored under a hash, or null when there is none
export async function getBlob(hash: string): Promise<Buffer | null> {
  const hit = cache.get(hash)
  if (hit) {
    // Most recently used goes last
    cache.delete(hash)
    cache.set(hash, hit)
    return hit
  }
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket, Key: blobKey(hash) }))
    const data = Buffer.from(await res.Body!.transformToByteArray())
    remember(hash, data)
    return data
  } catch (err) {
    if (err instanceof NoSuchKey) return null
    throw err
  }
}

export async function getText(hash: string): Promise<string | null> {
  const data = await getBlob(hash)
  return data ? data.toString('utf8') : null
}

async function* listKeys(Prefix: string): AsyncGenerator<{ key: string; lastModified: Date }> {
  let ContinuationToken: string | undefined
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }))
    for (const o of res.Contents ?? []) {
      if (o.Key) yield { key: o.Key, lastModified: o.LastModified ?? new Date(0) }
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (ContinuationToken)
}

async function deleteKeys(keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) {
    const res = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }))
    if (res.Errors?.length) throw new Error(`Could not delete ${res.Errors.length} objects: ${res.Errors[0].Message}`)
  }
}

// Every stored blob with when it was written, a page of the listing at a time
export async function* listBlobs(): AsyncGenerator<{ hash: string; lastModified: Date }> {
  for await (const o of listKeys(PREFIX)) yield { hash: o.key.slice(PREFIX.length), lastModified: o.lastModified }
}

export async function deleteBlobs(hashes: string[]) {
  hashes.forEach(forget)
  await deleteKeys(hashes.map(blobKey))
}

// The size of a stored blob, or null when there is none
export async function blobSize(hash: string): Promise<number | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket, Key: blobKey(hash) }))
    return res.ContentLength ?? null
  } catch (err) {
    if (err instanceof NotFound || err instanceof NoSuchKey) return null
    throw err
  }
}

function uploadKey(uploadId: string, hash: string): string {
  return `${UPLOADS}${uploadId}/${hash}`
}

// A short-lived link an agent PUTs one file's bytes to, straight to the bucket
export function presignUpload(uploadId: string, hash: string, size: number): Promise<string> {
  return getSignedUrl(signingClient(), new PutObjectCommand({ Bucket, Key: uploadKey(uploadId, hash), ContentLength: size }), {
    expiresIn: UPLOAD_TTL_SECONDS,
  })
}

// Stores an uploaded file as a blob if its bytes really have this hash and size. The API hashes
// them itself rather than trusting a checksum header, which S3-compatible stores support unevenly.
export async function promoteUpload(uploadId: string, hash: string, size: number): Promise<'stored' | 'missing' | 'mismatch'> {
  const Key = uploadKey(uploadId, hash)
  let data: Buffer
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket, Key }))
    // Checked before reading, so an oversized upload never makes it into memory
    if (res.ContentLength !== size) {
      ;(res.Body as { destroy?: () => void } | undefined)?.destroy?.()
      await deleteKeys([Key])
      return 'mismatch'
    }
    data = Buffer.from(await res.Body!.transformToByteArray())
  } catch (err) {
    if (err instanceof NoSuchKey) return 'missing'
    throw err
  }
  await deleteKeys([Key])
  if (data.length !== size || sha256(data) !== hash) return 'mismatch'
  await putBlob(data, hash)
  return 'stored'
}

// Uploads never committed, once their links have long expired
export async function deleteStaleUploads(olderThanMs: number, now = Date.now()): Promise<number> {
  const stale: string[] = []
  for await (const o of listKeys(UPLOADS)) if (now - o.lastModified.getTime() >= olderThanMs) stale.push(o.key)
  await deleteKeys(stale)
  return stale.length
}

// Fails early, with a clear message, when the bucket can't be reached; creates it when missing
export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }))
    return
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status !== 404) throw bucketError(err)
  }
  try {
    await s3.send(new CreateBucketCommand({ Bucket }))
  } catch (err) {
    throw bucketError(err, 'it does not exist and could not be created')
  }
  log.info(`Created the storage bucket "${Bucket}"`)
}

// For GET /readyz: throws unless the bucket answers within the time given
export async function checkBucket(timeoutMs: number) {
  await s3.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(timeoutMs) })
}

function bucketError(err: unknown, why?: string) {
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
  const where = env.storage.endpoint || 'AWS S3'
  const detail = why ?? `HTTP ${status ?? '?'}`
  return new Error(`Can't use the storage bucket "${Bucket}" at ${where}: ${detail} (${(err as Error).message}). Check the S3_* settings.`)
}
