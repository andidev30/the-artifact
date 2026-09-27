import http from 'k6/http'
import { BASE_URL } from './config.js'

let rpcId = 0

// One stateless tools/call, the way a 2025-era MCP client sends it: no initialize handshake is needed
// because the server builds a fresh MCP server for every request (apps/api/src/mcp.ts)
export function callTool(token, name, args, tags = {}) {
  rpcId += 1
  const res = http.post(`${BASE_URL}/mcp`, JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } }), {
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    tags,
    timeout: '120s',
  })
  let result = null
  try {
    result = res.json('result')
  } catch {
    // Not JSON: a proxy error page or a timeout; the status check reports it
  }
  const text = result?.content?.map((c) => c.text).join('\n') ?? ''
  return { res, text, ok: res.status === 200 && Boolean(result) && !result.isError }
}

export const slugFrom = (text) => text.match(/artifact_id: ([a-z0-9]+)/)?.[1] ?? null
