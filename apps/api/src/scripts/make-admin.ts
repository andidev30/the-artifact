// Makes an existing account an instance admin and restores it if it was suspended, for an install
// that has no admin left (or whose only admin forgot their password). Runs on the server with its
// database credentials, so it gives nobody more than they already have.
//   pnpm --filter @the-artifact/api admin:grant you@example.com
//   docker compose -f docker-compose.selfhost.yml exec app node dist/scripts/make-admin.js you@example.com
// On a server without email it also prints a sign-in link that sets a new password.
import { eq } from 'drizzle-orm'
import { createAdminLink } from '../auth/email.js'
import { db, schema } from '../db/index.js'
import { mailEnabled } from '../env.js'

const email = (process.argv[2] ?? '').trim().toLowerCase()
if (!email) {
  console.error('Usage: make-admin <email>')
  process.exit(1)
}

const [user] = await db.update(schema.users).set({ isAdmin: true, suspendedAt: null }).where(eq(schema.users.email, email)).returning()
if (!user) {
  console.error(`No account for ${email}. Sign up first, then run this again.`)
  await db.$client.end()
  process.exit(1)
}
console.log(`${email} is now an instance admin.`)

if (!mailEnabled()) {
  const result = await createAdminLink(email, user.id)
  if (result.ok) console.log(`Open this link within 7 days to choose a new password:\n${result.link.link}`)
}
await db.$client.end()
