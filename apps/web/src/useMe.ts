import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { fetchMe, type Me } from './api'
import { LOGIN_URL } from './config'

export type MeState = { kind: 'loading' } | { kind: 'ready'; me: Me } | { kind: 'error' }

// Pages that loaded the account load it again, e.g. after joining an organization
const reloaders = new Set<() => void>()

export function refreshMe() {
  for (const reload of reloaders) reload()
}

// Loads the signed-in user and sends anyone signed out to the login page
export function useMe(): MeState {
  const navigate = useNavigate()
  const [state, setState] = useState<MeState>({ kind: 'loading' })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const reload = () => setVersion((v) => v + 1)
    reloaders.add(reload)
    return () => {
      reloaders.delete(reload)
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshMe() bumps version to load the account again
  useEffect(() => {
    let active = true
    fetchMe()
      .then((me) => {
        if (!active) return
        if (me) setState({ kind: 'ready', me })
        else navigate(LOGIN_URL, { replace: true })
      })
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [navigate, version])

  return state
}
