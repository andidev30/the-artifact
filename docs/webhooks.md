# Webhooks

A webhook tells another service when something happens in a workspace: a page is published, someone comments, or someone opens a page. Send it to a Slack or Discord channel, or to your own server as signed JSON.

## Who can add them

| Workspace | Where | Who |
| --- | --- | --- |
| An organization | **Organization settings** → **Webhooks** | Its owners and admins |
| Your personal workspace | **Account settings** → **Webhooks** | You |

Members of an organization don't see its webhooks. A workspace can have up to 20.

A webhook keeps sending to the address it was given after the person who added it stops being an admin or leaves the organization, and events carry page titles, commenters' names and comment excerpts. When an admin leaves, review the organization's webhooks and remove or change any that go somewhere only they control.

## Adding a webhook

1. Open **Webhooks** in the settings above and choose **Add webhook**.
2. Paste the **Address**. It must start with `https://`.
3. Choose the **Format**: **Slack incoming webhook**, **Discord webhook**, or **JSON, signed** for your own server.
4. Choose the **Events** to send, and choose **Add webhook**.
5. Copy the signing secret it shows. You see it only once; you need it only to [check signatures](#checking-the-signature) of JSON webhooks.

Choose **Send a test** to send a test message right away and see what the address answered. **Recent deliveries** lists what was sent in the last 14 days, whether it arrived, how many tries it took and why the last one failed. **Turn off** stops sending without deleting the webhook; events that were still waiting to be retried are dropped.

## Events

| Event | When | Name in JSON |
| --- | --- | --- |
| **Page published** | A new page, a new version, or a version restored as the newest one | `page.published` |
| **New comment** | A comment or a reply, in the app or from an agent | `comment.created` |
| **Page opened** | Someone opens a page in the workspace. The owner opening their own page doesn't count. At most once every 10 minutes per page and webhook, so a busy page can't flood a channel | `page.opened` |

Events are about pages in the webhook's workspace only: an organization's webhooks never hear about pages in someone's personal workspace, and the other way round.

## Slack

1. In Slack, create an app for your workspace (**api.slack.com/apps** → **Create New App** → **From scratch**), turn on **Incoming Webhooks**, and choose **Add New Webhook to Workspace** for the channel you want.
2. Copy the webhook URL (`https://hooks.slack.com/services/…`).
3. Add it here with the format **Slack incoming webhook**.

Messages look like "Ada Lovelace published version 3 of Quarterly report in Acme Inc", with the page's title linking to it.

## Discord

1. In Discord, open the channel's settings → **Integrations** → **Webhooks** → **New Webhook**, and choose **Copy Webhook URL** (`https://discord.com/api/webhooks/…`).
2. Add it here with the format **Discord webhook**.

Messages never mention anyone, whatever a page title says.

## JSON

The body is JSON, sent as `POST` with `Content-Type: application/json`:

```json
{
  "event": "comment.created",
  "occurredAt": "2026-09-29T08:15:42.120Z",
  "workspace": { "type": "organization", "id": "6f1c1b7e-3f0a-4a52-9a7e-1f2b3c4d5e6f", "name": "Acme Inc" },
  "page": { "id": "k3m8q2x7pz", "title": "Quarterly report", "url": "{{APP_URL}}/a/k3m8q2x7pz" },
  "version": 3,
  "actor": { "name": "Ada Lovelace" },
  "comment": { "id": "0b8e2c61-4d0f-4d1e-8c55-3a9f3d2b7c10", "excerpt": "The totals in the second table don't add up." }
}
```

| Field | What it is |
| --- | --- |
| `event` | `page.published`, `comment.created` or `page.opened`; `webhook.test` for **Send a test**, which has only `event`, `occurredAt` and `workspace` |
| `occurredAt` | When it happened, in ISO 8601 |
| `workspace` | `{ "type": "organization", "id", "name" }`, or `{ "type": "personal", "name": "Personal" }` |
| `page` | The page's id (as agents know it), title and address. The address opens for anyone only when the page is shared with **Anyone with the link** without a key or password; otherwise people sign in and need access as usual |
| `version` | The version published, commented on or opened |
| `actor` | Who did it: `{ "name" }`, with `name` null when their account has no name. `null` for a page opened through its shared link, which is anonymous |
| `comment` | For `comment.created`: the comment's id and its first 200 characters |

Webhooks never carry page content, email addresses, link keys or passwords.

Every request also has these headers:

| Header | Value |
| --- | --- |
| `X-Artifact-Event` | The event, as in the body |
| `X-Artifact-Delivery` | An id for this delivery, the same on every retry. Use it to ignore one you already handled |
| `X-Artifact-Signature` | `t=<unix time in seconds>,v1=<signature>` |
| `User-Agent` | `TheArtifact-Webhooks/1.0` |

Slack and Discord webhooks are signed the same way, though those services don't check it.

## Checking the signature

The signature is an HMAC-SHA256, in hex, of the timestamp, a dot, and the raw request body, keyed with the webhook's signing secret. Check it against the exact bytes you received, before parsing them, and refuse old timestamps so a captured request can't be sent again later. In Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const secret = process.env.ARTIFACT_WEBHOOK_SECRET // whsec_…

function verify(header, body) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '')
  if (!m) return false
  // Five minutes either way
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false
  const expected = createHmac('sha256', secret).update(`${m[1]}.${body}`).digest()
  return timingSafeEqual(expected, Buffer.from(m[2], 'hex'))
}

createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    if (!verify(req.headers['x-artifact-signature'], body)) return res.writeHead(401).end()
    const event = JSON.parse(body)
    console.log(event.event, event.page?.title)
    res.writeHead(204).end()
  })
}).listen(8000)
```

Each retry is signed again with a new timestamp, so a retry an hour later still passes the five-minute check.

## Delivery and retries

A delivery counts as done when the address answers with a `2xx` status within 5 seconds. Anything else is a failure: another status, no answer in time, a connection or certificate error. Redirects are failures too, since they are never followed; give the final address.

A failed delivery is tried again after 1, 2, 5, 15 and 40 minutes: six tries over a little more than an hour. After the sixth it is marked failed. Answer quickly and do slow work afterwards, and make handling the same `X-Artifact-Delivery` twice harmless: a delivery that timed out on our side may still have arrived.

On a self-hosted server, events are queued in the database and one process sends them within a few seconds, so nothing is lost when the server restarts. On hosts without a long-running process, such as Vercel, the first try is made as the event happens, and retries wait for the scheduled job (`GET /api/cron/webhooks` or `/api/cron/sweep`; see `CRON_SECRET` in the [configuration reference](/docs/configuration)). There, retries are only as frequent as that job runs.

## Addresses webhooks can't reach

Webhooks only go to public addresses. The server looks the name up every time it sends and refuses it if any address it resolves to is private, loopback, link-local (including cloud metadata at `169.254.169.254`) or otherwise reserved, then connects to the address it checked. Addresses like that are refused when you save them too. See [Webhooks can't reach private networks](/docs/security#webhooks-can-t-reach-private-networks).

Only `https://` addresses are accepted, without a user name or password in them. On a development server run from a checkout with `pnpm dev`, `http://localhost`, `http://127.0.0.1` and `http://[::1]` are allowed as well, to try webhooks against a local receiver. A deployed server never allows them, even when its `APP_URL` is plain `http://`.

When a delivery is refused because the name can't be found or resolves to a private address, the error says the same thing in both cases.
