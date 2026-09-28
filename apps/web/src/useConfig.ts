import { useEffect, useState } from 'react'

export type AppConfig = {
  selfHosted: boolean
  googleSignIn: boolean
  // False when the server can't send email: people sign in with a password instead of a link
  emailSignIn: boolean
  // No accounts yet on a server without email; the sign-up page shows the setup form
  needsSetup: boolean
  // Without email: whether people may create a password account on their own (sign-up policy allows it)
  passwordSignUp?: boolean
  // Set by the instance admin; shown in the signed-in header
  instanceName?: string | null
  // Off on the hosted service until the Organization plan has billing: the app hides the ways to create one
  newOrganizations?: boolean
  // The API didn't answer (restarting, or down); the other fields are guesses
  unreachable?: boolean
}

// Fetched once per page load and shared by every component that asks
let pending: Promise<AppConfig> | null = null

function loadConfig(): Promise<AppConfig> {
  pending ??= fetch('/api/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .catch(() => {
      pending = null
      // Without an answer, assume the server's own default: a self-hosted install
      return { selfHosted: true, googleSignIn: false, emailSignIn: true, needsSetup: false, unreachable: true }
    })
  return pending
}

// null until the config has loaded
export function useConfig(): AppConfig | null {
  const [config, setConfig] = useState<AppConfig | null>(null)
  useEffect(() => {
    let active = true
    loadConfig().then((c) => active && setConfig(c))
    return () => {
      active = false
    }
  }, [])
  return config
}
