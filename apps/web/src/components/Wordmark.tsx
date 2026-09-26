import { Link } from 'react-router'

export function Wordmark() {
  return (
    <Link className="wordmark" to="/">
      <span className="wordmark-mark" aria-hidden="true" />
      the artifact
    </Link>
  )
}
