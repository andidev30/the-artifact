import { useEffect, useRef, useState } from 'react'
import { getViews, type PageViews, type Visibility } from '../api'
import { timeAgo } from '../time'
import './HistoryPanel.css'
import './ViewsPanel.css'

const exactTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
const times = (n: number) => `${n} ${n === 1 ? 'view' : 'views'}`

type Props = {
  slug: string
  currentVersion: number
  visibility: Visibility
  onClose: () => void
}

// How often the page was opened and who opened it, for the people who can edit it
export function ViewsPanel({ slug, currentVersion, visibility, onClose }: Props) {
  const [views, setViews] = useState<PageViews | null>(null)
  const [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    heading.current?.focus()
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new current version adds a row
  useEffect(() => {
    let active = true
    getViews(slug)
      .then((v) => active && setViews(v))
      .catch((err) => active && setError(err instanceof Error ? err.message : 'The views could not be loaded.'))
    return () => {
      active = false
    }
  }, [slug, currentVersion])

  return (
    <aside id="views-panel" className="history-panel views-panel" aria-labelledby="views-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="history-head">
        <h2 id="views-title" ref={heading} tabIndex={-1}>
          Views
        </h2>
        <button type="button" className="history-close" onClick={onClose} aria-label="Close views">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </div>
      {error && (
        <p className="history-error" role="alert">
          {error}
        </p>
      )}
      {!views && !error && (
        <p className="history-note" role="status">
          Loading views
        </p>
      )}
      {views && (
        <>
          <p className="views-total">
            <strong>{views.total}</strong> {views.total === 1 ? 'view' : 'views'}
          </p>
          <section className="views-section" aria-labelledby="views-people-title">
            <h3 id="views-people-title">Who opened it</h3>
            {views.people.length === 0 ? (
              <p className="history-note">Nobody has opened it as themselves in the last {views.keptDays} days.</p>
            ) : (
              <ul className="views-list">
                {views.people.map((p) => (
                  <li key={p.email} className="views-person">
                    <strong>{p.name ?? p.email}</strong>
                    {p.name && <span className="views-email">{p.email}</span>}
                    <span className="views-meta">
                      <time dateTime={p.lastViewedAt} title={exactTime.format(new Date(p.lastViewedAt))}>
                        {timeAgo(p.lastViewedAt)}
                      </time>
                      , version {p.lastVersion}, {times(p.visits)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {views.morePeople && <p className="history-note">Only the {views.people.length} most recent are listed.</p>}
          </section>
          <section className="views-section" aria-labelledby="views-versions-title">
            <h3 id="views-versions-title">By version</h3>
            <ul className="views-list">
              {views.versions.map((v) => (
                <li key={v.version} className="views-version">
                  <span>
                    Version {v.version}
                    {v.version === currentVersion && <span className="history-current">Current</span>}
                  </span>
                  <span>{times(v.views)}</span>
                </li>
              ))}
            </ul>
          </section>
          <p className="history-note">
            {visibility === 'link' && 'Visits through the link are counted without saying who made them. '}
            Repeat visits by the same person within 30 minutes count once, and the owner's own visits don't count. Who opened it is kept for {views.keptDays}{' '}
            days.
          </p>
        </>
      )}
    </aside>
  )
}
