import { randomBytes } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { ownedPages } from './artifacts.js'
import { db, schema } from './db/index.js'
import { checkManifest, type FileMeta, type ManifestEntry, PublishError } from './files.js'
import { blobSize, presignUpload, promoteUpload } from './storage.js'

// Publishing in two steps, for agents that can make HTTP requests of their own: prepare_upload
// checks the files and hands out upload links, the agent PUTs the bytes straight to the bucket,
// and publish_upload checks what arrived and records the version. Request bodies never pass
// through the API, so its size limits (and a serverless host's) don't apply to them.

const UPLOAD_ID = /^[0-9a-f]{32}$/

export type PreparedUpload = {
  uploadId: string
  // One link per distinct content: files with the same bytes share it
  uploads: { paths: string[]; size: number; url: string }[]
  // Content that is already stored needs no upload
  stored: string[]
}

// Who uploads: blockedOrgs as on Viewer
export type Uploader = { id: string; blockedOrgs?: readonly string[] }

// Content in a version of a page this person owns, where owning it still counts (ownedPages). Only
// that may skip the upload: blobs are shared by everyone on the server, so answering for any other
// content would tell whoever asks whether someone else has stored those exact bytes.
async function ownedBlobs(owner: Uploader, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set()
  const { artifacts, artifactVersions: versions, artifactFiles: files } = schema
  const owned = ownedPages(owner.id, owner.blockedOrgs)
  const [pages, extra] = await Promise.all([
    db
      .selectDistinct({ hash: versions.htmlSha256 })
      .from(versions)
      .innerJoin(artifacts, eq(artifacts.id, versions.artifactId))
      .where(and(owned, inArray(versions.htmlSha256, hashes))),
    db
      .selectDistinct({ hash: files.sha256 })
      .from(files)
      .innerJoin(versions, eq(versions.id, files.versionId))
      .innerJoin(artifacts, eq(artifacts.id, versions.artifactId))
      .where(and(owned, inArray(files.sha256, hashes))),
  ])
  return new Set([...pages, ...extra].map((r) => r.hash))
}

// Stored content of this person's own pages, with the size it was stored at
async function reusable(owner: Uploader, files: FileMeta[]): Promise<Set<string>> {
  const owned = await ownedBlobs(
    owner,
    files.map((f) => f.sha256),
  )
  const found = await Promise.all(files.filter((f) => owned.has(f.sha256)).map(async (f) => ((await blobSize(f.sha256)) === f.size ? f.sha256 : null)))
  return new Set(found.filter((h) => h !== null))
}

// partial: only some files of a page, for an update of it (index.html optional)
export async function prepareUpload(entries: ManifestEntry[], owner: Uploader, opts: { partial?: boolean } = {}): Promise<PreparedUpload> {
  const { html, files } = opts.partial ? checkManifest(entries, { partial: true }) : checkManifest(entries)
  const uploadId = randomBytes(16).toString('hex')
  const byHash = new Map<string, FileMeta[]>()
  for (const f of html ? [html, ...files] : files) byHash.set(f.sha256, [...(byHash.get(f.sha256) ?? []), f])
  const skip = await reusable(
    owner,
    [...byHash.values()].map((same) => same[0]),
  )

  const uploads: PreparedUpload['uploads'] = []
  const stored: string[] = []
  await Promise.all(
    [...byHash].map(async ([hash, same]) => {
      const paths = same.map((f) => f.path)
      if (skip.has(hash)) stored.push(...paths)
      else uploads.push({ paths, size: same[0].size, url: await presignUpload(uploadId, hash, same[0].size) })
    }),
  )
  return { uploadId, uploads, stored }
}

export function checkUploadId(uploadId: string) {
  if (!UPLOAD_ID.test(uploadId)) throw new PublishError(`Unknown upload_id "${uploadId}". Call prepare_upload first.`)
}

// Moves every file of a version into storage, or throws without recording anything. Runs under
// the storage lock (see insertVersion), like any other write of blobs. Anything prepare_upload
// didn't skip must have been uploaded, even if the same bytes are already stored for someone else.
export async function claimUploads(uploadId: string, files: FileMeta[], owner: Uploader) {
  const byHash = [...new Map(files.map((f) => [f.sha256, f])).values()]
  const skip = await reusable(owner, byHash)
  await Promise.all(
    byHash.map(async (f) => {
      if (skip.has(f.sha256)) return
      const result = await promoteUpload(uploadId, f.sha256, f.size)
      if (result === 'missing')
        throw new PublishError(`"${f.path}" wasn't uploaded. PUT it to the link prepare_upload gave, or call prepare_upload again if the link expired.`)
      if (result === 'mismatch')
        throw new PublishError(
          `What was uploaded for "${f.path}" doesn't match its size and sha256. Check both, call prepare_upload again and upload it again.`,
        )
    }),
  )
}
