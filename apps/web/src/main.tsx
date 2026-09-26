import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import './index.css'
import './App.css'
import { AppHome } from './pages/AppHome.tsx'
import { Auth } from './pages/Auth.tsx'
import { Authorize } from './pages/Authorize.tsx'
import { Docs } from './pages/Docs.tsx'
import { Landing } from './pages/Landing.tsx'
import { NotFound } from './pages/NotFound.tsx'
import { Onboarding } from './pages/Onboarding.tsx'
import { Viewer } from './pages/Viewer.tsx'
import { Invite } from './pages/Invite.tsx'
import { NewOrganization } from './pages/NewOrganization.tsx'
import { Settings } from './pages/Settings.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Auth mode="login" />} />
        <Route path="/signup" element={<Auth mode="signup" />} />
        <Route path="/app" element={<AppHome />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/authorize" element={<Authorize />} />
        <Route path="/a/:slug" element={<Viewer />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/organizations/new" element={<NewOrganization />} />
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="/docs" element={<Navigate to="/docs/introduction" replace />} />
        <Route path="/docs/:slug" element={<Docs />} />
        <Route path="/self-hosting" element={<Navigate to="/docs/self-hosting" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
