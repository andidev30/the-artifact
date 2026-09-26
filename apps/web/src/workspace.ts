import { useCallback, useSyncExternalStore } from 'react'
import type { Me, Organization } from './api'

// Which workspace the signed-in person is looking at: 'personal' or an organization id.
// Remembered in this browser only.
const KEY = 'the-artifact.workspace'
const listeners = new Set<() => void>()
let memory: string | null = null

function read(): string | null {
  try {
    return window.localStorage.getItem(KEY) ?? memory
  } catch {
    return memory
  }
}

export function chooseWorkspace(id: string) {
  memory = id
  try {
    window.localStorage.setItem(KEY, id)
  } catch {
    // Storage blocked; the choice lasts until the tab closes
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => e.key === KEY && listener()
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

// The chosen organization, or null for Personal. Falls back to the first organization,
// as before there was a choice, when nothing valid is stored.
export function resolveWorkspace(me: Me, stored: string | null): Organization | null {
  if (stored === 'personal') return null
  return me.organizations.find((o) => o.id === stored) ?? me.organizations[0] ?? null
}

export function useWorkspace(me: Me) {
  const stored = useSyncExternalStore(subscribe, read, () => null)
  const org = resolveWorkspace(me, stored)
  const choose = useCallback((id: string) => chooseWorkspace(id), [])
  return { org, name: org ? org.name : 'Personal', choose }
}
