// Scenario 3: the gallery of an organization with thousands of pages. A visit loads the first page of
// cards with the folder list and the cards' thumbnails, then scrolls on through X-Next-Cursor; some
// visits search by title or open a folder instead. Visitors are the organization's plain members, so
// the listing also has to leave out other people's private pages.
import { check, sleep } from 'k6'
import http from 'k6/http'
import { BASE_URL, DURATION, loadSeed, pick, THINK, VUS } from '../lib/config.js'

const seed = loadSeed()
const LIMIT = Number(__ENV.LIMIT || 50)
// Pages of cards scrolled through after the first; "all" walks the whole workspace
const SCROLL = __ENV.SCROLL === 'all' ? Infinity : Number(__ENV.SCROLL ?? 4)
const SEARCH_SHARE = Number(__ENV.SEARCH_SHARE ?? 0.2)
const FOLDER_SHARE = Number(__ENV.FOLDER_SHARE ?? 0.2)
const WITH_THUMBNAILS = __ENV.WITH_THUMBNAILS !== 'false'

export const options = {
  scenarios: { gallery: { executor: 'constant-vus', vus: VUS, duration: DURATION } },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{step:first}': ['p(95)<500'],
    'http_req_duration{step:scroll}': ['p(95)<400'],
    'http_req_duration{step:search}': ['p(95)<800'],
    'http_req_duration{step:folder}': ['p(95)<500'],
    'http_req_duration{step:folders}': ['p(95)<300'],
    'http_req_duration{step:thumbnail}': ['p(95)<200'],
  },
}

const members = seed.users.slice(1)
const workspace = encodeURIComponent(seed.gallery.organizationId)

function thumbnails(cookie, cards) {
  if (!WITH_THUMBNAILS) return
  const ready = cards.filter((c) => c.thumbnailState === 'ready')
  const res = http.batch(
    ready.map((c) => ['GET', `${BASE_URL}/api/artifacts/${c.slug}/thumbnails/${c.version}`, null, { headers: { cookie }, tags: { step: 'thumbnail' } }]),
  )
  check(res, { 'thumbnails 200': (rs) => rs.every((r) => r.status === 200) })
}

export default function () {
  const { cookie } = members[(__VU - 1) % members.length]
  const roll = Math.random()
  let filter = ''
  let step = 'first'
  if (roll < SEARCH_SHARE) {
    filter = `&q=${encodeURIComponent(pick(seed.gallery.searchTerms))}`
    step = 'search'
  } else if (roll < SEARCH_SHARE + FOLDER_SHARE && seed.gallery.folders.length) {
    filter = `&folder=${pick(seed.gallery.folders).id}`
    step = 'folder'
  }

  const [folders, first] = http.batch([
    ['GET', `${BASE_URL}/api/folders?workspace=${workspace}`, null, { headers: { cookie }, tags: { step: 'folders' } }],
    ['GET', `${BASE_URL}/api/artifacts?workspace=${workspace}&limit=${LIMIT}${filter}`, null, { headers: { cookie }, tags: { step } }],
  ])
  check(folders, { 'folders 200': (r) => r.status === 200 })
  check(first, { 'gallery 200': (r) => r.status === 200, 'total counted': (r) => r.headers['X-Total-Count'] !== undefined })
  if (first.status !== 200) return
  thumbnails(cookie, first.json())

  let cursor = first.headers['X-Next-Cursor']
  for (let n = 0; cursor && n < SCROLL; n++) {
    sleep(THINK)
    const next = http.get(`${BASE_URL}/api/artifacts?workspace=${workspace}&limit=${LIMIT}${filter}&cursor=${encodeURIComponent(cursor)}`, {
      headers: { cookie },
      tags: { step: 'scroll' },
    })
    check(next, { 'next page 200': (r) => r.status === 200 })
    if (next.status !== 200) return
    thumbnails(cookie, next.json())
    cursor = next.headers['X-Next-Cursor']
  }
  sleep(THINK)
}
