FROM node:24-slim AS builder
# Pinned to packageManager/CI; see apps/server/Dockerfile for why.
COPY --from=oven/bun:1.3.10 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

ARG NEXT_PUBLIC_SERVER_URL
ENV NEXT_PUBLIC_SERVER_URL=${NEXT_PUBLIC_SERVER_URL}
ENV NODE_ENV=production
RUN cd apps/web && bun run build
# standalone output excludes public/; ensure it exists so the runner copy never fails
RUN mkdir -p apps/web/public

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin greetings

# Copied as the runtime user: Next's standalone server writes its image cache
# under .next, so the tree has to be writable by whoever runs it.
COPY --from=builder --chown=greetings:greetings /app/apps/web/.next/standalone ./
COPY --from=builder --chown=greetings:greetings /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=greetings:greetings /app/apps/web/public ./apps/web/public

USER greetings

ENV HOSTNAME=0.0.0.0
ENV PORT=3001
EXPOSE 3001

CMD ["node", "apps/web/server.js"]
