import postgres from 'postgres'

// For Playwright specs: e2e never truncates artifact_test, so "the first account" is long taken.
// Specs that need an instance admin sign up a fresh person and grant it here.
export async function grantInstanceAdmin(email: string) {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://artifact:artifact@localhost:5432/artifact_test'
  if (!url.includes('artifact_test')) throw new Error(`Refusing to change ${url}`)
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const rows = await sql`update users set is_admin = true where email = ${email.toLowerCase()} returning id`
    if (rows.length !== 1) throw new Error(`No account for ${email}`)
  } finally {
    await sql.end()
  }
}
