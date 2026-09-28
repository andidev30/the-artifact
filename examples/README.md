# Examples

Sample pages for the README and the landing page. An agent wrote each one as a single HTML file, and they're published on the hosted service, shared by link:

| Page | Link |
| --- | --- |
| [`support-report`](support-report/index.html) | https://the-artifact-pi.vercel.app/a/2be2xh8nid |
| [`release-checklist`](release-checklist/index.html) | https://the-artifact-pi.vercel.app/a/fnr34dz8cp |
| [`oauth-pkce`](oauth-pkce/index.html) | https://the-artifact-pi.vercel.app/a/j69kinxscr |

To publish a change as a new version at the same link:

```sh
npx @the-artifact/cli publish examples/support-report --id 2be2xh8nid
```

They use no external files, so they also work on a self-hosted install: `npx @the-artifact/cli publish examples/<name> --server <your server>`.
