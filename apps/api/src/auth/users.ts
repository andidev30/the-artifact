import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { User } from '../db/schema.js'
import { env } from '../env.js'

type Profile = {
  email: string
  name?: string | null
  avatarUrl?: string | null
  googleSub?: string
}

// Signing in and signing up are the same step: find the account by Google id or email, or create it
export async function findOrCreateUser(profile: Profile): Promise<User> {
  const email = profile.email.toLowerCase()

  if (profile.googleSub) {
    const [bySub] = await db.select().from(schema.users).where(eq(schema.users.googleSub, profile.googleSub))
    if (bySub) return bySub
  }

  const [byEmail] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (byEmail) {
    if (profile.googleSub && !byEmail.googleSub) {
      const [linked] = await db
        .update(schema.users)
        .set({
          googleSub: profile.googleSub,
          name: byEmail.name ?? profile.name,
          avatarUrl: byEmail.avatarUrl ?? profile.avatarUrl,
        })
        .where(eq(schema.users.id, byEmail.id))
        .returning()
      return linked
    }
    return byEmail
  }

  const [created] = await db
    .insert(schema.users)
    .values({ email, name: profile.name, avatarUrl: profile.avatarUrl, googleSub: profile.googleSub })
    .returning()
  return created
}

const PLANS = new Set(['organization'])

export function afterSignInUrl(plan: string | null | undefined): string {
  const url = new URL('/app', env.appUrl)
  if (plan && PLANS.has(plan)) url.searchParams.set('plan', plan)
  return url.toString()
}

export function signInErrorUrl(error: string): string {
  const url = new URL('/login', env.appUrl)
  url.searchParams.set('error', error)
  return url.toString()
}
