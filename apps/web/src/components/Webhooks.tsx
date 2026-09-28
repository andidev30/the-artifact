import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import {
  createWebhook,
  deleteWebhook,
  FieldError,
  listWebhookDeliveries,
  listWebhooks,
  testWebhook,
  updateWebhook,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookFormat,
} from '../api'
import { timeAgo } from '../time'
import { CopyCommand } from './CopyCommand'
import './SignInSecurity.css'
import './Webhooks.css'

const EVENTS: { id: WebhookEvent; label: string; hint: string }[] = [
  { id: 'page.published', label: 'Page published', hint: 'A new page or a new version' },
  { id: 'comment.created', label: 'New comment', hint: 'A comment or a reply' },
  { id: 'page.opened', label: 'Page opened', hint: 'At most once every 10 minutes per page' },
]
const EVENT_LABEL: Record<string, string> = { ...Object.fromEntries(EVENTS.map((e) => [e.id, e.label])), 'webhook.test': 'Test message' }
const FORMAT_LABEL: Record<WebhookFormat, string> = { json: 'JSON', slack: 'Slack', discord: 'Discord' }
const STATUS_LABEL: Record<string, string> = { pending: 'Retrying', delivered: 'Delivered', failed: 'Failed' }

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

type Loadable<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error' }

// Webhooks of one workspace: 'personal' in account settings, an organization id in its settings
export function WebhooksSection({ workspace, name }: { workspace: string; name: string }) {
  const [hooks, setHooks] = useState<Loadable<{ webhooks: Webhook[]; max: number }>>({ kind: 'loading' })
  const [editing, setEditing] = useState<string | null>(null)
  const [created, setCreated] = useState<{ secret: string; url: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listWebhooks(workspace)
      .then((data) => active && setHooks({ kind: 'ready', data }))
      .catch(() => active && setHooks({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [workspace])

  const replace = (hook: Webhook) =>
    setHooks((h) => (h.kind === 'ready' ? { kind: 'ready', data: { ...h.data, webhooks: h.data.webhooks.map((x) => (x.id === hook.id ? hook : x)) } } : h))
  const remove = (id: string) =>
    setHooks((h) => (h.kind === 'ready' ? { kind: 'ready', data: { ...h.data, webhooks: h.data.webhooks.filter((x) => x.id !== id) } } : h))

  const full = hooks.kind === 'ready' && hooks.data.webhooks.length >= hooks.data.max

  return (
    <section id="webhooks" className="settings-card" aria-labelledby="webhooks-title">
      <header className="settings-card-head">
        <h2 id="webhooks-title">Webhooks</h2>
        <p>
          Tell Slack, Discord or any address when a page in {name} is published, commented on or opened.{' '}
          <Link className="text-link" to="/docs/webhooks">
            How webhooks work
          </Link>
        </p>
      </header>

      {created && (
        <div className="settings-token-new" role="status">
          <p>
            <strong>Copy the signing secret now.</strong> You won’t be able to see it again. Use it to check that requests to {created.url} come from here.
          </p>
          <CopyCommand command={created.secret} label="Copy signing secret" plain />
          <div>
            <button type="button" className="button button-small button-quiet" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {hooks.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading webhooks
        </p>
      )}
      {hooks.kind === 'error' && (
        <p className="auth-notice" role="alert">
          The webhooks could not be loaded. Reload to try again.
        </p>
      )}
      {problem && (
        <p className="auth-notice" role="alert">
          {problem}
        </p>
      )}

      {hooks.kind === 'ready' && hooks.data.webhooks.length > 0 && (
        <ul className="settings-list" aria-label="Webhooks">
          {hooks.data.webhooks.map((hook) =>
            editing === hook.id ? (
              <li key={hook.id} className="webhook-item">
                <WebhookForm
                  workspace={workspace}
                  hook={hook}
                  onSaved={(saved) => {
                    replace(saved)
                    setEditing(null)
                  }}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <WebhookRow
                key={hook.id}
                workspace={workspace}
                hook={hook}
                onEdit={() => setEditing(hook.id)}
                onChanged={replace}
                onDeleted={() => remove(hook.id)}
                onProblem={setProblem}
              />
            ),
          )}
        </ul>
      )}

      {hooks.kind === 'ready' &&
        (editing === 'new' ? (
          <div className="webhook-item">
            <h3 className="settings-subhead">Add a webhook</h3>
            <WebhookForm
              workspace={workspace}
              onSaved={(saved, secret) => {
                setHooks((h) => (h.kind === 'ready' ? { kind: 'ready', data: { ...h.data, webhooks: [...h.data.webhooks, saved] } } : h))
                setEditing(null)
                if (secret) setCreated({ secret, url: new URL(saved.url).host })
              }}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : (
          <div className="webhook-add">
            <button type="button" className="button button-small" disabled={full} onClick={() => setEditing('new')}>
              Add webhook
            </button>
            {hooks.data.webhooks.length === 0 && <p className="settings-muted">No webhooks yet.</p>}
            {full && <p className="field-hint">A workspace can have up to {hooks.data.max} webhooks. Delete one to add another.</p>}
          </div>
        ))}
    </section>
  )
}

function WebhookRow({
  workspace,
  hook,
  onEdit,
  onChanged,
  onDeleted,
  onProblem,
}: {
  workspace: string
  hook: Webhook
  onEdit: () => void
  onChanged: (hook: Webhook) => void
  onDeleted: () => void
  onProblem: (text: string | null) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [log, setLog] = useState<Loadable<WebhookDelivery[]> | null>(null)
  const host = new URL(hook.url).host
  const logId = `webhook-log-${hook.id}`

  async function sendTest() {
    setBusy(true)
    setTest(null)
    try {
      const d = await testWebhook(workspace, hook.id)
      setTest(
        d.status === 'delivered' ? { tone: 'ok', text: `Sent. ${host} answered ${d.responseStatus}.` } : { tone: 'bad', text: d.lastError ?? 'It failed.' },
      )
      if (log) void loadLog()
    } catch (err) {
      setTest({ tone: 'bad', text: errorText(err, 'The test could not be sent. Try again.') })
    }
    setBusy(false)
  }

  async function toggle() {
    onProblem(null)
    try {
      onChanged(await updateWebhook(workspace, hook.id, { enabled: !hook.enabled }))
    } catch (err) {
      onProblem(errorText(err, 'The webhook could not be changed. Try again.'))
    }
  }

  async function remove() {
    onProblem(null)
    try {
      await deleteWebhook(workspace, hook.id)
      onDeleted()
    } catch (err) {
      onProblem(errorText(err, 'The webhook could not be deleted. Try again.'))
      setConfirming(false)
    }
  }

  async function loadLog() {
    try {
      setLog({ kind: 'ready', data: await listWebhookDeliveries(workspace, hook.id) })
    } catch {
      setLog({ kind: 'error' })
    }
  }

  function showLog() {
    if (log) {
      setLog(null)
      return
    }
    setLog({ kind: 'loading' })
    void loadLog()
  }

  const last = hook.lastDelivery

  return (
    <li className="webhook-item">
      <div className="webhook-row">
        <span className="webhook-who">
          <strong>
            <span className="webhook-url">{hook.url}</span>
            <span className="webhook-badge" data-on={hook.enabled || undefined}>
              {hook.enabled ? 'On' : 'Off'}
            </span>
          </strong>
          <span>
            {FORMAT_LABEL[hook.format]}: {hook.events.map((e) => EVENT_LABEL[e]).join(', ')}
          </span>
          <span>{last ? `Last event ${timeAgo(last.createdAt)}: ${STATUS_LABEL[last.status].toLowerCase()}` : 'Nothing sent yet'}</span>
        </span>
        <span className="webhook-actions">
          <button type="button" className="auth-reset" onClick={onEdit} aria-label={`Edit webhook to ${host}`}>
            Edit
          </button>
          <button type="button" className="auth-reset" onClick={toggle} aria-label={`${hook.enabled ? 'Turn off' : 'Turn on'} webhook to ${host}`}>
            {hook.enabled ? 'Turn off' : 'Turn on'}
          </button>
          <button type="button" className="auth-reset" disabled={busy || !hook.enabled} onClick={sendTest} aria-label={`Send a test to ${host}`}>
            {busy ? 'Sending' : 'Send a test'}
          </button>
          <button type="button" className="auth-reset" aria-expanded={Boolean(log)} aria-controls={logId} onClick={showLog}>
            {log ? 'Hide deliveries' : 'Recent deliveries'}
          </button>
          {confirming ? (
            <>
              <button type="button" className="button button-small button-danger" onClick={remove}>
                Delete
              </button>
              <button type="button" className="auth-reset" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="button button-small button-quiet" aria-label={`Delete webhook to ${host}`} onClick={() => setConfirming(true)}>
              Delete
            </button>
          )}
        </span>
      </div>
      {test && (
        <p className="field-hint" data-tone={test.tone} role="status">
          {test.text}
        </p>
      )}
      {log && (
        <div id={logId} className="webhook-log">
          {log.kind === 'loading' && (
            <p className="settings-muted" role="status">
              Loading deliveries
            </p>
          )}
          {log.kind === 'error' && (
            <p className="auth-notice" role="alert">
              The deliveries could not be loaded. Try again.
            </p>
          )}
          {log.kind === 'ready' && log.data.length === 0 && <p className="settings-muted">Nothing sent in the last 14 days.</p>}
          {log.kind === 'ready' && log.data.length > 0 && (
            <table className="webhook-table">
              <caption className="visually-hidden">Recent deliveries to {host}</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Result</th>
                  <th scope="col">Tries</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {log.data.map((d) => (
                  <tr key={d.id}>
                    <td>{EVENT_LABEL[d.event] ?? d.event}</td>
                    <td data-tone={d.status === 'failed' ? 'bad' : undefined}>
                      {STATUS_LABEL[d.status]}
                      {d.responseStatus !== null && ` (${d.responseStatus})`}
                      {d.lastError && d.status !== 'delivered' && <span className="webhook-error">{d.lastError}</span>}
                      {d.status === 'pending' && d.attempts > 0 && <span className="webhook-error">Next try {timeAgo(d.nextAttemptAt)}</span>}
                    </td>
                    <td>{d.attempts}</td>
                    <td>{timeAgo(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </li>
  )
}

function WebhookForm({
  workspace,
  hook,
  onSaved,
  onCancel,
}: {
  workspace: string
  hook?: Webhook
  onSaved: (hook: Webhook, secret?: string) => void
  onCancel: () => void
}) {
  const id = hook?.id ?? 'new'
  const [url, setUrl] = useState(hook?.url ?? '')
  const [format, setFormat] = useState<WebhookFormat>(hook?.format ?? 'slack')
  const [events, setEvents] = useState<WebhookEvent[]>(hook?.events ?? ['page.published', 'comment.created'])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ text: string; field?: string } | null>(null)
  const ids = { url: `webhook-url-${id}`, format: `webhook-format-${id}`, events: `webhook-events-${id}`, status: `webhook-status-${id}` }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (hook) onSaved(await updateWebhook(workspace, hook.id, { url, format, events }))
      else {
        const made = await createWebhook(workspace, { url, format, events })
        onSaved(made.webhook, made.secret)
      }
    } catch (err) {
      const field = err instanceof FieldError ? err.field : undefined
      setError({ text: errorText(err, 'The webhook could not be saved. Try again.'), field })
      if (field === 'url') document.getElementById(ids.url)?.focus()
    }
    setSaving(false)
  }

  // Opening the form puts the cursor in the address, for keyboard and screen reader users
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the form opens
  useEffect(() => {
    document.getElementById(ids.url)?.focus()
  }, [])

  const invalid = (field: string) => (error?.field === field ? { 'aria-invalid': true, 'aria-describedby': ids.status } : {})

  return (
    <form className="webhook-form" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor={ids.url}>Address</label>
        <input
          id={ids.url}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.slack.com/services/…"
          required
          autoComplete="off"
          spellCheck={false}
          {...invalid('url')}
        />
      </div>
      <div className="field">
        <label htmlFor={ids.format}>Format</label>
        <select id={ids.format} className="settings-select" value={format} onChange={(e) => setFormat(e.target.value as WebhookFormat)} {...invalid('format')}>
          <option value="slack">Slack incoming webhook</option>
          <option value="discord">Discord webhook</option>
          <option value="json">JSON, signed</option>
        </select>
      </div>
      <fieldset className="webhook-events" {...invalid('events')}>
        <legend>Events</legend>
        {EVENTS.map((ev) => (
          <label key={ev.id} className="settings-check">
            <input
              type="checkbox"
              checked={events.includes(ev.id)}
              onChange={(e) => setEvents((list) => (e.target.checked ? [...list, ev.id] : list.filter((x) => x !== ev.id)))}
            />
            <span>
              {ev.label} <span className="webhook-hint">{ev.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p id={ids.status} className="field-hint" data-tone={error ? 'bad' : undefined} aria-live="polite">
        {error?.text ?? (hook ? '' : 'You get a signing secret once the webhook is added.')}
      </p>
      <div className="settings-buttons">
        <button type="submit" className="button button-small" disabled={saving || !url.trim() || events.length === 0}>
          {saving ? 'Saving' : hook ? 'Save' : 'Add webhook'}
        </button>
        <button type="button" className="button button-small button-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
