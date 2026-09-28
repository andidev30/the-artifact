import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { scrubUrl } from './insightsUrl'

// Vercel Web Analytics and Speed Insights for the hosted service, as the privacy policy describes
// (legal/privacy.md). Every address is scrubbed of secrets before it leaves the browser.
export function Insights() {
  return (
    <>
      <Analytics beforeSend={(event) => ({ ...event, url: scrubUrl(event.url) })} />
      <SpeedInsights beforeSend={(event) => ({ ...event, url: scrubUrl(event.url) })} />
    </>
  )
}
