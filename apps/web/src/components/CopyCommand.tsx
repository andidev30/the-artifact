import { useState } from 'react'

type Props = {
  command: string
  label?: string
  // A file path shows the snippet as file contents instead of a shell command
  file?: string
  // A link or other value to copy, shown without the shell prompt
  plain?: boolean
}

export function CopyCommand({ command, label = 'Copy command', file, plain }: Props) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  const button = (
    <button type="button" onClick={copy} aria-label={label}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )

  const status = (
    <span className="visually-hidden" role="status">
      {copied ? 'Copied to clipboard' : ''}
    </span>
  )

  if (file) {
    return (
      <div className="command command-file">
        <div className="command-file-bar">
          <span>{file}</span>
          {button}
        </div>
        <pre>
          <code>{command}</code>
        </pre>
        {status}
      </div>
    )
  }

  return (
    <div className="command">
      <code>
        {!plain && (
          <span className="command-prompt" aria-hidden="true">
            $
          </span>
        )}
        {command}
      </code>
      {button}
      {status}
    </div>
  )
}
