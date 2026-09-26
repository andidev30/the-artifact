import { useEffect, useState } from 'react'

export type AppConfig = {
  selfHosted: boolean
  googleSignIn: boolean
}

// Fetched once per page load and shared by every component that asks
let pending: Promise<AppConfig> | null = null

function loadConfig(): Promise<AppConfig> {
  pending ??= fetch('/api/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .catch(() => {
      pending = null
      // Without an answer, assume the defaults of the hosted site
      return { selfHosted: false, googleSignIn: true }
    })
  return pending
}

// null until the config has loaded
export function useConfig(): AppConfig | null {
  const [config, setConfig] = useState<AppConfig | null>(null)
  useEffect(() => {
    let active = true
    loadConfig().then((c) => active && setConfig(c))
    return () => { active = false }
  }, [])
  return config
}
