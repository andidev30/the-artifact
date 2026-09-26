import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { env } from './env.js'
import { sha256 } from './files.js'

// Page content (entry HTML, files, thumbnails) lives in an S3-compatible bucket such as MinIO,
// stored once per distinct content under blobs/<sha256>. Postgres keeps only the hashes, so a
// republish that reuses a stylesheet, or a restored version, stores nothing new.
// Blobs are never changed; ones nothing refers to any more are removed by sweepStorage (src/gc.ts).

const PREFIX = 'blobs/'

const s3 = new S3Client({
  region: env.storage.region,
  ...(env.storage.endpoint ? { endpoint: env.storage.endpoint } : {}),
  // A custom endpoint (MinIO and most other stores) wants bucket/key paths, not bucket.host names
  forcePathStyle: Boolean(env.storage.endpoint),
  ...(env.storage.accessKeyId
    ? { credentials: { accessKeyId: env.storage.accessKeyId, secretAccessKey: env.storage.secretAccessKey } }
    : {}),
})
const Bucket = env.storage.bucket

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

// Every stored blob with when it was written, a page of the listing at a time
export async function* listBlobs(): AsyncGenerator<{ hash: string; lastModified: Date }> {
  let ContinuationToken: string | undefined
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: PREFIX, ContinuationToken }))
    for (const o of res.Contents ?? []) {
      if (o.Key) yield { hash: o.Key.slice(PREFIX.length), lastModified: o.LastModified ?? new Date(0) }
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (ContinuationToken)
}

export async function deleteBlobs(hashes: string[]) {
  for (let i = 0; i < hashes.length; i += 1000) {
    const batch = hashes.slice(i, i + 1000)
    batch.forEach(forget)
    const res = await s3.send(
      new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch.map((h) => ({ Key: blobKey(h) })), Quiet: true } }),
    )
    if (res.Errors?.length) throw new Error(`Could not delete ${res.Errors.length} blobs: ${res.Errors[0].Message}`)
  }
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
  console.log(`Created the storage bucket "${Bucket}"`)
}

function bucketError(err: unknown, why?: string) {
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
  const where = env.storage.endpoint || 'AWS S3'
  const detail = why ?? `HTTP ${status ?? '?'}`
  return new Error(`Can't use the storage bucket "${Bucket}" at ${where}: ${detail} (${(err as Error).message}). Check the S3_* settings.`)
}
