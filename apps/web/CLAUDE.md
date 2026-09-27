# apps/web

React 19, React Router 8, Vite 8, TypeScript. No UI or state library: plain components, hooks and hand-written CSS. `marked` renders the docs.

## Where things are

| Path | What |
| --- | --- |
| `src/main.tsx` | Every route. Add new pages here |
| `src/ee/` | Hosted-service-only pages (see `src/ee/CLAUDE.md`); `pages/Home.tsx` loads them |
| `src/pages/` | One component per route, with its own `.css` when it needs styles |
| `src/components/` | Shared pieces (header, gallery, share dialog, history panel, menus), each with its own `.css` |
| `src/api.ts` | Typed `fetch` wrappers for `/api/*`; `src/adminApi.ts` for `/api/admin` |
| `src/useMe.ts` | Signed-in user; redirects to `/login` when signed out. `refreshMe()` reloads it everywhere |
| `src/useConfig.ts` | `/api/config` (self-hosted, email on/off, setup needed, instance name), fetched once per load |
| `src/workspace.ts` | Current workspace (`'personal'` or an organization id), kept in `localStorage` |
| `src/invitations.ts` | Pending invitations shared by the home notice, switcher and onboarding |
| `src/docs.ts` | Loads `/docs/*.md` at build time and lists the sidebar order |
| `src/thumbnailPoll.ts` | Backoff polling for screenshots still being rendered |
| `src/config.ts` | `APP_URL`, `MCP_URL` and auth endpoints |

## Conventions

- API wrappers throw on non-OK responses; form endpoints throw `FieldError` with the field the server named so the page can mark it. Return `null` for "missing or no access" instead of throwing.
- Every page must render correctly in all modes from `useConfig()`: self-hosted or hosted, with or without email. Render nothing until the config arrives where the two differ (e.g. `Landing`, `Auth`), so self-hosted installs never flash marketing pages.
- Styles: design tokens (`--paper`, `--ink`, `--line`, `--marker`, `--step-*`, `--gutter`, …) live in `src/index.css`; use them instead of raw values. `src/App.css` holds shared pieces (nav, buttons, commands, agent picker); the marketing site's styles are in `src/ee/Landing.css`. Class names are plain and prefixed by component (`share-…`, `gallery-…`).
- The look is a blueprint on grid paper: ink-blue lines, numbered circles for steps, "wires" between boxes. Reuse existing patterns (settings rail, cards, `CopyCommand`) before inventing new ones.
- Check phone widths: headers wrap, menus must open on screen, and there is no horizontal scroll.
- Published pages render in a sandboxed `<iframe>` loaded from `/api/artifacts/<slug>/v/<n>/` (never `srcdoc`), so their relative files resolve and they can't reach the app.
- Keyboard and screen readers: menus close on Escape and move with arrow keys (`PageActions`, `WorkspaceSwitcher`); keep labels on icon buttons.

## Docs pages

`src/docs.ts` imports every `docs/*.md` file, but a page shows in the sidebar only when it is listed in `USING`, `RUNNING` or `REFERENCE`. `{{MCP_URL}}` and `{{APP_URL}}` in the Markdown are replaced with this install's addresses.

## Checks

```sh
pnpm --filter @the-artifact/web lint    # eslint
pnpm --filter @the-artifact/web build   # tsc -b + vite build
pnpm --filter @the-artifact/web test    # vitest, for pure modules next to their *.test.ts
```

In dev, Vite proxies `/api`, `/mcp`, `/oauth` and `/.well-known` to `API_URL` (default `http://localhost:3000`).
