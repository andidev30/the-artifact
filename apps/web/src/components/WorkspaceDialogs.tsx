import { useEffect, useState, type FormEvent } from 'react'
import { duplicateArtifact, fetchMe, FieldError, moveArtifact, type Visibility } from '../api'
import { PageDialog } from './PageActions'
import './Folders.css'

const MAX_TITLE = 200
const COPY_SUFFIX = ' (copy)'

export type WorkspaceChoice = { id: string; name: string }

// Where this person can publish: Personal and the organizations open to them (not ones that require
// a second factor they haven't set up)
function useWorkspaces(): WorkspaceChoice[] | 'error' | null {
  const [list, setList] = useState<WorkspaceChoice[] | 'error' | null>(null)
  useEffect(() => {
    let active = true
    fetchMe()
      .then((me) => {
        if (!active) return
        if (!me) return setList('error')
        setList([{ id: 'personal', name: 'Personal' }, ...me.organizations.filter((o) => !o.blocked).map((o) => ({ id: o.id, name: o.name }))])
      })
      .catch(() => active && setList('error'))
    return () => {
      active = false
    }
  }, [])
  return list
}

type OptionsProps = {
  name: string
  legend: string
  workspaces: WorkspaceChoice[] | 'error' | null
  choice: string
  onChoose: (id: string) => void
  // Shown but can't be chosen, e.g. where the page is now
  current?: string
  hidden?: (id: string) => boolean
  describedBy?: string
}

function WorkspaceOptions({ name, legend, workspaces, choice, onChoose, current, hidden, describedBy }: OptionsProps) {
  if (workspaces === null) return <p className="page-dialog-text">Loading your workspaces…</p>
  if (workspaces === 'error')
    return (
      <p className="page-dialog-error" role="alert">
        Your workspaces could not be loaded. Close this and try again.
      </p>
    )
  return (
    <fieldset className="move-options" aria-describedby={describedBy}>
      <legend className="page-dialog-label">{legend}</legend>
      <div className="move-list">
        {workspaces
          .filter((w) => !hidden?.(w.id))
          .map((w) => (
            <label key={w.id} className="move-option" data-disabled={w.id === current || undefined}>
              <input type="radio" name={name} value={w.id} checked={choice === w.id} disabled={w.id === current} onChange={() => onChoose(w.id)} />
              <span>
                {w.name}
                {w.id === current ? ' (where it is now)' : ''}
              </span>
            </label>
          ))}
      </div>
    </fieldset>
  )
}

function copyTitle(title: string) {
  return `${title.slice(0, MAX_TITLE - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`
}

type DuplicateProps = {
  slug: string
  title: string
  // The workspace chosen at first: where the person is looking, when they can publish there
  preferred: string
  onClose: () => void
  onDuplicated: (copy: { slug: string; title: string; workspace: string }, workspaceName: string) => void
}

export function DuplicateDialog({ slug, title, preferred, onClose, onDuplicated }: DuplicateProps) {
  const workspaces = useWorkspaces()
  const [choice, setChoice] = useState<string | null>(null)
  const [name, setName] = useState(copyTitle(title))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const list = Array.isArray(workspaces) ? workspaces : []
  const selected = choice ?? (list.some((w) => w.id === preferred) ? preferred : 'personal')
  const trimmed = name.trim()
  const tooLong = trimmed.length > MAX_TITLE

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!trimmed || tooLong || !Array.isArray(workspaces)) return
    setBusy(true)
    setError(null)
    try {
      const copy = await duplicateArtifact(slug, selected, trimmed)
      onDuplicated(copy, list.find((w) => w.id === copy.workspace)?.name ?? 'Personal')
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'The page could not be duplicated. Try again.',
        field: err instanceof FieldError ? err.field : undefined,
      })
      setBusy(false)
    }
  }

  return (
    <PageDialog labelledBy="duplicate-title" onClose={onClose}>
      <form onSubmit={onSubmit}>
        <h2 id="duplicate-title">Duplicate “{title}”</h2>
        <label className="page-dialog-label" htmlFor="duplicate-name">
          Name of the copy
        </label>
        <input
          id="duplicate-name"
          className="page-dialog-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          aria-invalid={tooLong || error?.field === 'title' || undefined}
          aria-describedby={error?.field === 'title' ? 'duplicate-hint duplicate-error' : 'duplicate-hint'}
        />
        <p id="duplicate-hint" className="page-dialog-hint" data-over={tooLong || undefined}>
          {tooLong ? `${trimmed.length - MAX_TITLE} characters over the ${MAX_TITLE} limit.` : 'The copy is yours, with its own link.'}
        </p>
        <WorkspaceOptions
          name="duplicate-workspace"
          legend="Workspace"
          workspaces={workspaces}
          choice={selected}
          onChoose={setChoice}
          describedBy={error?.field === 'workspace' ? 'duplicate-error' : undefined}
        />
        <p className="page-dialog-text">
          It copies the current version only and starts Restricted: nobody else can open it until you share it. Comments and views stay with the original.
        </p>
        {error && (
          <p id="duplicate-error" className="page-dialog-error" role="alert">
            {error.message}
          </p>
        )}
        <div className="page-dialog-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || !trimmed || tooLong || !Array.isArray(workspaces)}>
            {busy ? 'Duplicating' : 'Duplicate'}
          </button>
        </div>
      </form>
    </PageDialog>
  )
}

type MoveProps = {
  slug: string
  title: string
  // 'personal' or the organization id the page is in now
  current: string
  // Only the owner can move a page into their personal workspace
  isOwner: boolean
  visibility: Visibility
  onClose: () => void
  onMoved: (moved: { visibility: Visibility; workspace: string }, workspaceName: string) => void
}

export function MoveWorkspaceDialog({ slug, title, current, isOwner, visibility, onClose, onMoved }: MoveProps) {
  const workspaces = useWorkspaces()
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = Array.isArray(workspaces) ? workspaces : []
  const hidden = (id: string) => id === 'personal' && !isOwner && current !== 'personal'
  const others = list.filter((w) => w.id !== current && !hidden(w.id))
  const selected = choice ?? others[0]?.id ?? ''
  const target = list.find((w) => w.id === selected)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      onMoved(await moveArtifact(slug, target.id), target.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The page could not be moved. Try again.')
      setBusy(false)
    }
  }

  const loaded = Array.isArray(workspaces)
  return (
    <PageDialog labelledBy="move-workspace-title" onClose={onClose}>
      <form onSubmit={onSubmit}>
        <h2 id="move-workspace-title">Move “{title}” to another workspace</h2>
        {loaded && others.length === 0 ? (
          <p className="page-dialog-text">
            There is no other workspace you can move it to.{' '}
            {isOwner ? 'Join an organization first.' : 'Only its owner can move it to their personal workspace.'}
          </p>
        ) : (
          <WorkspaceOptions
            name="move-workspace"
            legend="Workspace"
            workspaces={workspaces}
            choice={selected}
            onChoose={setChoice}
            current={current}
            hidden={hidden}
            describedBy={error ? 'move-workspace-error' : undefined}
          />
        )}
        <p className="page-dialog-text">
          The link, the people it is shared with, its link settings, comments and views stay the same. It leaves its folder, since folders belong to one
          workspace.
          {visibility === 'organization' && target
            ? selected === 'personal'
              ? ' It becomes Restricted, because only organizations can open a page to everyone in them.'
              : ` Everyone in ${target.name} will be able to open it.`
            : ''}
        </p>
        {error && (
          <p id="move-workspace-error" className="page-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="page-dialog-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || !target}>
            {busy ? 'Moving' : 'Move'}
          </button>
        </div>
      </form>
    </PageDialog>
  )
}
