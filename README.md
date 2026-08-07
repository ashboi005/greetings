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
- `bun run db:studio`: Open database studio UI
- `bun run check`: Run Biome formatting and linting
- `bun run docker:build`: Build the Docker Compose images
- `bun run docker:up`: Build and start the Docker Compose stack
- `bun run docker:logs`: Tail logs from the Docker Compose stack
- `bun run docker:down`: Stop the Docker Compose stack
