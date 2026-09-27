import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate } from 'react-router'
import { useConfig } from '../useConfig'
import { NotFound } from './NotFound'
import { ServerUnreachable } from './Status'

const Landing = lazy(() => import('../ee/Landing').then((m) => ({ default: m.Landing })))
const ContactSales = lazy(() => import('../ee/ContactSales').then((m) => ({ default: m.ContactSales })))

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

// Pages that only exist on the hosted service; a self-hosted install answers them with Not found
function CloudOnly({ children }: { children: ReactNode }) {
  const config = useConfig()
  if (!config) return null
  if (config.selfHosted) return <NotFound />
  return <Suspense fallback={null}>{children}</Suspense>
}
