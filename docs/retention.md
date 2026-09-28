# Version retention

> **Enterprise feature.** Version retention works on a self-hosted server with an Enterprise license key. An instance admin adds the key under **Server admin** (see [Licenses](/docs/licenses#enter-a-license-key)). Without one, you can see this setting but not turn it on.

Every publish adds a version, and by default a self-hosted server keeps every version for as long as the page exists (see [Version history](/docs/version-history#how-long-versions-are-kept)). Retention lets an organization remove older versions it no longer needs, by age, by count, or both.

## What is kept

- **The current version of every page, always**, however old it is and whatever the policy says.
- **Pages themselves.** Retention never deletes a page, its link, its sharing or its comments. Only older versions go.
- Versions within the policy. Anything outside it is deleted.

**Removed versions can't be restored.** Their HTML and files are deleted from storage by the next storage sweep, and nothing in the app or an agent can bring them back. Download a version first (**Download** in the **…** menu while viewing it) if you might need it.

## Setting a policy

Owners and admins of an organization open its settings and go to **Version history**:

| Setting | Options | What it does |
| --- | --- | --- |
| **Keep older versions for** | 30 days, 90 days, 180 days, 1 year, 2 years, **Forever** | Versions published longer ago than this are removed |
| **Also keep at most a number of versions per page** | 1 to 10,000 | Only the newest versions of each page are kept, the current one included; older ones are removed whatever their age |

With both set, a version is removed when it is too old **or** beyond the count. Before you save, the settings count what the new policy would remove right now ("about 42 versions on 7 pages would be removed"). When that is more than none, saving takes a second click on **Save and remove** so it can't happen by accident.

Setting **Forever** with no count limit and saving (**Turn off retention**) removes the policy; from then on every new version is kept again.

The policy applies to the organization's pages only. Personal workspaces and other organizations keep their own history. Members and people outside the organization can't see or change it.

## When versions are removed

The server applies every organization's policy each time it runs its [storage sweep](/docs/self-hosting#where-content-is-stored), every 6 hours, and the sweep then deletes the content nothing refers to any more. So versions go within a few hours of saving a policy, and from then on within a few hours of falling outside it. On a host without a long-running server, `GET /api/cron/sweep` applies the policies too (see `CRON_SECRET` in [Configuration](/docs/configuration)).

## Without a license

A policy needs an Enterprise license that is active or in its [14-day grace period](/docs/licenses#when-a-license-expires) after it expires. When the license expires past the grace period, or is removed:

- The policy is kept, and the settings show it along with a note that it isn't applied.
- No versions are removed until a valid license is added again.
- You can't change the policy, but you can still remove it (**Clear policy**).

On the hosted service, version retention isn't available yet; the free Personal plan has its own rule (see [Version history](/docs/version-history#how-long-versions-are-kept)).
