# @the-artifact/web

The React app: marketing site, sign-in, workspace gallery, page viewer, settings, server admin and the docs at `/docs`.

```sh
pnpm dev:web   # from the repository root; http://localhost:5173, proxying the API on :3000
pnpm --filter @the-artifact/web build
pnpm --filter @the-artifact/web test
```

In production the API serves the built app from `WEB_DIR` on the same port. Set `API_URL` to point the dev server at another API, and `VITE_APP_URL` to pin the public address shown in examples.
