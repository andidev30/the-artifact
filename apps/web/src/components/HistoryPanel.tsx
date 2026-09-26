import { useEffect, useRef, useState } from 'react'
import { listVersions, restoreVersion, type ArtifactVersion } from '../api'
import { timeAgo } from '../time'
import './HistoryPanel.css'

export type Viewing = { version: number; createdAt: string }

const exactTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

function source(v: ArtifactVersion): string {
  if (v.restoredFrom) return `Restored from version ${v.restoredFrom}${v.publishedBy ? ` by ${v.publishedBy}` : ''}`
  const parts = [v.publishedWith ? `Published with ${v.publishedWith}` : 'Published', v.publishedBy ? `by ${v.publishedBy}` : '']
  return parts.filter(Boolean).join(' ')
}

type Props = {
  slug: string
  currentVersion: number
  selected: number
  onSelect: (v: Viewing | null) => void
  onClose: () => void
}

// Every version of the page, newest first. Picking one shows it in the frame; nothing changes
// until someone restores it.
export function HistoryPanel({ slug, currentVersion, selected, onSelect, onClose }: Props) {
  const [versions, setVersions] = useState<ArtifactVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    heading.current?.focus()
  }, [])

  useEffect(() => {
    let active = true
    listVersions(slug)
      .then((v) => active && setVersions(v))
      .catch((err) => active && setError(err instanceof Error ? err.message : 'The history could not be loaded.'))
    return () => {
      active = false
    }
  }, [slug, currentVersion])

  function pick(v: ArtifactVersion) {
    onSelect(v.version === currentVersion ? null : { version: v.version, createdAt: v.createdAt })
    // On narrow screens the panel covers the page, so get out of the way
    if (window.matchMedia('(max-width: 640px)').matches) onClose()
  }

  return (
    <aside id="history-panel" className="history-panel" aria-labelledby="history-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="history-head">
        <h2 id="history-title" ref={heading} tabIndex={-1}>Version history</h2>
        <button type="button" className="history-close" onClick={onClose} aria-label="Close version history">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
        </button>
      </div>
      {error && <p className="history-error" role="alert">{error}</p>}
      {!versions && !error && <p className="history-note" role="status">Loading versions</p>}
      {versions && (
        <ol className="history-list">
          {versions.map((v) => (
            <li key={v.version}>
              <button
                type="button"
                className="history-item"
                aria-current={v.version === selected ? 'true' : undefined}
                onClick={() => pick(v)}
              >
                <span className="history-item-top">
                  <strong>Version {v.version}</strong>
                  {v.current && <span className="history-current">Current</span>}
                </span>
                <time dateTime={v.createdAt} title={exactTime.format(new Date(v.createdAt))}>
                  {exactTime.format(new Date(v.createdAt))}, {timeAgo(v.createdAt)}
                </time>
                <span className="history-source">{source(v)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="history-note">Restoring publishes the old version again as a new one, so no version is ever lost.</p>
    </aside>
  )
}

// Shown above the frame while an older version is on screen
export function OldVersionBar({ slug, viewing, onBack, onRestored }: { slug: string; viewing: Viewing; onBack: () => void; onRestored: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restore() {
    setBusy(true)
    setError(null)
    try {
      await restoreVersion(slug, viewing.version)
      onRestored()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The version could not be restored. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="old-version-bar" role="region" aria-label="Older version">
      <p>
        <strong>Viewing version {viewing.version}</strong>
        <span>, published {timeAgo(viewing.createdAt)}. This isn't what people see at the link.</span>
      </p>
      <div className="old-version-actions">
        <button type="button" className="button button-quiet" onClick={onBack}>Back to latest</button>
        <button type="button" className="button" onClick={restore} disabled={busy}>{busy ? 'Restoring' : 'Restore this version'}</button>
      </div>
      {error && <p className="old-version-error" role="alert">{error}</p>}
    </div>
  )
}
