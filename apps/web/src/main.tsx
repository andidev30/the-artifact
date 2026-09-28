import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
// Served from this server with the app, so opening it contacts no font host
import '@fontsource/schibsted-grotesk/400.css'
import '@fontsource/schibsted-grotesk/500.css'
import '@fontsource/schibsted-grotesk/700.css'
import '@fontsource/schibsted-grotesk/800.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './index.css'
import './App.css'
import { AppHome } from './pages/AppHome.tsx'
import { Auth } from './pages/Auth.tsx'
import { Authorize } from './pages/Authorize.tsx'
import { ContactSalesPage, Home, HostedInsights, LegalPage } from './pages/Home.tsx'
import { NotFound } from './pages/NotFound.tsx'
import { Onboarding } from './pages/Onboarding.tsx'
import { Viewer } from './pages/Viewer.tsx'
import { Invite } from './pages/Invite.tsx'
import { NewOrganization } from './pages/NewOrganization.tsx'
import { ConfirmSignIn } from './pages/ConfirmSignIn.tsx'
import { Loading } from './pages/Status.tsx'
import { TwoFactor } from './pages/TwoFactor.tsx'
import { FocusRescue, RouteFocus, SkipLink } from './components/Focus.tsx'

// Pages most visits never open stay out of the first download. The signed-in ones show Loading
// while their chunk arrives, which is what they render first anyway, so nothing changes on screen.
const Admin = lazy(() => import('./pages/Admin.tsx').then((m) => ({ default: m.Admin })))
const Settings = lazy(() => import('./pages/Settings.tsx').then((m) => ({ default: m.Settings })))
const OrganizationSettings = lazy(() => import('./pages/OrganizationSettings.tsx').then((m) => ({ default: m.OrganizationSettings })))
// Docs carries marked and every docs/*.md file
const Docs = lazy(() => import('./pages/Docs.tsx').then((m) => ({ default: m.Docs })))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SkipLink />
      <RouteFocus />
      <FocusRescue />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Auth mode="login" />} />
        <Route path="/signup" element={<Auth mode="signup" />} />
        <Route path="/login/two-factor" element={<TwoFactor />} />
        <Route path="/contact-sales" element={<ContactSalesPage />} />
        <Route path="/legal/:doc" element={<LegalPage />} />
        <Route path="/auth/confirm" element={<ConfirmSignIn />} />
        <Route path="/app" element={<AppHome />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/authorize" element={<Authorize />} />
        <Route path="/a/:slug" element={<Viewer />} />
        <Route
          path="/settings"
          element={
            <Suspense fallback={<Loading />}>
              <Settings />
            </Suspense>
          }
        />
        <Route
          path="/admin"
          element={
            <Suspense fallback={<Loading />}>
              <Admin />
            </Suspense>
          }
        />
        <Route path="/organizations/new" element={<NewOrganization />} />
        <Route
          path="/organizations/:slug/settings"
          element={
            <Suspense fallback={<Loading />}>
              <OrganizationSettings />
            </Suspense>
          }
        />
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="/docs" element={<Navigate to="/docs/introduction" replace />} />
        <Route
          path="/docs/:slug"
          element={
            <Suspense fallback={null}>
              <Docs />
            </Suspense>
          }
        />
        <Route path="/self-hosting" element={<Navigate to="/docs/self-hosting" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
    <HostedInsights />
  </StrictMode>,
)
