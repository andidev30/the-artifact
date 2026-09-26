import { useState } from 'react'
import { Link } from 'react-router'
import { CONTACT_SALES_URL, SIGNUP_URL } from '../config'

type Plan = {
  name: string
  price: string
  per: string
  summary: string
  features: string[]
  cta: string
  href: string
  featured?: boolean
}

// Placeholder prices and limits; change here once they are decided
const CLOUD_PLANS: Plan[] = [
  {
    name: 'Personal',
    price: '$0',
    per: 'forever',
    summary: 'For your own reports, prototypes and experiments.',
    features: [
      'Publish from Claude Code, Cursor, Codex or any MCP client',
      'Share any page by link',
      'Up to 50 pages',
      'Version history for 7 days',
    ],
    cta: 'Get started free',
    href: SIGNUP_URL,
  },
  {
    name: 'Organization',
    price: '$12',
    per: 'per member / month',
    summary: 'For teams that share what their agents build.',
    features: [
      'Everything in Personal',
      'A shared gallery for the whole team',
      'Pages only your organization can open',
      'Unlimited pages and full version history',
      'Manage members and roles',
    ],
    cta: 'Start with your team',
    href: `${SIGNUP_URL}?plan=organization`,
    featured: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    per: 'yearly contract',
    summary: 'For companies with security reviews and many teams.',
    features: [
      'Everything in Organization',
      'SSO with SAML and user provisioning with SCIM',
      'Audit log of every publish and share',
      'Custom data retention',
      'Invoice billing and a dedicated contact',
    ],
    cta: 'Contact sales',
    href: CONTACT_SALES_URL,
  },
]

const SELF_HOSTED_PLANS: Plan[] = [
  {
    name: 'Self-hosted Team',
    price: '$20',
    per: 'per member / month, billed yearly',
    summary: 'Run The Artifact on your own servers, with your own data.',
    features: [
      'Everything in Organization',
      'Ships as a Docker image for your servers or Kubernetes',
      'Uses your Postgres, your SMTP and your Google sign-in',
      'Pages and data never leave your network',
      'Update on your schedule, with release notes',
    ],
    cta: 'Get a license',
    href: `${CONTACT_SALES_URL}?topic=self-hosted-team`,
    featured: true,
  },
  {
    name: 'Self-hosted Enterprise',
    price: 'Custom',
    per: 'yearly contract',
    summary: 'For companies with strict security reviews or closed networks.',
    features: [
      'Everything in Self-hosted Team',
      'SSO with SAML and user provisioning with SCIM',
      'Audit log of every publish and share',
      'Air-gapped install with an offline license',
      'Priority support with an agreed response time',
    ],
    cta: 'Contact sales',
    href: `${CONTACT_SALES_URL}?topic=self-hosted-enterprise`,
  },
]

type Hosting = 'cloud' | 'self-hosted'

const LEDE: Record<Hosting, string> = {
  cloud: 'Free for your own work. Pay when your team shares a workspace. Talk to us when your company needs SSO and audit logs.',
  'self-hosted': 'The same product, running inside your own infrastructure. Licensed yearly, per member.',
}

export function Pricing() {
  const [hosting, setHosting] = useState<Hosting>('cloud')
  const plans = hosting === 'cloud' ? CLOUD_PLANS : SELF_HOSTED_PLANS

  return (
    <>
      <p className="section-lede">{LEDE[hosting]}</p>
      <div className="hosting-toggle" role="radiogroup" aria-label="Where The Artifact runs">
        {(['cloud', 'self-hosted'] as const).map((h) => (
          <button
            key={h}
            type="button"
            role="radio"
            aria-checked={hosting === h}
            onClick={() => setHosting(h)}
          >
            {h === 'cloud' ? 'Cloud' : 'Self-hosted'}
          </button>
        ))}
      </div>
      <div className="plans" data-count={plans.length}>
        {plans.map((plan) => (
          <article key={plan.name} className={plan.featured ? 'plan plan-featured' : 'plan'}>
            <h3>{plan.name}</h3>
            <p className={plan.price.startsWith('$') ? 'plan-price' : 'plan-price plan-price-text'}>
              <span>{plan.price}</span>
              {plan.per}
            </p>
            <p className="plan-summary">{plan.summary}</p>
            <ul>
              {plan.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <Link className={plan.featured ? 'button' : 'button button-quiet'} to={plan.href}>
              {plan.cta}
            </Link>
          </article>
        ))}
      </div>
    </>
  )
}
