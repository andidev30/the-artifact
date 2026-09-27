import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { AccountHeader } from '../components/AccountHeader'
import { useMe } from '../useMe'
import { chooseWorkspace, organizationSettingsPath, useWorkspace } from '../workspace'
import type { Me } from '../api'
import { OrganizationStep } from './Onboarding'
import { LoadError, Loading } from './Status'
import './Workspace.css'

// Creating another organization after onboarding, from the workspace switcher
export function NewOrganization() {
  const state = useMe()

  useEffect(() => {
    document.title = 'New organization | The Artifact'
    return () => { document.title = 'The Artifact' }
  }, [])

  if (state.kind === 'loading') return <Loading />
  if (state.kind === 'error') return <LoadError />
  return <Page me={state.me} />
}

function Page({ me }: { me: Me }) {
  const navigate = useNavigate()
  const { name } = useWorkspace(me)

  return (
    <div className="auth">
      <AccountHeader me={me} workspace={name} />
      <main id="main" className="onboarding">
        <ol className="onboarding-rail" aria-label="Steps">
          <li data-state="current" aria-current="step"><span>Name your organization</span></li>
          <li data-state="todo"><span>Invite your team</span></li>
        </ol>
        <div className="onboarding-panel">
          <OrganizationStep
            title="Create an organization"
            lede="A shared gallery for your team. You become its owner and can invite people next."
            onBack={() => navigate('/app')}
            onDone={(org) => {
              chooseWorkspace(org.id)
              navigate(`${organizationSettingsPath(org)}#members`)
            }}
          />
        </div>
      </main>
    </div>
  )
}
