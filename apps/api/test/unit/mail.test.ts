import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendCommentNotice, sendInvitation, sendShareNotice, sendSignInLink, transport } from '../../src/mail.js'

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
