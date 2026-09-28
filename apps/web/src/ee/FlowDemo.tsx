import { useEffect, useState } from 'react'
import { APP_HOST } from '../config'

const PROMPT = 'make a page showing API latency for the last 7 days'
const URL = `${APP_HOST}/a/latency-7d`
const BARS = [42, 38, 61, 47, 90, 52, 44]
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

// Each replay runs the same request through a different agent
const AGENTS = [
  { name: 'Claude Code', tool: 'the-artifact - publish_artifact (MCP)' },
  { name: 'Cursor', tool: 'Called MCP tool publish_artifact' },
  { name: 'Codex', tool: 'Called the-artifact.publish_artifact' },
]

// Steps: 1 typing prompt, 2 tool call, 3 link returned, 4 page rendered, 5 opened by a person
const TIMELINE = [700, 2900, 4100, 5000, 6300]

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function FlowDemo() {
  const [reduced] = useState(prefersReducedMotion)
  const [run, setRun] = useState(0)
  const [step, setStep] = useState(reduced ? 5 : 0)
  const [typed, setTyped] = useState(reduced ? PROMPT.length : 0)
  const agent = AGENTS[run % AGENTS.length]
  const nextAgent = AGENTS[(run + 1) % AGENTS.length]

  // biome-ignore lint/correctness/useExhaustiveDependencies: each replay starts the timeline over
  useEffect(() => {
    if (reduced) return

    const timers = TIMELINE.map((at, i) => setTimeout(() => setStep(i + 1), at))

    const typeStart = TIMELINE[0]
    const perChar = (TIMELINE[1] - typeStart - 300) / PROMPT.length
    for (let i = 1; i <= PROMPT.length; i++) {
      timers.push(setTimeout(() => setTyped(i), typeStart + i * perChar))
    }

    return () => timers.forEach(clearTimeout)
  }, [run, reduced])

  function replay() {
    if (reduced) {
      setRun((r) => r + 1)
      return
    }
    setStep(0)
    setTyped(0)
    setRun((r) => r + 1)
  }

  return (
    <figure className="flow" data-step={step}>
      <div className="flow-grid">
        <div className="box terminal" role="group" aria-label={`${agent.name} session`}>
          <div className="box-title">{agent.name}</div>
          <div className="terminal-body">
            <p className="line line-prompt">
              <span className="caret" aria-hidden="true">
                &gt;
              </span>
              {PROMPT.slice(0, typed)}
              {step <= 1 && <span className="cursor" aria-hidden="true" />}
            </p>
            <p className="line line-tool">
              <span className="dot" aria-hidden="true" />
              {agent.tool}
            </p>
            <p className="line line-result">
              Published. <mark>{URL}</mark>
            </p>
          </div>
        </div>

        <div className="wire wire-a" aria-hidden="true" />

        <div className="node" role="group" aria-label="publish_artifact tool call">
          <span>
            Write
            <br />
            page
          </span>
        </div>

        <div className="wire wire-b" aria-hidden="true">
          <span className="wire-label">Upload file</span>
        </div>

        <div className="box browser" role="group" aria-label="Published page in a browser">
          <div className="browser-bar">
            <span className="browser-url">{step >= 3 ? URL : ''}</span>
          </div>
          <div className="page">
            <p className="page-heading">API latency, last 7 days</p>
            <p>p95 in milliseconds. Friday's spike lines up with the cache deploy.</p>
            <svg viewBox="0 0 140 70" role="img" aria-label="Bar chart of daily p95 latency, peaking on Friday at 90 ms">
              {BARS.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of bars that never reorders
                <g key={i}>
                  <rect
                    className={i === 4 ? 'bar bar-peak' : 'bar'}
                    x={i * 20 + 4}
                    y={60 - h * 0.6}
                    width="12"
                    height={h * 0.6}
                    rx="1.5"
                    style={{ transitionDelay: `${i * 60}ms` }}
                  />
                  <text x={i * 20 + 10} y="69" textAnchor="middle">
                    {DAYS[i]}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <div className="viewer">
            <svg viewBox="0 0 20 30" aria-hidden="true">
              <circle cx="10" cy="5" r="4" />
              <path d="M10 9v10M3 13h14M10 19l-6 9M10 19l6 9" />
            </svg>
            <span>Opened by Dita</span>
          </div>
        </div>
      </div>

      <figcaption>
        <span>{agent.name} writes the page, publishes it over MCP, and hands back a link.</span>
        <button type="button" className="replay" onClick={replay} disabled={step < 5}>
          Play with {nextAgent.name}
        </button>
      </figcaption>
    </figure>
  )
}
