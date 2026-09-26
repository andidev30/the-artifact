import { NavLink, useNavigate } from 'react-router'
import { logout, type Me } from '../api'
import './AccountHeader.css'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { Wordmark } from './Wordmark'

type Props = {
  me: Me
  // Label for the workspace chip. Once onboarding is done the chip becomes a switcher.
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
        {workspace && (me.onboarded ? <WorkspaceSwitcher me={me} /> : <span className="workspace-chip">{workspace}</span>)}
      </div>
      <div className="app-account">
        {me.avatarUrl && <img src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />}
        <span>{me.name ?? me.email}</span>
        {me.onboarded && <NavLink className="app-account-link" to="/settings">Settings</NavLink>}
        <button type="button" className="auth-reset" onClick={onLogout}>Log out</button>
      </div>
    </header>
  )
}
