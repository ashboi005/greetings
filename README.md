# greetings

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines Next.js, Elysia, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **Next.js** - Full-stack React framework
- **React Native** - Build mobile apps using React
- **Expo** - Tools for React Native development
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **Elysia** - Type-safe, high-performance framework
- **Bun** - Runtime environment
- **Drizzle** - TypeScript-first ORM
- **PostgreSQL** - Database engine
- **Authentication** - Better-Auth
- **Biome** - Linting and formatting

## Getting Started

First, install the dependencies:

```bash
bun install
```

## Backend Development

The current phase is backend-only. See [`docs/specs/greetings-backend.md`](docs/specs/greetings-backend.md)
for the product and architecture specification.

```bash
bun install
cp apps/server/.env.example apps/server/.env   # then edit if 3000/5432 are taken
bun run db:up            # Postgres 18 in Docker: greetings + greetings_test
bun run db:migrate       # apply migrations to the dev database
bun run db:migrate:test  # and to the test database
bun run db:seed          # regions, languages, and the bootstrap super admin
bun run dev:server
```

`db:seed` is idempotent, so it is safe to re-run after any migration. To grant yourself super admin,
sign in once with Google, set `SUPER_ADMIN_EMAIL` in `apps/server/.env`, then re-run it.

### Scheduled work

One job needs a schedule in every environment. Without it two things decay:

```bash
bun run jobs nightly                        # rollup + rescore + cleanup
bun run jobs rollup 2026-08-01 2026-08-07   # backfill a date range
bun run jobs scores                         # feed ranking only
bun run jobs cleanup                        # orphan drafts and expired keys only
```

- **Analytics** read pre-aggregated rows for every date before today, so a missed night is a gap in
  the dashboards' history.
- **Feed ranking** reads a stored score. Downloads keep it current as they happen; the nightly pass
  does the part an increment cannot — retiring downloads that have aged out of the seven-day window
  and re-applying recency decay.

Every job is idempotent: running it twice produces the same numbers as running it once, so a missed
night is repaired by the next run or a manual backfill.

### Configuration that matters in production

`apps/server/.env.example` documents everything. Three are easy to get wrong:

| Variable | Default | Why you would change it |
|---|---|---|
| `TRUST_PROXY_HEADERS` | `false` | **Set to `true` only if something in front of this server overwrites `x-forwarded-for`.** Left off behind a proxy, every request looks like it comes from the proxy. Turned on without one, any client can evade per-address rate limits by changing a header. |
| `DATABASE_POOL_MAX` | `10` | Sized for four cores. More connections is not more throughput — past about twice the core count, backends contend for the same CPUs. Requests queue at the pool by design. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` | The ceiling for a query somebody is waiting on. Batch jobs raise it for their own transaction; this is not the knob for them. |

### Performance notes

Measured against 200,000 published items and 2,000,000 download events (see
[the spec](docs/specs/greetings-backend.md), §7.1 and §12.2):

- feed page, typical viewer — **3.4 ms**; a viewer with six languages — 61 ms
- search with a term — ~98 ms
- queries per request: 4 for `/v1/feed`, 2 for `/v1/auth/me`, 0 for auth on a cookie-cached web
  request

The spec's §12.3 lists the ceilings that have not been addressed, and §15.1 lists what is
deliberately not built at all. Both are worth reading before adding anything.

The API listens on `PORT` (default 3000). Interactive docs are at
[http://localhost:3000/docs](http://localhost:3000/docs) — that generated OpenAPI document is the
contract the mobile app is built against.

```bash
bun run test          # integration tests against greetings_test
bun run check-types   # TypeScript across all workspaces
bun run check         # Biome format + lint
```

Tests run against a real Postgres rather than mocks, because the logic worth testing (feed ranking,
rollups, constraints) lives in the database. They talk only to `greetings_test`, and both the
preload and the harness refuse to run against a database whose name does not end in `_test`.

`bun run db:reset` destroys the volume and starts clean.

### Full stack

To run the web and native apps alongside the server:

```bash
bun run dev
```

Web on [http://localhost:3001](http://localhost:3001), API on
[http://localhost:3000](http://localhost:3000), mobile through Expo Go.

## The web panels

Three panels, one app, gated by role. Sign-in is Google only — the server has
email and password switched off, because the product has no password flow and
leaving one enabled would be a second, weaker route into an admin account.

| Route | Who | What |
|---|---|---|
| `/designer` | designer | Own content and its review state; create, upload, tag, submit, discard |
| `/designer/analytics` | designer | Own downloads, by day, by post, by state |
| `/moderation` | admin, super admin | Review queue, oldest first; approve, request changes, take down, restore |
| `/moderation/reports` | admin, super admin | Open reports grouped by item, most-reported first |
| `/admin` | super admin | Platform totals, downloads per day, designers by reach |
| `/admin/content` | super admin | Search every item in every status |
| `/admin/content/[id]` | super admin | One item's whole history, every actor named |
| `/admin/people` | super admin | Grant roles, withdraw invites, find anyone |
| `/admin/audit` | super admin | Every moderation decision and every role change |

A super admin sees the moderation screens too — the product asks for one person
who can do everything, and making them switch accounts to approve a post would
be absurd.

The navigation is role-aware, but that is a courtesy, not a control: every
endpoint enforces its own role server-side, and hiding a link the API would
refuse anyway is not security.

**Designers work on phones.** The panel is built for that: stacked rows rather
than tables, and the upload goes straight from the browser to object storage
without passing through the API, so a slow connection is not made slower by an
extra hop.

**Without R2 credentials** the panels still work — previews come back null and
the image slot says so, rather than the whole review screen failing over a
thumbnail.

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@greetings/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Deployment

### Docker Compose

- Target: web + server
- Config: `docker-compose.yml` (app Dockerfiles live in `apps/*/Dockerfile`)
- Build images: bun run docker:build
- Start: bun run docker:up
- Logs: bun run docker:logs
- Stop: bun run docker:down

Environment variables are read from each app's `.env` file (baked into web builds for public variables) and overridden in `docker-compose.yml` for container networking.

For more details, see the guide on [Deploying with Docker Compose](https://www.better-t-stack.dev/docs/guides/docker).

## Git Hooks and Formatting

- Run checks: `bun run check`

## Project Structure

```
greetings/
├── apps/
│   ├── web/         # Frontend application (Next.js)
│   ├── native/      # Mobile application (React Native, Expo)
│   └── server/      # Backend API (Elysia)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── auth/        # Authentication configuration & logic
│   └── db/          # Database schema & queries
```

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run dev:server`: Start only the server
- `bun run check-types`: Check TypeScript types across all apps
- `bun run dev:native`: Start the React Native/Expo development server
- `bun run test`: Run the backend test suite
- `bun run db:up` / `db:down` / `db:reset`: Manage the local Postgres container
- `bun run db:push`: Push schema changes to database
- `bun run db:generate`: Generate a migration from schema changes
- `bun run db:migrate`: Run database migrations
- `bun run db:migrate:test`: Run migrations against the test database
- `bun run db:seed`: Seed reference data and the bootstrap super admin
- `bun run db:seed:demo`: Seed a sample dataset for a fresh environment (never in production)
- `bun run jobs nightly`: Daily rollup, feed rescore and cleanup — schedule this
- `bun run db:studio`: Open database studio UI
- `bun run check`: Run Biome formatting and linting
- `bun run docker:build`: Build the Docker Compose images
- `bun run docker:up`: Build and start the Docker Compose stack
- `bun run docker:logs`: Tail logs from the Docker Compose stack
- `bun run docker:down`: Stop the Docker Compose stack
