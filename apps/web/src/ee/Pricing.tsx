import { useState } from 'react'
import { Link } from 'react-router'
import { CONTACT_SALES_URL, SELF_HOSTING_URL, SIGNUP_URL } from '../config'

type Plan = {
  name: string
  price: string
  per: string
  summary: string
  features: string[]
  cta: string
  href: string
  featured?: boolean
  // Shown but not available yet: the card says so and its button is disabled
  comingSoon?: boolean
}

// The Personal plan's page and history limits are placeholders; change them here once they are decided
const CLOUD_PLANS: Plan[] = [
  {
    name: 'Personal',
    price: '$0',
    per: 'forever',
    summary: 'For your own reports, prototypes and experiments.',
    features: ['Publish from Claude Code, Cursor, Codex or any MCP client', 'Share any page by link', 'Up to 50 pages', 'Version history for 7 days'],
    cta: 'Get started free',
    href: SIGNUP_URL,
    comingSoon: true,
  },
  {
    name: 'Organization',
    price: '$4',
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
    comingSoon: true,
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
    comingSoon: true,
  },
]

const SELF_HOSTED_PLANS: Plan[] = [
  {
    name: 'Self-hosted',
    price: '$0',
    per: 'free, on your own servers',
    summary: 'Run The Artifact yourself, with your own database and your own data.',
    features: [
      'Every feature: organizations, sharing, version history',
      'Unlimited pages and members',
      'One Docker image plus Postgres',
      'Email through your SMTP server and Google sign-in, both optional',
      'Pages and data never leave your network',
    ],
    cta: 'Read the install guide',
    href: SELF_HOSTING_URL,
    featured: true,
  },
  {
    name: 'Self-hosted Enterprise',
    price: 'Custom',
    per: 'yearly contract',
    summary: 'For companies with strict security reviews or closed networks.',
    features: [
      'Everything in Self-hosted',
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
  'self-hosted': 'Free to run on your own servers. Talk to us when your company needs SSO, audit logs or support.',
  cloud: 'We host it for you. The cloud version is coming soon; until then, self-host it for free.',
}

export function Pricing() {
  const [hosting, setHosting] = useState<Hosting>('self-hosted')
  const plans = hosting === 'self-hosted' ? SELF_HOSTED_PLANS : CLOUD_PLANS

  return (
    <>
      <p className="section-lede">{LEDE[hosting]}</p>
      <div className="hosting-toggle" role="radiogroup" aria-label="Where The Artifact runs">
        {(['self-hosted', 'cloud'] as const).map((h) => (
          <button key={h} type="button" role="radio" aria-checked={hosting === h} onClick={() => setHosting(h)}>
            {h === 'cloud' ? 'Cloud' : 'Self-hosted'}
          </button>
        ))}
      </div>
      <div className="plans" data-count={plans.length}>
        {plans.map((plan) => (
          <article
            key={plan.name}
            className={plan.featured && !plan.comingSoon ? 'plan plan-featured' : 'plan'}
            data-coming-soon={plan.comingSoon || undefined}
          >
            <h3>
              {plan.name}
              {plan.comingSoon && <span className="plan-soon">Coming soon</span>}
            </h3>
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
            {plan.comingSoon ? (
              <span className="button button-quiet button-disabled" aria-disabled="true">
                Coming soon
              </span>
            ) : (
              <Link className={plan.featured ? 'button' : 'button button-quiet'} to={plan.href}>
                {plan.cta}
              </Link>
            )}
          </article>
        ))}
      </div>
    </>
  )
}
