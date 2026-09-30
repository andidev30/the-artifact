import { inArray } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import { deleteObjects, getObject, listObjects, putObject } from './storage.js'
import { BrowserGone, inPage, type PageTree, type View } from './thumbnails.js'
import { UUID_RE } from './validation.js'

// A version as a PDF, printed by headless Chromium the way a browser's own Print does: with the page's
// print styles (@media print) and the paper size and margins its @page rules ask for, or A4 with 1 cm
// margins where it asks for none. Backgrounds are kept, so it looks like the page on screen. The page
// is opened through inPage in src/thumbnails.ts, like a thumbnail, so it reaches nothing beyond its own
// files and a few public CDNs, and it is laid out in a desktop window before it is printed, as
// someone printing it from a computer would.
//
// Printing takes turns with inspections, and reaches the renderer in a cluster, through src/renders.ts.
//
// A version never changes, so it is printed once: the PDF is kept in the bucket under
// pdfs/<FORMAT>/<version id>.pdf, with no row in Postgres, and the sweep removes it once the version is
// gone. FORMAT goes up when the way pages are printed changes, and the sweep then removes the older ones.

const VIEW: View = { width: 1280, height: 800 }
// A PDF crosses the cluster's IPC as base64 and is answered in one response
export const MAX_PDF_BYTES = 25 * 1024 * 1024

export type Pdf = { data: string }

export const PDFS = 'pdfs/'
const FORMAT = '1'
const pdfKey = (versionId: string) => `${PDFS}${FORMAT}/${versionId}.pdf`
// Versions looked up at once while sweeping
const SWEEP_BATCH = 500

export function storedPdf(versionId: string): Promise<Buffer | null> {
  return getObject(pdfKey(versionId))
}

export function storePdf(versionId: string, pdf: Buffer): Promise<void> {
  return putObject(pdfKey(versionId), pdf)
}

// Removes the PDFs of versions that no longer exist, and those printed in an older FORMAT. Version ids
// are never reused and a PDF is only served after its version is found, so one stored for a version
// deleted meanwhile is never served, and goes on the next sweep.
export async function sweepPdfs(deadline = Number.POSITIVE_INFINITY): Promise<number> {
  const stale: string[] = []
  let batch: { key: string; versionId: string }[] = []
  async function check() {
    if (batch.length === 0) return
    const v = schema.artifactVersions
    const rows = await db
      .select({ id: v.id })
      .from(v)
      .where(
        inArray(
          v.id,
          batch.map((b) => b.versionId),
        ),
      )
    const live = new Set(rows.map((r) => r.id))
    for (const b of batch) if (!live.has(b.versionId)) stale.push(b.key)
    batch = []
  }
  for await (const o of listObjects(PDFS)) {
    if (Date.now() >= deadline) break
    const [format, name = ''] = o.key.slice(PDFS.length).split('/')
    const versionId = name.replace(/\.pdf$/, '')
    if (format !== FORMAT || !UUID_RE.test(versionId)) stale.push(o.key)
    else {
      batch.push({ key: o.key, versionId })
      if (batch.length >= SWEEP_BATCH) await check()
    }
  }
  await check()
  await deleteObjects(stale)
  return stale.length
}

async function printOnce(tree: PageTree): Promise<Pdf> {
  return inPage(tree, { view: VIEW, what: 'Making the PDF' }, async ({ page }) => {
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
      printBackground: true,
      preferCSSPageSize: true,
      // Headings become bookmarks, and screen readers can follow the text
      outline: true,
      tagged: true,
    })
    if (pdf.length > MAX_PDF_BYTES) throw new Error(`The PDF came to more than ${MAX_PDF_BYTES / 1024 / 1024} MB`)
    return { data: pdf.toString('base64') }
  })
}

// Prints a version where Chromium runs
export function printTree(tree: PageTree): Promise<Pdf> {
  // Chromium dying under a print isn't the page's doing, so it gets one more try on a fresh one
  return printOnce(tree).catch((err) => {
    if (err instanceof BrowserGone) return printOnce(tree)
    throw err
  })
}
