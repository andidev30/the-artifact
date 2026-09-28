# Version history

Every publish to the same link adds a new version. Nothing is overwritten.

## Browsing versions

Open a page and choose **History** (editors and owners). Each version shows when it was published, by whom and with which agent. Pick one to see it in place; a strip at the top says which version you are viewing, with a way back to the latest.

## Restoring

**Restore this version** publishes that version's HTML and files again as a new version. The history keeps both, so you can always go back.

To keep a copy, choose **Download** in the **…** menu while viewing a version: you get a zip of its `index.html` and files.

## From your agent

Agents see the same history with `list_versions`, restore with `restore_version` and download a version with `download_artifact`, with the same rules as the app (see [Publishing](/docs/publishing#list-versions)). Ask in plain words, for example "go back to the version from this morning".

## How long versions are kept

On your own server, for as long as the page exists. On the hosted service's free Personal plan, a personal page keeps the versions from the last 7 days; older ones are deleted once a day. The current version is always kept, however old it is. Pages in an organization keep their full history.

## Views of each version

**Views** next to **History** shows how many times each version was opened and who opened it. See [Who opened a page](/docs/sharing#who-opened-a-page).

## Who can see history

Only people who can edit the page. Older versions can contain things the author removed on purpose, so viewers and people with the link only see the current version.
