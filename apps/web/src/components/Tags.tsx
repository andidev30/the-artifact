import { useEffect, useRef, useState, type FormEvent } from 'react'
import { changeTags, MAX_TAG_LENGTH, MAX_TAGS, type TagSummary } from '../api'
import { PageDialog } from './PageActions'
import './Tags.css'

// As the server keeps them: trimmed, single spaces, lowercase
export const normalTag = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

export function TagIcon() {
  return (
    <svg className="tag-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 3.5h6.5l7.5 7.5-6 6-7.5-7.5V3.5z" />
      <circle cx="6.8" cy="7.3" r="1.2" />
    </svg>
  )
}

type BarProps = {
  tags: TagSummary[]
  selected: string | null
  onSelect: (tag: string | null) => void
}

// Tag chips above the cards, next to the folders: pick one to see only pages with it
export function TagBar({ tags, selected, onSelect }: BarProps) {
  if (tags.length === 0) return null
  return (
    <nav className="folder-bar tag-bar" aria-label="Tags">
      <ul>
        {tags.map((t) => (
          <li key={t.tag}>
            <button type="button" className="folder-chip" aria-pressed={selected === t.tag} onClick={() => onSelect(selected === t.tag ? null : t.tag)}>
              <TagIcon />
              <span className="folder-chip-name">{t.tag}</span>
              <span className="folder-chip-count">{t.pages}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

type DialogProps = {
  slug: string
  title: string
  tags: string[]
  // Tags of other pages in the workspace, offered while typing
  suggestions?: string[]
  onClose: () => void
  onChanged: (tags: string[]) => void
}

// Adds and removes tags as you go; each change is saved at once
export function TagsDialog({ slug, title, tags: initial, suggestions = [], onClose, onChanged }: DialogProps) {
  const [tags, setTags] = useState(initial)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const input = useRef<HTMLInputElement>(null)
  // After showModal (the dialog's own effect runs first), which would focus the first remove button
  useEffect(() => input.current?.focus(), [])

  // Several at once, separated by commas
  const typed = [...new Set(value.split(',').map(normalTag).filter(Boolean))]
  const tooLong = typed.find((t) => [...t].length > MAX_TAG_LENGTH)
  const full = tags.length >= MAX_TAGS

  async function save(change: { add?: string[]; remove?: string[] }, done: string) {
    setBusy(true)
    setError(null)
    try {
      const next = await changeTags(slug, change)
      setTags(next)
      onChanged(next)
      setAnnounce(done)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The tags could not be saved. Try again.')
      return false
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    const add = typed.filter((t) => !tags.includes(t))
    if (!typed.length || tooLong) return
    if (!add.length) return setValue('')
    if (await save({ add }, `Added ${add.join(', ')}.`)) setValue('')
  }

  const offered = suggestions.filter((s) => !tags.includes(s))
  const hint = tooLong
    ? `“${tooLong.slice(0, 40)}” is over the ${MAX_TAG_LENGTH} character limit.`
    : full
      ? `This page has ${MAX_TAGS} tags, the most it can have. Remove one to add another.`
      : `Up to ${MAX_TAGS} tags of ${MAX_TAG_LENGTH} characters. Separate several with commas. Everyone who can open the page sees them.`

  return (
    <PageDialog labelledBy="tags-title" onClose={onClose}>
      <h2 id="tags-title">Tags for “{title}”</h2>
      {tags.length > 0 ? (
        <ul className="tags-edit" aria-label="Tags on this page">
          {tags.map((t) => (
            <li key={t}>
              <span>{t}</span>
              <button type="button" aria-label={`Remove ${t}`} disabled={busy} onClick={() => save({ remove: [t] }, `Removed ${t}.`)}>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="page-dialog-text tags-none">No tags yet.</p>
      )}
      <form onSubmit={onAdd}>
        <label className="page-dialog-label" htmlFor="tags-input">
          Add tags
        </label>
        <div className="tags-add">
          <input
            ref={input}
            id="tags-input"
            className="page-dialog-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            list={offered.length ? 'tags-suggestions' : undefined}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(tooLong) || Boolean(error) || undefined}
            aria-describedby={error ? 'tags-hint tags-error' : 'tags-hint'}
          />
          <button type="submit" className="button" disabled={busy || !typed.length || Boolean(tooLong) || full}>
            Add
          </button>
        </div>
        {offered.length > 0 && (
          <datalist id="tags-suggestions">
            {offered.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
        <p id="tags-hint" className="page-dialog-hint" data-over={tooLong ? true : undefined}>
          {hint}
        </p>
        {error && (
          <p id="tags-error" className="page-dialog-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <p className="visually-hidden" role="status">
        {announce}
      </p>
      <div className="page-dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          Done
        </button>
      </div>
    </PageDialog>
  )
}
