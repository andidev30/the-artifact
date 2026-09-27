// Scenario 1: people opening pages, the hot path. A visit loads the app shell for /a/<slug>, the page's
// details, then the version's entry HTML in the sandboxed frame and every file it references.
//   by link:    anonymous, a link-shared page; files load without a cookie, as from the sandbox
//   signed in:  an organization page with the session cookie; the frame's navigation is redirected to
//               /v/<n>/~<link token>/ and the files load under the token, without a cookie
import { check, sleep } from 'k6'
import http from 'k6/http'
import { BASE_URL, DURATION, loadSeed, pick, THINK, VUS } from '../lib/config.js'

const seed = loadSeed()
// Share of visits by link; the rest are signed-in visits to organization pages
const LINK_SHARE = Number(__ENV.LINK_SHARE ?? 0.7)
// The app shell (/a/<slug>, /api/config, /api/me) is only there when the API serves the built web
// app, as the Docker image does; set WITH_SHELL=false against pnpm dev's API
const WITH_SHELL = __ENV.WITH_SHELL !== 'false'

export const options = {
  scenarios: { open: { executor: 'constant-vus', vus: VUS, duration: DURATION } },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{step:shell}': ['p(95)<200'],
    'http_req_duration{step:details}': ['p(95)<200'],
    'http_req_duration{step:entry}': ['p(95)<300'],
    'http_req_duration{step:file}': ['p(95)<300'],
  },
}

const FILE_DEST = { css: 'style', js: 'script', png: 'image', json: 'empty' }
const dest = (path) => FILE_DEST[path.slice(path.lastIndexOf('.') + 1)] ?? 'empty'

export default function () {
  const byLink = Math.random() < LINK_SHARE
  const page = pick(byLink ? seed.pages.link : seed.pages.organization)
  const via = byLink ? 'link' : 'signed-in'
  const cookie = byLink ? {} : { cookie: pick(seed.users).cookie }
  const tags = (step) => ({ step, via })

  if (WITH_SHELL) {
    const shell = http.batch([
      ['GET', `${BASE_URL}/a/${page.slug}`, null, { headers: { ...cookie, 'sec-fetch-dest': 'document' }, tags: tags('shell') }],
      ['GET', `${BASE_URL}/api/config`, null, { tags: tags('shell') }],
      // Anonymous visitors get a 401 here, which the app expects
      ['GET', `${BASE_URL}/api/me`, null, { headers: cookie, tags: tags('shell'), responseCallback: http.expectedStatuses(200, 401) }],
    ])
    check(shell[0], { 'shell 200': (r) => r.status === 200 })
  }

  const details = http.get(`${BASE_URL}/api/artifacts/${page.slug}`, { headers: cookie, tags: tags('details') })
  check(details, { 'details 200': (r) => r.status === 200 })

  let base = `${BASE_URL}/api/artifacts/${page.slug}/v/${page.version}/`
  let entry = http.get(base, { headers: { ...cookie, 'sec-fetch-dest': 'iframe' }, redirects: 0, tags: tags(byLink ? 'entry' : 'entry-redirect') })
  if (!byLink) {
    check(entry, { 'redirected to a link token': (r) => r.status === 302 && r.headers.Location?.includes('/~') })
    const to = entry.headers.Location ?? ''
    base = to.startsWith('/') ? `${BASE_URL}${to}` : to
    // Browsers don't send the cookie from here on: the frame's origin is opaque
    entry = http.get(base, { headers: { 'sec-fetch-dest': 'iframe' }, tags: tags('entry') })
  }
  check(entry, { 'entry 200': (r) => r.status === 200 && r.headers['Content-Type']?.startsWith('text/html') })

  const files = http.batch(page.files.map((path) => ['GET', `${base}${path}`, null, { headers: { 'sec-fetch-dest': dest(path) }, tags: tags('file') }]))
  check(files, { 'files 200': (rs) => rs.every((r) => r.status === 200) })

  sleep(THINK)
}
