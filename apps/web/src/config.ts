// The public URL of the app. Set VITE_APP_URL to pin it; otherwise use the domain the page is served from.
export const APP_URL = (import.meta.env.VITE_APP_URL || window.location.origin).replace(/\/$/, '')
export const APP_HOST = new URL(APP_URL).host
export const MCP_URL = `${APP_URL}/mcp`

export const SIGNUP_URL = '/signup'
export const LOGIN_URL = '/login'
export const CONTACT_SALES_URL = '/contact-sales'

// Auth endpoints served by apps/api
export const AUTH_GOOGLE_URL = '/api/auth/google'
export const AUTH_EMAIL_URL = '/api/auth/email'
export const SELF_HOSTING_URL = '/self-hosting'
