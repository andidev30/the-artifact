import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendCommentNotice, sendInvitation, sendShareNotice, sendSignInLink, transport, transportOptions } from '../../src/mail.js'

// A plain string would be parsed by nodemailer as an address list: "x<victim@example.com>" goes to
// victim@example.com, and a comma adds a second recipient. Every send passes one mailbox as given.
describe('outgoing mail', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['sign-in link', (to: string) => sendSignInLink(to, 'http://localhost/link', 'login')],
    ['share notice', (to: string) => sendShareNotice(to, { from: 'Ana', title: 'T', link: 'http://localhost/a/x', role: 'viewer' })],
    ['comment notice', (to: string) => sendCommentNotice(to, { from: 'Ana', title: 'T', link: 'http://localhost/a/x', body: 'b', reply: false, version: 1 })],
    [
      'invitation',
      (to: string) => sendInvitation(to, { from: 'Ana', organization: 'Acme', role: 'member', link: 'http://localhost/invite/x', expiresInDays: 7 }),
    ],
  ])('the %s goes to the address as one mailbox', async (_, send) => {
    const sendMail = vi.spyOn(transport, 'sendMail').mockResolvedValue({} as Awaited<ReturnType<typeof transport.sendMail>>)
    await send('x<victim@example.com>')
    expect(sendMail).toHaveBeenCalledOnce()
    expect(sendMail.mock.calls[0][0].to).toEqual({ name: '', address: 'x<victim@example.com>' })
  })
})

describe('SMTP connection', () => {
  const smtp = { host: 'smtp.example.com', port: 587, secure: false, requireTls: true, user: '', pass: '' }

  it('requires STARTTLS by default, so nobody on the way can strip it', () => {
    expect(transportOptions(smtp)).toMatchObject({ host: 'smtp.example.com', secure: false, requireTLS: true, auth: undefined })
  })

  it.each(['localhost', 'LOCALHOST', 'mail.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]'])('lets %s, on this machine, go without it', (host) => {
    expect(transportOptions({ ...smtp, host }).requireTLS).toBe(false)
  })

  it('leaves it to implicit TLS, or to SMTP_REQUIRE_TLS=false', () => {
    expect(transportOptions({ ...smtp, port: 465, secure: true }).requireTLS).toBe(false)
    expect(transportOptions({ ...smtp, requireTls: false }).requireTLS).toBe(false)
    expect(transportOptions({ ...smtp, host: '127.example.com' }).requireTLS).toBe(true)
  })

  it('signs in when a user is set', () => {
    expect(transportOptions({ ...smtp, user: 'a', pass: 'b' }).auth).toEqual({ user: 'a', pass: 'b' })
  })
})
