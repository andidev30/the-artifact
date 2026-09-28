import type { Profile } from '@node-saml/node-saml'
import { describe, expect, it } from 'vitest'
import { mapProfile } from '../../src/ee/sso/saml.js'

const profile = (p: Partial<Profile>) => ({ issuer: 'idp', nameID: 'x', nameIDFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', ...p }) as Profile
const none = { emailAttribute: null, nameAttribute: null }

describe('SAML attribute mapping', () => {
  it('reads Entra ID’s claim names', () => {
    const p = profile({
      attributes: {
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'Jane@Contoso.example',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'Jane',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname': 'Doe',
        'http://schemas.microsoft.com/identity/claims/displayname': 'Jane Doe (IT)',
      },
    })
    expect(mapProfile(p, none)).toEqual({ email: 'jane@contoso.example', name: 'Jane Doe (IT)' })
  })

  it('reads Okta’s and Google’s attribute statements, joining first and last name', () => {
    expect(mapProfile(profile({ attributes: { email: 'a@acme.example', firstName: 'Ann', lastName: 'Lee' } }), none)).toEqual({
      email: 'a@acme.example',
      name: 'Ann Lee',
    })
  })

  it('falls back to an email NameID', () => {
    const p = profile({ nameID: 'b@acme.example', nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' })
    expect(mapProfile(p, none)).toEqual({ email: 'b@acme.example', name: null })
  })

  it('uses only the attributes the admin named', () => {
    const p = profile({ nameID: 'b@acme.example', attributes: { email: 'a@acme.example', work_mail: ['c@acme.example', 'd@acme.example'], full: 'C' } })
    expect(mapProfile(p, { emailAttribute: 'work_mail', nameAttribute: 'full' })).toEqual({ email: 'c@acme.example', name: 'C' })
    expect(mapProfile(p, { emailAttribute: 'missing', nameAttribute: null }).email).toBeNull()
  })

  it('rejects values that are not email addresses', () => {
    expect(mapProfile(profile({ attributes: { email: 'not an address' } }), none).email).toBeNull()
  })
})
