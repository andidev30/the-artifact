import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashToken } from '../../src/auth/session.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sendSignInLink } from '../../src/mail.js'
import { call, createOrg, createPage, createUser } from './helpers.js'

const sendMock = vi.mocked(sendSignInLink)

describe('config for the web app', () => {
  it('tells the web app about this install', async () => {
    const res = await call('/api/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ selfHosted: false, googleSignIn: false, emailSignIn: true, needsSetup: false, passwordSignUp: false, instanceName: null })
  })
})

