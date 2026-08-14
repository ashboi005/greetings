FROM node:24-slim AS base
# Pinned to the version in packageManager and CI. A floating `oven/bun:1` means
# an image built today and one built next month can differ in ways nothing in
# the repository records — and this project has already seen a build fail on a
# different Bun.
COPY --from=oven/bun:1.3.10 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1

COPY . .
# --frozen-lockfile: resolve exactly what CI resolved, or fail loudly rather
# than quietly shipping a different dependency tree.
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

ENV NODE_ENV=production
RUN cd apps/server && bun run build
ENV SKIP_ENV_VALIDATION=

EXPOSE 3000

# Drop root. The server writes nothing outside its own tree, so it does not need
# to own the files it runs — read and execute is enough, which is exactly what
# an attacker who reaches code execution then inherits.
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin greetings
USER greetings

WORKDIR /app/apps/server
CMD ["bun", "dist/index.mjs"]
