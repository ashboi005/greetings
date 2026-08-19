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

One job needs to run daily. It is set up: `docker compose up` starts a `jobs`
container alongside the server, which fires at **02:30 UTC** by default
(`JOBS_SCHEDULE_UTC`). Nothing else to install.

```bash
bun run jobs schedule                       # what the container runs
bun run jobs nightly                        # the same work, once, by hand
bun run jobs rollup 2026-08-01 2026-08-07   # backfill a date range
bun run jobs scores                         # feed ranking only
bun run jobs cleanup                        # orphan drafts and expired keys only
```

Without it, two things decay:

- **Analytics** read pre-aggregated rows for every date before today, so a
  missed night is a permanent gap in the dashboards' history.
- **Feed ranking** reads a stored score. Downloads keep it current as they
  happen; the nightly pass does the part an increment cannot — retiring
  downloads that have aged out of the seven-day window and re-applying recency
  decay.

Four properties worth knowing:

- **It fires at a wall-clock time, not every 24 hours.** A `sleep 86400` loop
  drifts by each run's duration and resets on every deploy, so "nightly at 2am"
  quietly becomes "whenever the container last restarted".
- **It catches up.** If the machine was off when the job was due, it runs on
  boot — bounded to 20 hours, because a week of downtime wants a deliberate
  backfill, not an automatic one.
- **It cannot overlap.** A Postgres advisory lock is held for the duration, so
  a manual `bun run jobs nightly` during a scheduled run, a second replica, or
  a run overrunning its window all skip rather than pile up.
- **It records every run.** `job_runs` holds what happened and when:

  ```sql
  SELECT name, started_at, ok, detail FROM job_runs ORDER BY started_at DESC LIMIT 5;
  ```

  This is the monitoring. The container is asleep almost all the time, which no
  HTTP probe can distinguish from broken — so "did last night work?" is a query,
  not an archaeology exercise through logs that have rotated away. A row with a
  `started_at` and no `finished_at` is what a crash mid-run looks like.

Every job is idempotent: running it twice produces the same numbers as running
it once.

**If you would rather use host cron**, the same command works and the lock makes
it safe to run alongside the container:

```
30 2 * * *  docker compose run --rm jobs bun dist/jobs/run.mjs nightly
```

**Migrations are not automatic.** A deploy that changes the schema needs
`bun run db:migrate` run against production first. That command creates the
`pg_trgm` extension before applying anything, because two migrations build
trigram indexes that depend on it — a fresh managed Postgres does not have it,
and the schema should not depend on something outside its own history. Doing it on boot would mean
several instances racing the same migration, so it is deliberately a separate
step — but it is a step, and forgetting it is how a deploy half-works.

### Deploying with Coolify

Both apps live in one repository, so each Coolify application needs to be told
which Dockerfile to use — and the field wants the path to the *file*, not the
folder that contains it.

| Application | Dockerfile Location | Base Directory | Port |
|---|---|---|---|
| API | `/apps/server/Dockerfile` | `/` | 3000 |
| Panels | `/apps/web/Dockerfile` | `/` | 3001 |

**Base Directory stays at the repository root** for both. The images run
`bun install --frozen-lockfile` against the workspace, so they need the root
`package.json`, `bun.lock` and `packages/*` in the build context. Narrowing the
context to `apps/server` gets further and then fails on the lockfile.

**`NEXT_PUBLIC_SERVER_URL` must be a build-time variable** for the panels, not
just a runtime one. Next.js bakes `NEXT_PUBLIC_*` into the browser bundle when
it builds, so a value supplied only at runtime arrives too late — the build
fails while prerendering, which is the better of the two possible outcomes.

**Set `TRUST_PROXY_HEADERS=true` on the API.** Coolify puts Traefik in front of
it, so without this every request appears to come from the proxy and the rate
limiter treats the whole user base as one client.

Health checks: `/health` for liveness, `/health/ready` if you want the probe to
verify the database too — it returns 503 when Postgres is unreachable, which
stops a broken deploy rolling forward.

A Dockerfile deployment gives you the API only. The `jobs` service from
`docker-compose.yml` is not included, so schedule it separately — see
[Scheduled work](#scheduled-work).

### Configuration that matters in production

`apps/server/.env.example` documents everything. Three are easy to get wrong:

| Variable | Default | Why you would change it |
|---|---|---|
| `TRUST_PROXY_HEADERS` | `false` | **Set to `true` only if something in front of this server overwrites `x-forwarded-for`.** Left off behind a proxy, every request looks like it comes from the proxy. Turned on without one, any client can evade per-address rate limits by changing a header. |
| `DATABASE_POOL_MAX` | `10` | Sized for four cores. More connections is not more throughput — past about twice the core count, backends contend for the same CPUs. Requests queue at the pool by design. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` | The ceiling for a query somebody is waiting on. Batch jobs raise it for their own transaction; this is not the knob for them. |
| `JOBS_SCHEDULE_UTC` | `02:30` | When the nightly job runs. UTC, not local: the analytics rollup buckets by UTC calendar day, so a local-time schedule would drift against the boundaries it exists to compute. |

### Measuring

```bash
bun run bench      # database round trips per endpoint, warm
```

Every endpoint issues 0, 1 or 2 statements. If a change makes one climb, that is
an N+1 appearing and the number will keep climbing with the data.

### Performance notes

Measured against 200,000 published items and 2,000,000 download events (see
[the spec](docs/specs/greetings-backend.md), §7.1 and §12.2):

- feed page, typical viewer — **3.4 ms**; a viewer with six languages — 61 ms
- search with a term — ~98 ms
- database round trips: **2** for `/v1/feed`, **0** for `/v1/auth/me` and all reference
  data, nothing above 2 anywhere (`bun run bench`)
- responses are gzipped above 1KB — a tag list goes 3,187 → 687 bytes
- under load, throughput flattens at ~1,200 rps and latency queues linearly;
  100% success at 512 concurrent, sixteen times the useful concurrency

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

**Cookies are `SameSite=None; Secure`**, because the panels and the API are
separate origins. Chrome treats `localhost` as trustworthy so this works in
development over plain HTTP, but any other environment must serve both over
HTTPS or the session cookie will not be sent.

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
- `bun run jobs schedule`: The long-lived scheduler (what the `jobs` container runs)
- `bun run jobs nightly`: Rollup, feed rescore and cleanup, once
- `bun run db:studio`: Open database studio UI
- `bun run check`: Run Biome formatting and linting
- `bun run docker:build`: Build the Docker Compose images
- `bun run docker:up`: Build and start the Docker Compose stack
- `bun run docker:logs`: Tail logs from the Docker Compose stack
- `bun run docker:down`: Stop the Docker Compose stack
