import { describe, expect, it, vi } from 'vitest'
import { sendSalesInquiry } from '../../src/mail.js'
import { call } from './helpers.js'

const sendMock = vi.mocked(sendSalesInquiry)

let n = 0
function form(extra: Record<string, unknown> = {}) {
  n += 1
  return {
    name: 'Dana Lee',
    email: `dana${n}@acme.example`,
    company: 'Acme Inc',
    teamSize: '51-200',
    message: 'We would like to run The Artifact on our own servers with SSO.',
    ...extra,
  }
}

describe('contact sales', () => {
  it('emails the inquiry with the fields trimmed and the address lowercased', async () => {
    const res = await call('/api/contact-sales', { json: form({ name: '  Dana Lee ', email: ' Dana.Lee@Acme.Example ', topic: 'self-hosted-enterprise' }) })
    expect(res.status).toBe(204)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0]).toEqual({
      name: 'Dana Lee',
      email: 'dana.lee@acme.example',
      company: 'Acme Inc',
      teamSize: '51-200',
      topic: 'Self-hosted Enterprise',
      message: 'We would like to run The Artifact on our own servers with SSO.',
    })
  })

  it('needs no account, and an unknown topic falls back to Enterprise', async () => {
    const res = await call('/api/contact-sales', { json: form({ topic: 'something-else' }) })
    expect(res.status).toBe(204)
    expect(sendMock.mock.calls[0][0].topic).toBe('Enterprise')
  })

  it.each([
    ['name', { name: '' }],
    ['name', { name: 'x'.repeat(101) }],
    ['name', { name: 'Dana\r\nBcc: someone@example.com' }],
    ['email', { email: 'not-an-email' }],
    ['email', { email: 'dana@acme' }],
    ['email', { email: 42 }],
    ['company', { company: '   ' }],
    ['company', { company: 'x'.repeat(121) }],
    ['teamSize', { teamSize: 'lots' }],
    ['teamSize', { teamSize: undefined }],
    ['message', { message: 'hi' }],
    ['message', { message: 'x'.repeat(5001) }],
  ])('refuses a bad %s', async (field, extra) => {
    const res = await call('/api/contact-sales', { json: form(extra) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; field: string }
    expect(body.field).toBe(field)
    expect(body.error).toBeTruthy()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON', async () => {
    const res = await call('/api/contact-sales', { method: 'POST', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('answers a filled-in honeypot like a success but sends nothing', async () => {
    const res = await call('/api/contact-sales', { json: form({ website: 'http://spam.example' }) })
    expect(res.status).toBe(204)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('limits how many messages one address can send', async () => {
    const body = form()
    for (let i = 0; i < 3; i++) expect((await call('/api/contact-sales', { json: body })).status).toBe(204)
    const res = await call('/api/contact-sales', { json: body })
    expect(res.status).toBe(429)
    expect(sendMock).toHaveBeenCalledTimes(3)
    // Someone else is not affected
    expect((await call('/api/contact-sales', { json: form() })).status).toBe(204)
  })

  it('reports a mail failure', async () => {
    sendMock.mockRejectedValueOnce(new Error('SMTP down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('/api/contact-sales', { json: form() })
    spy.mockRestore()
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toMatch(/could not be sent/)
  })
})
