// Scenario 2: agents publishing through MCP with large HTML and many files. Every publish goes through
// publish_artifact inline (the whole page in the JSON-RPC body), the way agents publish when the
// server has no S3_PUBLIC_ENDPOINT. Half of them add a version to the page the agent published
// before, as agents do while they iterate on a page.
import { check, sleep } from 'k6'
import exec from 'k6/execution'
import { BASE_URL, DURATION, loadSeed, THINK, VUS } from '../lib/config.js'
import { makeSite, unique } from '../lib/content.js'
import { callTool, slugFrom } from '../lib/mcp.js'

const seed = loadSeed()
const HTML_KB = Number(__ENV.HTML_KB || 500)
const FILES = Number(__ENV.FILES || 20)
const FILE_KB = Number(__ENV.FILE_KB || 100)
const NEW_VERSION_SHARE = Number(__ENV.NEW_VERSION_SHARE ?? 0.5)
// true makes every text file new on every publish too; by default only the HTML changes
const UNIQUE_FILES = __ENV.UNIQUE_FILES === 'true'
// personal or organization: which workspace the agents are connected to
const WORKSPACE = __ENV.WORKSPACE || 'organization'

export const options = {
  scenarios: { publish: { executor: 'constant-vus', vus: VUS, duration: DURATION } },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{step:publish}': ['p(95)<5000'],
  },
}

// Built once per VU while the script loads, so iterations only pay for sending it
const site = makeSite({ htmlKb: HTML_KB, files: FILES, fileKb: FILE_KB, title: 'Load test page' })
let mine = null

export function setup() {
  console.log(`Publishing ${HTML_KB} KB of HTML and ${FILES} files of ${FILE_KB} KB to ${BASE_URL}/mcp`)
}

export default function () {
  const user = seed.users[(__VU - 1) % seed.users.length]
  const token = WORKSPACE === 'personal' ? user.token : user.orgToken
  const content = unique(site, `${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Date.now()}`, UNIQUE_FILES)
  const again = mine && Math.random() < NEW_VERSION_SHARE
  const { res, text, ok } = callTool(
    token,
    'publish_artifact',
    {
      title: `Load test ${exec.vu.idInTest}`,
      ...content,
      ...(again ? { artifact_id: mine } : {}),
      folder: `k6 ${exec.vu.idInTest % 5}`,
    },
    { step: 'publish', kind: again ? 'version' : 'page' },
  )
  check(res, { 'publish 200': (r) => r.status === 200 })
  if (!check(text, { 'published, not refused': () => ok && Boolean(slugFrom(text)) })) console.warn(text.slice(0, 300))
  mine = slugFrom(text) ?? mine
  sleep(THINK)
}
