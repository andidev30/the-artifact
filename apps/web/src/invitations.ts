import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { acceptMyInvitation, ApiError, declineMyInvitation, listMyInvitations, type MyInvitation, type Organization } from './api'
import { refreshMe } from './useMe'
import { chooseWorkspace } from './workspace'

// Invitations to the signed-in person's email, shared by the home notice, the workspace switcher
// and onboarding so they load once and disappear everywhere when answered.
const EMPTY: MyInvitation[] = []
let loadedFor: string | null = null
let list: MyInvitation[] = EMPTY
const listeners = new Set<() => void>()

function set(next: MyInvitation[]) {
  list = next
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function load(userId: string) {
  if (loadedFor === userId) return
  loadedFor = userId
  set(EMPTY)
  listMyInvitations()
    .then((rows) => loadedFor === userId && set(rows))
    // Invitations are a convenience here; the email link still works if this fails
    .catch(() => { if (loadedFor === userId) loadedFor = null })
}

export function usePendingInvitations(userId: string) {
  useEffect(() => load(userId), [userId])
  const invitations = useSyncExternalStore(subscribe, () => list, () => EMPTY)

  // Joins, switches to the organization and reloads the account so it shows up
  const accept = useCallback(async (invitation: MyInvitation): Promise<Organization> => {
    let org: Organization
    try {
      org = await acceptMyInvitation(invitation.id)
    } catch (err) {
      // Revoked or expired in the meantime: it can't be answered any more
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) set(list.filter((i) => i.id !== invitation.id))
      throw err
    }
    set(list.filter((i) => i.id !== invitation.id))
    chooseWorkspace(org.id)
    refreshMe()
    return org
  }, [])

  const decline = useCallback(async (invitation: MyInvitation) => {
    await declineMyInvitation(invitation.id)
    set(list.filter((i) => i.id !== invitation.id))
  }, [])

  return { invitations, accept, decline }
}

export const INVITE_ROLE_TEXT = { admin: 'an admin', member: 'a member' } as const
