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
const PLANS: Plan[] = [
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

export function Pricing() {
  return (
    <div className="plans">
      {PLANS.map((plan) => (
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
          <a className={plan.featured ? 'button' : 'button button-quiet'} href={plan.href}>
            {plan.cta}
          </a>
        </article>
      ))}
    </div>
  )
}
