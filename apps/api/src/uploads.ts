import { randomBytes } from 'node:crypto'
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

export async function prepareUpload(entries: ManifestEntry[]): Promise<PreparedUpload> {
  const { html, files } = checkManifest(entries)
  const uploadId = randomBytes(16).toString('hex')
  const byHash = new Map<string, FileMeta[]>()
  for (const f of [html, ...files]) byHash.set(f.sha256, [...(byHash.get(f.sha256) ?? []), f])

  const uploads: PreparedUpload['uploads'] = []
  const stored: string[] = []
  await Promise.all(
    [...byHash].map(async ([hash, same]) => {
      const paths = same.map((f) => f.path)
      if ((await blobSize(hash)) === same[0].size) stored.push(...paths)
      else uploads.push({ paths, size: same[0].size, url: await presignUpload(uploadId, hash, same[0].size) })
    }),
  )
  return { uploadId, uploads, stored }
}

export function checkUploadId(uploadId: string) {
  if (!UPLOAD_ID.test(uploadId)) throw new PublishError(`Unknown upload_id "${uploadId}". Call prepare_upload first.`)
}

// Moves every file of a version into storage, or throws without recording anything. Runs under
// the storage lock (see insertVersion), like any other write of blobs.
export async function claimUploads(uploadId: string, files: FileMeta[]) {
  const byHash = new Map(files.map((f) => [f.sha256, f]))
  await Promise.all(
    [...byHash.values()].map(async (f) => {
      const size = await blobSize(f.sha256)
      if (size === f.size) return
      if (size !== null) throw new PublishError(`"${f.path}" doesn't match the size you sent. Check its size and sha256.`)
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
