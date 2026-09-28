import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useConfig } from '../useConfig'
import { NotFound } from './NotFound'
import { ServerUnreachable } from './Status'

const Landing = lazy(() => import('../ee/Landing').then((m) => ({ default: m.Landing })))
const ContactSales = lazy(() => import('../ee/ContactSales').then((m) => ({ default: m.ContactSales })))
const Legal = lazy(() => import('../ee/Legal').then((m) => ({ default: m.Legal })))
const Insights = lazy(() => import('../ee/Insights').then((m) => ({ default: m.Insights })))

// Nothing until the config says which kind of install this is, so a self-hosted one never flashes
// the marketing site. A self-hosted install is the product itself.
export function Home() {
  const config = useConfig()
  if (!config) return null
  if (config.unreachable) return <ServerUnreachable />
  if (config.selfHosted) return <Navigate to="/app" replace />
  return (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  )
}

export function ContactSalesPage() {
  return (
    <CloudOnly>
      <ContactSales />
    </CloudOnly>
  )
}

// The hosted service's terms, privacy policy, sub-processors and DPA; a self-hosted install has none of its own
export function LegalPage() {
  return (
    <CloudOnly>
      <Legal />
    </CloudOnly>
  )
}

// Vercel Web Analytics and Speed Insights, on the hosted service only: a self-hosted install sends
// nothing to Vercel
export function HostedInsights() {
  const config = useConfig()
  if (!config || config.unreachable || config.selfHosted) return null
  return (
    <Suspense fallback={null}>
      <Insights />
    </Suspense>
  )
}

// Pages that only exist on the hosted service; a self-hosted install answers them with Not found
function CloudOnly({ children }: { children: ReactNode }) {
  const config = useConfig()
  if (!config) return null
  if (config.selfHosted) return <NotFound />
  return <Suspense fallback={null}>{children}</Suspense>
}
