import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { getReleaseStatus, type ReleaseStatus } from '../adminApi'
import './ReleaseNotice.css'

// A newer release for the admins of a self-hosted server. Shows nothing while loading, when the
// server is current, when the check is off, or when it failed: the admin page never depends on it.
export function ReleaseNotice() {
  const [status, setStatus] = useState<ReleaseStatus | null>(null)

  useEffect(() => {
    let active = true
    getReleaseStatus()
      .then((data) => active && setStatus(data))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  if (!status?.newer) return null
  return (
    <section className="release-notice" aria-labelledby="release-notice-title">
      <p id="release-notice-title" className="release-notice-text">
        <strong>Version {status.newer.version} is out.</strong> This server runs {status.current}.
      </p>
      <p className="release-notice-links">
        <a className="text-link" href={status.newer.url} target="_blank" rel="noopener noreferrer">
          Release notes<span className="visually-hidden"> for {status.newer.version} (opens in a new tab)</span>
        </a>
        <Link className="text-link" to="/docs/upgrading">
          How to upgrade
        </Link>
      </p>
    </section>
  )
}
