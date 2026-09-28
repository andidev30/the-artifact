import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import {
  compareVersions,
  FRAME_SANDBOX,
  getArtifact,
  listVersions,
  versionUrl,
  type ArtifactPage,
  type ArtifactVersion,
  type ComparedFile,
  type Comparison,
} from '../api'
import { timeAgo } from '../time'
import './Viewer.css'
import './Compare.css'

type State = { kind: 'loading' } | { kind: 'ready'; page: ArtifactPage; versions: ArtifactVersion[] } | { kind: 'missing' }

type Mode = 'side' | 'changes'

function versionParam(value: string | null): number | null {
  return value && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null
}

// Two versions of a page: both rendered next to each other, or what changed file by file.
// Editors only, like the history it is opened from.
export function Compare() {
  const { slug = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    Promise.all([getArtifact(slug), listVersions(slug)])
      .then(([page, versions]) => {
        if (!active) return
        if (!page?.canEdit || versions.length === 0) return setState({ kind: 'missing' })
        setState({ kind: 'ready', page, versions })
        document.title = `Compare versions of ${page.title} | The Artifact`
      })
      // Signed out, no access, or a page with a password: all look like a missing page
      .catch(() => active && setState({ kind: 'missing' }))
    return () => {
      active = false
      document.title = 'The Artifact'
    }
  }, [slug])

  if (state.kind === 'loading')
    return (
      <div className="viewer-status" role="status">
        Loading versions
      </div>
    )
  if (state.kind === 'missing')
    return (
      <main id="main" className="viewer-status compare-missing">
        <div>
          <h1>These versions aren't available</h1>
          <p>
            Only people who can edit a page can compare its versions. It may also have been deleted. <Link to="/app">Go to your pages</Link>
          </p>
        </div>
      </main>
    )

  const { page, versions } = state
  const known = new Set(versions.map((v) => v.version))
  const asked = [versionParam(params.get('from')), versionParam(params.get('to'))]
  // Missing or unknown versions fall back to the two newest
  const from = asked[0] !== null && known.has(asked[0]) ? asked[0] : (versions[1] ?? versions[0]).version
  const to = asked[1] !== null && known.has(asked[1]) ? asked[1] : versions[0].version
  const mode: Mode = params.get('view') === 'changes' ? 'changes' : 'side'

  function update(change: { from?: number; to?: number; view?: Mode }) {
    const next = { from, to, view: mode, ...change }
    const search = new URLSearchParams({ from: String(next.from), to: String(next.to) })
    if (next.view === 'changes') search.set('view', 'changes')
    setParams(search, { replace: true })
  }

  const label = (v: ArtifactVersion) => `Version ${v.version}${v.current ? ' (current)' : ''}, ${timeAgo(v.createdAt)}`

  return (
    <div className="compare" data-mode={mode}>
      <header className="viewer-bar">
        <Link className="viewer-mark" to="/app" aria-label="The Artifact">
          <span className="wordmark-mark" aria-hidden="true" />
        </Link>
        <div className="viewer-title">
          <h1>Compare versions</h1>
          <p>{page.title}</p>
        </div>
        <div className="viewer-actions">
          <Link className="viewer-history compare-back" to={`/a/${encodeURIComponent(page.slug)}`}>
            Back to page
          </Link>
        </div>
      </header>
      <main id="main" className="compare-main">
        <div className="compare-controls">
          <div className="compare-pickers">
            <div className="compare-picker">
              <label htmlFor="compare-from">From</label>
              <select id="compare-from" value={from} onChange={(e) => update({ from: Number(e.target.value) })}>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {label(v)}
                  </option>
                ))}
              </select>
            </div>
            <div className="compare-picker">
              <label htmlFor="compare-to">To</label>
              <select id="compare-to" value={to} onChange={(e) => update({ to: Number(e.target.value) })}>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {label(v)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="compare-modes" role="group" aria-label="Show">
            <button type="button" aria-pressed={mode === 'side'} onClick={() => update({ view: 'side' })}>
              Side by side
            </button>
            <button type="button" aria-pressed={mode === 'changes'} onClick={() => update({ view: 'changes' })}>
              Changes
            </button>
          </div>
        </div>
        <div className="compare-body">
          {mode === 'side' ? <SideBySide page={page} from={from} to={to} /> : <Changes slug={page.slug} from={from} to={to} />}
        </div>
      </main>
    </div>
  )
}

function SideBySide({ page, from, to }: { page: ArtifactPage; from: number; to: number }) {
  return (
    <div className="compare-sides">
      {(
        [
          ['from', 'From', from],
          ['to', 'To', to],
        ] as const
      ).map(([side, name, version]) => (
        <section key={side} className="compare-side" aria-labelledby={`compare-side-${side}`}>
          <h2 id={`compare-side-${side}`}>
            {name}: version {version}
            {version === page.version ? ' (current)' : ''}
          </h2>
          <iframe
            key={version}
            className="compare-frame"
            title={`${page.title}, version ${version}`}
            sandbox={FRAME_SANDBOX}
            src={versionUrl(page.slug, version)}
          />
        </section>
      ))}
    </div>
  )
}

type Loaded = { key: string; comparison: Comparison } | { key: string; error: string }

function Changes({ slug, from, to }: { slug: string; from: number; to: number }) {
  const key = `${from}-${to}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let active = true
    compareVersions(slug, from, to)
      .then((comparison) => active && setLoaded({ key: `${from}-${to}`, comparison }))
      .catch((err) => active && setLoaded({ key: `${from}-${to}`, error: err instanceof Error ? err.message : 'The versions could not be compared.' }))
    return () => {
      active = false
    }
  }, [slug, from, to])

  if (!loaded || loaded.key !== key)
    return (
      <p className="compare-note" role="status">
        Comparing versions
      </p>
    )
  if ('error' in loaded)
    return (
      <p className="compare-error" role="alert">
        {loaded.error}
      </p>
    )
  const { comparison } = loaded
  return (
    <div className="compare-changes">
      <p className="compare-summary" role="status">
        {summary(comparison)}
      </p>
      {comparison.files.length > 0 && (
        <p className="compare-note">
          Lines marked + were added in version {to}. Lines marked − were in version {from} and were removed.
        </p>
      )}
      {comparison.files.map((f) => (
        <FileChanges key={f.path} file={f} />
      ))}
    </div>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function summary(c: Comparison): string {
  if (c.files.length === 0) return `Version ${c.from} and version ${c.to} are the same.`
  const by = (status: ComparedFile['status']) => c.files.filter((f) => f.status === status).length
  const parts = [`${by('changed')} changed`, `${by('added')} added`, `${by('removed')} removed`, `${c.unchanged} unchanged`]
  return `${plural(c.files.length, 'file differs', 'files differ')}: ${parts.join(', ')}.`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const STATUS_LABEL: Record<ComparedFile['status'], string> = { added: 'Added', removed: 'Removed', changed: 'Changed' }

const OMITTED: Record<NonNullable<ComparedFile['omitted']>, string> = {
  binary: 'Not a text file, so there is no line diff.',
  large: 'Too big to show a line diff.',
  complex: 'Too many lines changed to show a line diff.',
  budget: 'No line diff: this comparison already shows as much as it can.',
}

function FileChanges({ file }: { file: ComparedFile }) {
  const side = file.to ?? file.from!
  const size = file.from && file.to ? `${formatBytes(file.from.size)} → ${formatBytes(file.to.size)}` : formatBytes(side.size)
  const lines =
    file.additions !== null && file.deletions !== null
      ? `, ${plural(file.additions, 'line', 'lines')} added, ${plural(file.deletions, 'line', 'lines')} removed`
      : ''
  return (
    <section className="compare-file" aria-label={`${STATUS_LABEL[file.status]}: ${file.path}`}>
      <h2>
        <span className="compare-status" data-status={file.status}>
          {STATUS_LABEL[file.status]}
        </span>
        <code>{file.path}</code>
      </h2>
      <p className="compare-meta">
        {side.contentType.split(';')[0]}, {size}
        {lines}
      </p>
      {file.diff ? <DiffLines diff={file.diff} /> : <p className="compare-note">{file.omitted ? OMITTED[file.omitted] : 'No line differences.'}</p>}
    </section>
  )
}

type Row = { kind: 'hunk' | 'same' | 'added' | 'removed' | 'note'; text: string; old?: number; new?: number }

// A unified diff as rows with line numbers, skipping the --- and +++ lines that name the files
function parseDiff(diff: string): Row[] {
  const rows: Row[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      inHunk = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line })
    } else if (!inHunk) continue
    else if (line.startsWith('\\')) rows.push({ kind: 'note', text: line.slice(2) })
    else if (line.startsWith('+')) rows.push({ kind: 'added', text: line.slice(1), new: newNo++ })
    else if (line.startsWith('-')) rows.push({ kind: 'removed', text: line.slice(1), old: oldNo++ })
    else rows.push({ kind: 'same', text: line.slice(1), old: oldNo++, new: newNo++ })
  }
  return rows
}

const MARKER: Record<Row['kind'], string> = { hunk: '', same: ' ', added: '+', removed: '−', note: '' }
const SPOKEN: Record<Row['kind'], string> = { hunk: '', same: '', added: 'Added: ', removed: 'Removed: ', note: '' }

function DiffLines({ diff }: { diff: string }) {
  const rows = parseDiff(diff)
  return (
    <div className="diff" role="list">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows never move; a diff is rendered once
        <div key={i} className="diff-row" data-kind={row.kind} role="listitem">
          {row.kind === 'hunk' ? (
            <span className="diff-hunk">{row.text}</span>
          ) : row.kind === 'note' ? (
            <span className="diff-text diff-note">{row.text}</span>
          ) : (
            <>
              <span className="diff-no" aria-hidden="true">
                {row.old ?? ''}
              </span>
              <span className="diff-no" aria-hidden="true">
                {row.new ?? ''}
              </span>
              <span className="diff-marker" aria-hidden="true">
                {MARKER[row.kind]}
              </span>
              <span className="diff-text">
                {SPOKEN[row.kind] && <span className="visually-hidden">{SPOKEN[row.kind]}</span>}
                {row.text}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
