# One image with the API and the built web app, served together on one port.

FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable

# Install dependencies first so they cache between code changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY apps ./apps
RUN pnpm --filter @the-artifact/web build \
 && pnpm --filter @the-artifact/api build \
 && pnpm --filter @the-artifact/api deploy --prod --legacy /out

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIR=/app/web \
    MIGRATE_ON_START=true \
    SELF_HOSTED=true

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
