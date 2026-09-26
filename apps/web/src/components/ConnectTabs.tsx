import { useRef, useState, type KeyboardEvent } from 'react'
import { MCP_URL } from '../config'
import { CopyCommand } from './CopyCommand'

type Agent = {
  id: string
  name: string
  note: string
  command: string
  file?: string
}

const AGENTS: Agent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    note: 'Run once in your terminal, then run /mcp inside Claude Code and choose Authenticate to sign in.',
    command: `claude mcp add --transport http --scope user the-artifact ${MCP_URL}`,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    note: 'Add to ~/.cursor/mcp.json for every project, or .cursor/mcp.json for one. Cursor asks you to sign in when it first connects.',
    file: 'mcp.json',
    command: `{
  "mcpServers": {
    "the-artifact": {
      "url": "${MCP_URL}"
    }
  }
}`,
  },
  {
    id: 'codex',
    name: 'Codex',
    note: 'Add to your Codex config, then run codex mcp login the-artifact to sign in and restart Codex.',
    file: '~/.codex/config.toml',
    command: `[mcp_servers.the-artifact]
url = "${MCP_URL}"`,
  },
  {
    id: 'other',
    name: 'Other MCP clients',
    note: 'Any client that speaks MCP over streamable HTTP can connect with this URL.',
    command: MCP_URL,
  },
]

export function ConnectTabs() {
  const [active, setActive] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const agent = AGENTS[active]

  function onKeyDown(e: KeyboardEvent) {
    const last = AGENTS.length - 1
    const next =
      e.key === 'ArrowRight' ? (active === last ? 0 : active + 1)
      : e.key === 'ArrowLeft' ? (active === 0 ? last : active - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null) return
    e.preventDefault()
    setActive(next)
    tabs.current[next]?.focus()
  }

  return (
    <div className="connect">
      <div className="connect-tabs" role="tablist" aria-label="Choose your agent" onKeyDown={onKeyDown}>
        {AGENTS.map((a, i) => (
          <button
            key={a.id}
            ref={(el) => { tabs.current[i] = el }}
            type="button"
            role="tab"
            id={`tab-${a.id}`}
            aria-selected={i === active}
            aria-controls={`panel-${a.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
          >
            {a.name}
          </button>
        ))}
      </div>
      <div className="connect-panel" role="tabpanel" id={`panel-${agent.id}`} aria-labelledby={`tab-${agent.id}`}>
        {agent.id === 'other' ? (
          <CopyCommand command={agent.command} file="Server URL" label="Copy the server URL" />
        ) : (
          <CopyCommand command={agent.command} file={agent.file} label={`Copy the ${agent.name} setup`} />
        )}
        <p>{agent.note}</p>
      </div>
    </div>
  )
}
