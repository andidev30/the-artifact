import { expect, test, type APIRequestContext } from '@playwright/test'
import { connectAgent, latestMail, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

async function callTool(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  expect(res.status()).toBe(200)
  return (await res.json()).result.content[0].text as string
}

test('comment on a page, reply, resolve, and read it all from an agent', async ({ page, browser }) => {
  const owner = uniqueEmail('comments-owner')
  const reviewer = uniqueEmail('comments-reviewer')
  const title = `Launch plan ${Date.now()}`

  await signUpPersonal(page, owner)
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title, html: '<h1>Plan</h1>', visibility: 'link' })

  // Someone else, signed in, opens the link and comments
  const other = await browser.newContext()
  const them = await other.newPage()
  await signUpPersonal(them, reviewer)
  await them.goto(`/a/${slug}`)
  await them.getByRole('button', { name: 'Comments' }).click()
  const panel = them.getByRole('complementary', { name: 'Comments' })
  await expect(panel.getByText('No comments yet.')).toBeVisible()
  // Shown as text, never as markup
  await panel.getByLabel('New comment').fill('The chart needs a legend <b>here</b>')
  await panel.getByRole('button', { name: 'Comment', exact: true }).click()
  // Text in a textarea counts as text to getByText, so look for the posted comment itself
  await expect(panel.locator('.comment-body')).toHaveText('The chart needs a legend <b>here</b>')
  await expect(panel.locator('.comment-body b')).toHaveCount(0)
  await expect(panel.getByText('on version 1')).toBeVisible()

  // Authors edit their own comments
  await panel.getByRole('button', { name: 'Edit' }).click()
  await panel.getByLabel('Edit comment').fill('The chart needs a legend')
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(panel.locator('.comment-body')).toHaveText('The chart needs a legend')
  await expect(panel.getByText(', edited')).toBeVisible()

  // The owner gets an email that opens the comments
  const mail = await latestMail(page.request, owner, /commented on/)
  expect(mail).toContain('The chart needs a legend')
  const link = mail.match(/https?:\/\/\S+\?comments/)?.[0]
  expect(link, 'comments link in email').toBeTruthy()

  // The gallery card counts it as new
  await page.goto('/app')
  const card = page.locator('.page-card', { has: page.getByRole('link', { name: new RegExp(title) }) })
  await expect(card.locator('.page-card-comments')).toContainText('1 new')

  await page.goto(new URL(link!).pathname + new URL(link!).search)
  const mine = page.getByRole('complementary', { name: 'Comments' })
  await expect(mine.locator('.comment-body')).toHaveText('The chart needs a legend')
  await expect(mine.locator('.comment-new')).toHaveText('New')
  await expect(page.locator('.viewer-count')).toHaveText('1')

  // Reply, then resolve the thread; it folds away
  await mine.getByRole('button', { name: 'Reply' }).click()
  await mine.getByLabel('Reply').fill('Added in the next version')
  await mine.getByRole('button', { name: 'Reply', exact: true }).last().click()
  const reply = mine.locator('.comment-body', { hasText: 'Added in the next version' })
  await expect(reply).toBeVisible()
  await mine.getByRole('button', { name: 'Resolve' }).click()
  await expect(mine.getByText(/^Resolved by/)).toBeVisible()
  await expect(reply).toBeHidden()
  await mine.getByRole('button', { name: 'Show' }).click()
  await expect(reply).toBeVisible()

  // Read now: the card has no new ones
  await page.goto('/app')
  await expect(card.locator('.page-card-comments')).toHaveText('2 comments')
  await expect(card.locator('.page-card-comments[data-unread]')).toHaveCount(0)

  // The agent reads the thread, resolved ones only when asked
  const open = await callTool(page.request, token, 'list_comments', { artifact_id: slug })
  expect(open).toContain('0 open threads and 1 resolved')
  const all = await callTool(page.request, token, 'list_comments', { artifact_id: slug, include_resolved: true })
  expect(all).toContain('The chart needs a legend')
  expect(all).toContain('Added in the next version')

  // A reply from the agent shows under the reviewer's comment, marked with the agent, and reopens the thread
  const id = all.match(/comment_id: ([0-9a-f-]{36})/)![1]
  await callTool(page.request, token, 'reply_comment', { artifact_id: slug, comment_id: id, body: 'Version 2 is up' })
  await them.reload()
  await them.getByRole('button', { name: /Comments/ }).click()
  await expect(panel.locator('.comment-body', { hasText: 'Version 2 is up' })).toBeVisible()
  await expect(panel.getByText('via e2e-agent')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Resolve' })).toBeVisible()
  await other.close()

  // Signed-out visitors see the page but not its comments
  const anonymous = await browser.newContext()
  const anon = await anonymous.newPage()
  await anon.goto(`/a/${slug}`)
  await expect(anon.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(anon.getByRole('button', { name: /Comments/ })).toHaveCount(0)
  await anonymous.close()
})
