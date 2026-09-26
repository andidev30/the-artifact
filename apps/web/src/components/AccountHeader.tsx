import { useNavigate } from 'react-router'
import { logout, type Me } from '../api'
import { Wordmark } from './Wordmark'

type Props = {
  me: Me
  workspace?: string
}

export function AccountHeader({ me, workspace }: Props) {
  const navigate = useNavigate()

  async function onLogout() {
    await logout()
    navigate('/', { replace: true })
  }

  return (
    <header className="nav">
      <div className="nav-start">
        <Wordmark />
        {workspace && <span className="workspace-chip">{workspace}</span>}
      </div>
      <div className="app-account">
        {me.avatarUrl && <img src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />}
        <span>{me.name ?? me.email}</span>
        <button type="button" className="auth-reset" onClick={onLogout}>Log out</button>
      </div>
    </header>
  )
}
