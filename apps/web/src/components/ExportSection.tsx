import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { getDataExport, startDataExport, type DataExport } from '../api'
import { useConfig } from '../useConfig'
import './ExportSection.css'

const POLL_MS = 3000

const VERSIONS = [
  { id: 'current', label: 'Only the current version', hint: 'Smaller and quicker. The list of every version is still included.' },
  { id: 'all', label: 'Every version', hint: 'The whole history of every page.' },
] as const

function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const timeText = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// "Export your data" in account settings (organization null), and the same for an organization's
// owners in its settings. The server builds the zip in steps; while it does, this asks how it is
// going every few seconds, which is also what moves it on where the server has no background process.
export function ExportSection({ organization }: { organization: { id: string; name: string } | null }) {
  const orgId = organization?.id ?? null
  const [current, setCurrent] = useState<DataExport | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [versions, setVersions] = useState<'current' | 'all'>('current')
  const [starting, setStarting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const building = current?.status === 'building'

  useEffect(() => {
    let active = true
    getDataExport(orgId)
      .then((e) => {
        if (!active) return
        setCurrent(e)
        setLoaded(true)
      })
      .catch(() => active && setLoaded(true))
    return () => {
      active = false
    }
  }, [orgId])

  useEffect(() => {
    if (!building) return
    let active = true
    let timer: number | undefined
    const poll = () => {
      getDataExport(orgId)
        .then((e) => active && setCurrent(e))
        .catch(() => {})
        .finally(() => {
          if (active) timer = window.setTimeout(poll, POLL_MS)
        })
    }
    timer = window.setTimeout(poll, POLL_MS)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [building, orgId])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setStarting(true)
    setProblem(null)
    try {
      setCurrent(await startDataExport(orgId, versions))
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The export could not be started. Try again.')
    }
    setStarting(false)
  }

  return (
    <section id="export" className="settings-card" aria-labelledby="export-title">
      <header className="settings-card-head">
        <h2 id="export-title">{organization ? 'Export organization data' : 'Export your data'}</h2>
        <p>
          {organization
            ? `A zip of every page in ${organization.name} with its versions, sharing and comments, and the organization’s members and settings.`
            : 'A zip of every page you own with its versions, sharing and comments, and your account details. Secrets like passwords and tokens are never included.'}{' '}
          <Link className="text-link" to="/docs/exporting-your-data">
            What is in it
          </Link>
        </p>
      </header>

      {current && <ExportStatus e={current} />}

      {loaded && !building && (
        <form className="settings-form" onSubmit={onSubmit}>
          <fieldset className="export-versions">
            <legend className="settings-label">Versions of each page</legend>
            {VERSIONS.map((v) => (
              <label key={v.id} className="export-version">
                <input
                  type="radio"
                  name={`export-versions-${orgId ?? 'account'}`}
                  value={v.id}
                  checked={versions === v.id}
                  onChange={() => setVersions(v.id)}
                />
                <span>
                  <strong>{v.label}</strong>
                  <span>{v.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div>
            <button type="submit" className="button button-small" disabled={starting}>
              {starting ? 'Starting' : current?.status === 'ready' ? 'Make a new export' : 'Export data'}
            </button>
          </div>
          {problem && (
            <p className="auth-notice" role="alert">
              {problem}
            </p>
          )}
        </form>
      )}
    </section>
  )
}

function ExportStatus({ e }: { e: DataExport }) {
  const email = useConfig()?.emailSignIn === true
  if (e.status === 'building') {
    return (
      <p className="export-status" role="status">
        Building the export: {e.pagesDone} of {e.pagesTotal} {e.pagesTotal === 1 ? 'page' : 'pages'} so far.{' '}
        {e.buildsOnPoll
          ? `Keep this page open until it is ready${email ? '; you also get an email then.' : '.'}`
          : `It carries on if you leave this page${email ? ', and you get an email when it is ready.' : '.'}`}
      </p>
    )
  }
  if (e.status === 'failed') {
    return (
      <p className="auth-notice" role="alert">
        {e.error ?? 'The export could not be finished. Try again.'}
      </p>
    )
  }
  return (
    <div className="export-ready" role="status">
      <p>
        <strong>Your export is ready.</strong> {e.size !== null && `${sizeText(e.size)}, `}
        {e.allVersions ? 'every version' : 'current versions only'}. The link works until {timeText(e.expiresAt!)}, only for you.
      </p>
      <a className="button button-small" href={e.downloadUrl!} download>
        Download zip
      </a>
    </div>
  )
}
