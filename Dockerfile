# One image with the API and the built web app, served together on one port.

FROM node:26-slim AS build
WORKDIR /repo
RUN corepack enable

# Install dependencies first so they cache between code changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY docs ./docs
RUN pnpm --filter @the-artifact/web build \
 && pnpm --filter @the-artifact/api build \
 && pnpm --filter @the-artifact/api deploy --prod --legacy /out

FROM node:26-slim

# Headless Chromium renders gallery thumbnails, with no network of its own (see docs/security.md).
# The headless shell needs no GTK, and it draws with its bundled SwiftShader, so the Mesa/LLVM
# drivers chromium-common pulls in (~150 MB) are removed again. Fonts keep text from rendering as
# boxes. Unset CHROME_PATH to skip thumbnails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium-headless-shell fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
 && dpkg --remove --force-depends libgl1-mesa-dri libllvm15 libz3-4 \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIR=/app/web \
    MIGRATE_ON_START=true \
    SELF_HOSTED=true \
    CHROME_PATH=/usr/bin/chromium-headless-shell

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
