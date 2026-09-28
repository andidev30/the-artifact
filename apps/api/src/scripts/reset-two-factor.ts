// Removes every passkey, authenticator app and recovery code of an account and signs it out
// everywhere, for someone who lost all of them when no other instance admin can reset it from
// Server admin (for example the only admin). Runs on the server with its database credentials, so
// it gives nobody more than they already have.
//   pnpm --filter @the-artifact/api two-factor:reset you@example.com
//   docker compose exec app node dist/scripts/reset-two-factor.js you@example.com      (in deploy/docker-compose)
import { eq } from 'drizzle-orm'
import { resetSecondFactor } from '../auth/twofactor.js'
import { db, schema } from '../db/index.js'
import { log } from '../log.js'

const email = (process.argv[2] ?? '').trim().toLowerCase()
if (!email) {
  console.error('Usage: reset-two-factor <email>')
  process.exit(1)
}

const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))
if (!user) {
  console.error(`No account for ${email}.`)
  await db.$client.end()
  process.exit(1)
}
await resetSecondFactor(user.id)
log.warn('Two-factor sign-in reset from the server', { userId: user.id })
console.log(`Two-factor sign-in for ${email} is reset. Sign in with the password, an email link or Google, and set it up again.`)
await db.$client.end()
