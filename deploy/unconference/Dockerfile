# The unconference.events AppView image: Next.js server, db migrator, Jetstream indexer and the
# privacy audit all run from this one image (different commands), so a release is one build.
# Build context is the repository root:
#   docker build -f deploy/unconference/Dockerfile --build-arg NEXT_PUBLIC_APP_URL=https://unconference.events .

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# Dev dependencies stay: the indexer and audit scripts run through tsx/esbuild.
RUN npm ci --no-audit --no-fund

FROM deps AS build
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NODE_ENV=production
COPY . .
RUN npm run lexicons:validate && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN mkdir -p /data/uploads && chown -R node:node /data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/lexicons ./lexicons
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/package.json /app/next.config.js /app/tsconfig.json ./
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
