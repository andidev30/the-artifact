// Enterprise single sign-on on the sign-in page: one button per connection the instance admin turned
// on. The API lists none without a license, so nothing shows then.

export type SsoButton = { id: string; name: string }

// Errors the API sends back to /login?error=… from an SSO sign-in
export const SSO_ERRORS: Record<string, string> = {
  sso_failed: 'Single sign-on did not work. Try again, or ask an admin of this server.',
  sso_cancelled: 'Single sign-on was cancelled. Try again.',
  sso_unavailable: 'That single sign-on isn’t available any more. Sign in another way, or ask an admin of this server.',
  sso_unverified: 'Your identity provider hasn’t verified your email address, so it can’t sign you in here. Ask your IT team.',
  sso_no_email: 'Your identity provider didn’t share your email address, so it can’t sign you in here. Ask your IT team.',
  sso_domain: 'Your email address isn’t one this server accepts through single sign-on. Ask an admin of this server.',
  sso_required: 'Your organization signs in through single sign-on. Use the single sign-on button below.',
}

export function SsoButtons({ connections, query }: { connections: SsoButton[]; query: string }) {
  return (
    <>
      {connections.map((c) => (
        <a key={c.id} className="button button-quiet auth-provider" href={`/api/auth/sso/${encodeURIComponent(c.id)}?${query}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="10" width="18" height="11" rx="2" />
            <path d="M7 10V7a5 5 0 0 1 10 0v3" />
            <circle cx="12" cy="15.5" r="1.5" />
          </svg>
          Continue with {c.name}
        </a>
      ))}
    </>
  )
}
