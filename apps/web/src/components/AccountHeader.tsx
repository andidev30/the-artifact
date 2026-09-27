import { NavLink } from 'react-router'
import type { Me } from '../api'
import { useConfig } from '../useConfig'
import { AccountMenu } from './AccountMenu'
import './AccountHeader.css'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { Wordmark } from './Wordmark'

type Props = {
  me: Me
  // Label for the workspace chip. Once onboarding is done the chip becomes a switcher.
  workspace?: string
}

export function AccountHeader({ me, workspace }: Props) {
  const instanceName = useConfig()?.instanceName

  return (
    <header className="nav">
      <div className="nav-start">
        <Wordmark />
        {instanceName && <span className="instance-name">{instanceName}</span>}
        {workspace && (me.onboarded ? <WorkspaceSwitcher me={me} /> : <span className="workspace-chip">{workspace}</span>)}
      </div>
      <div className="app-account">
        <NavLink className="app-account-link" to="/docs">
          Docs
        </NavLink>
        <AccountMenu me={me} />
      </div>
    </header>
  )
}
