import { useState, type FormEvent } from 'react'
import { createFolder, deleteFolder, moveToFolder, renameFolder, type FolderSummary } from '../api'
import { PageDialog } from './PageActions'
import './Folders.css'

export const MAX_FOLDER_NAME = 80

// 'all' for every page, 'none' for pages in no folder, or a folder id
export type FolderFilter = string

type BarProps = {
  folders: FolderSummary[]
  // Pages in the workspace, whatever their folder
  total: number | null
  selected: FolderFilter
  onSelect: (filter: FolderFilter) => void
  onNew: () => void
}

// Folder chips above the cards: pick one to see only its pages
export function FolderBar({ folders, total, selected, onSelect, onNew }: BarProps) {
  const filed = folders.reduce((sum, f) => sum + f.pages, 0)
  const loose = total === null ? null : Math.max(0, total - filed)
  const chip = (filter: FolderFilter, label: string, count: number | null) => (
    <li key={filter}>
      <button type="button" className="folder-chip" aria-pressed={selected === filter} onClick={() => onSelect(filter)}>
        {filter !== 'all' && filter !== 'none' && <FolderIcon />}
        <span className="folder-chip-name">{label}</span>
        {count !== null && <span className="folder-chip-count">{count}</span>}
      </button>
    </li>
  )

  return (
    <nav className="folder-bar" aria-label="Folders">
      <ul>
        {chip('all', 'All pages', total)}
        {folders.length > 0 && chip('none', 'No folder', loose)}
        {folders.map((f) => chip(f.id, f.name, f.pages))}
        <li>
          <button type="button" className="folder-chip folder-chip-new" onClick={onNew}>
            <span aria-hidden="true">+</span> New folder
          </button>
        </li>
      </ul>
    </nav>
  )
}

export function FolderIcon() {
  return (
    <svg className="folder-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.5 5.5v10h15v-8H9.5L8 5.5z" />
    </svg>
  )
}

function NameField({ value, onChange, hint, id }: { value: string; onChange: (v: string) => void; hint: string; id: string }) {
  const tooLong = value.trim().length > MAX_FOLDER_NAME
  return (
    <>
      <label className="page-dialog-label" htmlFor={id}>
        Name
      </label>
      <input
        id={id}
        className="page-dialog-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.target.select()}
        autoFocus
        autoComplete="off"
        aria-invalid={tooLong || undefined}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="page-dialog-hint" data-over={tooLong || undefined}>
        {tooLong ? `${value.trim().length - MAX_FOLDER_NAME} characters over the ${MAX_FOLDER_NAME} limit.` : hint}
      </p>
    </>
  )
}

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

type NameDialogProps = {
  workspaceId: string
  // Renames this folder; without it, creates one
  folder?: FolderSummary
  onClose: () => void
  onSaved: (folder: { id: string; name: string }) => void
}

export function FolderNameDialog({ workspaceId, folder, onClose, onSaved }: NameDialogProps) {
  const [value, setValue] = useState(folder?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = value.trim()
  const ok = trimmed.length > 0 && trimmed.length <= MAX_FOLDER_NAME

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!ok) return
    if (folder && trimmed === folder.name) return onClose()
    setBusy(true)
    setError(null)
    try {
      onSaved(folder ? await renameFolder(folder.id, trimmed) : await createFolder(workspaceId, trimmed))
      onClose()
    } catch (err) {
      setError(message(err, 'The folder could not be saved. Try again.'))
      setBusy(false)
    }
  }

  return (
    <PageDialog labelledBy="folder-name-title" onClose={onClose}>
      <form onSubmit={onSubmit}>
        <h2 id="folder-name-title">{folder ? 'Rename folder' : 'New folder'}</h2>
        <NameField id="folder-name" value={value} onChange={setValue} hint="Folders only group pages. They don't change who can open them." />
        {error && (
          <p className="page-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="page-dialog-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || !ok}>
            {busy ? 'Saving' : folder ? 'Save' : 'Create folder'}
          </button>
        </div>
      </form>
    </PageDialog>
  )
}

export function DeleteFolderDialog({ folder, onClose, onDeleted }: { folder: FolderSummary; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onDelete() {
    setBusy(true)
    setError(null)
    try {
      await deleteFolder(folder.id)
      onDeleted()
    } catch (err) {
      setError(message(err, 'The folder could not be deleted. Try again.'))
      setBusy(false)
    }
  }

  return (
    <PageDialog labelledBy="delete-folder-title" onClose={onClose}>
      <h2 id="delete-folder-title">Delete the folder “{folder.name}”?</h2>
      <p className="page-dialog-text">
        Only the folder goes. {folder.pages === 1 ? 'The page in it stays' : 'The pages in it stay'} in this workspace, in no folder, and everyone keeps their
        access.
      </p>
      {error && (
        <p className="page-dialog-error" role="alert">
          {error}
        </p>
      )}
      <div className="page-dialog-actions">
        <button type="button" className="button button-quiet" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button type="button" className="button page-dialog-danger" onClick={onDelete} disabled={busy}>
          {busy ? 'Deleting' : 'Delete folder'}
        </button>
      </div>
    </PageDialog>
  )
}

const NEW = 'new'

type MoveProps = {
  workspaceId: string
  title: string
  slug: string
  current: string | null
  folders: FolderSummary[]
  onClose: () => void
  // created: a folder made on the way
  onMoved: (folder: { id: string; name: string } | null, created: boolean) => void
}

export function MoveDialog({ workspaceId, title, slug, current, folders, onClose, onMoved }: MoveProps) {
  const [choice, setChoice] = useState<string>(current ?? '')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const creating = choice === NEW
  const ok = !creating || (name.trim().length > 0 && name.trim().length <= MAX_FOLDER_NAME)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!ok) return
    if (!creating && (choice || null) === current) return onClose()
    setBusy(true)
    setError(null)
    try {
      let target = choice || null
      if (creating) target = (await createFolder(workspaceId, name.trim())).id
      const { folder } = await moveToFolder(slug, target)
      onMoved(folder, creating)
      onClose()
    } catch (err) {
      setError(message(err, 'The page could not be moved. Try again.'))
      setBusy(false)
    }
  }

  const option = (value: string, label: string) => (
    <label key={value} className="move-option">
      <input type="radio" name="move-folder" value={value} checked={choice === value} onChange={() => setChoice(value)} />
      {value && value !== NEW && <FolderIcon />}
      <span>{label}</span>
    </label>
  )

  return (
    <PageDialog labelledBy="move-title" onClose={onClose}>
      <form onSubmit={onSubmit}>
        <h2 id="move-title">Move “{title}”</h2>
        <fieldset className="move-options">
          <legend className="page-dialog-label">Folder</legend>
          <div className="move-list">
            {option('', 'No folder')}
            {folders.map((f) => option(f.id, f.name))}
            {option(NEW, 'New folder…')}
          </div>
        </fieldset>
        {creating && <NameField id="move-new-name" value={name} onChange={setName} hint="The folder is created in this workspace." />}
        <p className="page-dialog-text">The link and who can open the page stay the same.</p>
        {error && (
          <p className="page-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="page-dialog-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || !ok}>
            {busy ? 'Moving' : 'Move'}
          </button>
        </div>
      </form>
    </PageDialog>
  )
}
