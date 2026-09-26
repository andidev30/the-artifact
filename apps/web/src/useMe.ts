import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { fetchMe, type Me } from './api'
import { LOGIN_URL } from './config'

export type MeState = { kind: 'loading' } | { kind: 'ready'; me: Me } | { kind: 'error' }

// Loads the signed-in user and sends anyone signed out to the login page
export function useMe(): MeState {
  const navigate = useNavigate()
  const [state, setState] = useState<MeState>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    fetchMe()
      .then((me) => {
        if (!active) return
        if (me) setState({ kind: 'ready', me })
        else navigate(LOGIN_URL, { replace: true })
      })
      .catch(() => active && setState({ kind: 'error' }))
    return () => { active = false }
  }, [navigate])

  return state
}
