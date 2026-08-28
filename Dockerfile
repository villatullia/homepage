FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN pnpm run build && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node templates ./templates
COPY --chown=node:node src/views ./src/views
COPY --chown=node:node index.html calendarw.html privacy.html robots.txt sitemap.xml favicon.svg CNAME testcam.html cro.js ./
COPY --chown=node:node imgs ./imgs
COPY --chown=node:node guide ./guide
COPY --chown=node:node data/availability.json data/manual-blocks.json ./data/
RUN mkdir -p /app/data/private /app/storage /app/backups && chown -R node:node /app/data /app/storage /app/backups
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
