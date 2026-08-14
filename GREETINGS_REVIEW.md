# Greetings end-to-end engineering review

## 1. Executive summary

- **Review date:** 2026-08-11
- **Starting branch:** `main`
- **Starting commit:** `528d9ba6d36e4e28f9f41b3e1c3f5bf42ce7f590`
- **Local fix branch:** `codex/greetings-review-fixes`
- **Reviewed scope:** `apps/server`, `apps/web`, `apps/native`, `packages/auth`, `packages/db`, `packages/env`, `packages/ui`, repository documentation, tests, CI, Docker, migration, build, and runtime configuration.
- **Actionable findings:** 10 total — 1 Critical, 2 High, 6 Medium, 1 Low.
- **Fixed on this branch:** 4 — F-001 through F-004.
- **Deferred with recommendations:** 6 — F-005 through F-010.
- **Intentionally preserved decisions:** direct R2 upload/download, optional providers, Firebase-to-Better-Auth exchange, bounded cookie/session caches, single-process rate limiting, a separate jobs process, manual production migrations, no backend image processing, no multi-tenancy, and the deferred Phase 3 mobile product.

The most serious issue was an exploitable CSRF boundary: privileged browser sessions use `SameSite=None` cookies, but custom mutation routes did not validate the request origin. A cross-site form could therefore attempt a role assignment while a super admin was signed in. The fix adds an origin check for unsafe cookie-authenticated custom API requests while preserving bearer clients and Better Auth's own routes.

Two High-severity concurrency failures were also fixed. Designer image/tag mutations now atomically claim an editable content row before changing reviewed state, and report resolution now serializes decisions on the shared content row even when competing requests name different reports. Strict calendar-date validation now rejects values such as `2026-02-31` as a 400 instead of passing them toward PostgreSQL.

### Must fix or close before production launch

1. **F-005:** make the idempotency claim, download event, and counter update one transaction/statement so a retry cannot return an uncounted download.
2. **F-007:** audit existing account rows and add a unique constraint on `(provider_id, account_id)` before authentication traffic is allowed to create duplicates.
3. **F-009:** pin the Docker Bun version to the repository version, use the frozen lockfile in images, and run production containers as non-root.
4. Run the database migration and complete integration/adversarial suite with Bun 1.3.10 and a valid disposable `TEST_DATABASE_URL`; this environment could not provide those prerequisites.

### Verification limitations

- Docker Desktop's service was stopped, so `bun run db:up` and Docker image verification were unavailable.
- A local PostgreSQL 18 service was listening, but it rejected the repository's documented development credential. No private credentials were sought and no existing database was modified.
- `TEST_DATABASE_URL` and the required server environment were intentionally not supplied. Database-backed tests and migrations therefore remained blocked.
- The installed Bun is 1.2.19; the repository and CI pin 1.3.10. The server build fails locally while loading `unrun`, whereas TypeScript and the web production build complete.
- Repository-wide Biome remains red because of pre-existing CRLF/formatting debt. Every file changed by this review passes targeted Biome validation.

## 2. Scope and methodology

The review began read-only on a clean `main` worktree. I recorded the commit, inspected recent history, read `README.md`, read the complete `docs/specs/greetings-backend.md`, read `apps/web/AGENTS.md`, inspected scripts and CI, and traced the implementation and tests before creating the local branch.

The assessment covered:

- authentication provider setup, Firebase verification and linking, Better Auth sessions, cookies, bearer/Expo support, revocation, cache invalidation, and trusted origins;
- route-by-route role and ownership enforcement;
- request schemas, cursors, raw SQL bindings, signed storage URLs, output exposure, error envelopes, proxy trust, and request-size limits;
- content lifecycle transitions, upload confirmation, moderation, reports, downloads, analytics, cleanup, jobs, and concurrency boundaries;
- database constraints, foreign keys, indexes, migrations, seeds, pooling, statement timeouts, and destructive-test safeguards;
- web route protection, API calls, panel/backend parity, loading/error states, XSS surfaces, and Next.js client/server boundaries;
- native public configuration, bearer/session storage, and the explicit Phase 3 boundary;
- CI, Dockerfiles, Compose, builds, graceful shutdown, health/readiness behavior, and secret handling.

The security analysis used concrete request scenarios rather than checklist-only assertions. Concurrency findings were derived from transaction order and row-lock behavior, then represented as adversarial tests. The CSRF boundary was also exercised against a real listening server. Existing comments, recent commits, tests, and the locked design decisions in the backend specification were treated as evidence before labeling unusual code as defective.

The missing Phase 3 mobile screens and other explicitly deferred features are not included in the finding counts.

## 3. Side-by-side fix table

| ID | Severity | Area | Before | Concrete risk/failure | After | Why this fixes it | Evidence/tests |
|---|---|---|---|---|---|---|---|
| F-001 | Critical | Browser session security | At the starting commit, `apps/server/src/app.ts:108-111` composed custom routes without an unsafe-method origin guard. `packages/auth/src/index.ts:86-88` uses `SameSite=None; Secure` cookies. | An attacker-controlled page could submit a cross-site form to a custom mutation such as `/v1/admin/roles/assign`. CORS would prevent reading the response, but would not prevent the side effect; ambient cookies could authorize privilege escalation. | `apps/server/src/app.ts:112` composes `csrfProtection`. `apps/server/src/lib/csrf.ts:15-37` rejects unsafe cookie-authenticated requests with a missing or untrusted `Origin`; `apps/server/src/lib/csrf-plugin.ts:5-13` binds the configured web/API origins. | A browser credential is ambient and therefore requires an origin check. Bearer-only clients remain allowed because a cross-site form cannot manufacture the authorization token. Safe methods remain unchanged. Better Auth routes remain under Better Auth's own CSRF contract. | `apps/server/src/lib/csrf.test.ts`; `apps/server/src/lib/csrf-app.test.ts`; real listening-server POST returned HTTP 403 with the documented error envelope. |
| F-002 | High | Designer content lifecycle | At the starting commit, asset confirmation checked status around `apps/server/src/modules/content/designer-routes.ts:285`, then performed storage I/O before the transaction at line 325. Tag replacement similarly checked status before tag validation and began its transaction around line 485. Neither transaction rechecked editability. | Submission could win after the initial check but before the asset/tag transaction. The later mutation could then replace the image or tags on `pending_review` content, invalidating what the admin was reviewing. | `apps/server/src/modules/content/designer-routes.ts:60-91` adds an atomic conditional update/row claim. Asset and tag transactions call it first at lines 360 and 521. | PostgreSQL re-evaluates the conditional update after any competing row lock. Exactly one ordering wins: the edit commits before submission, or submission changes the status and the edit returns 409 without changing dependent rows. | Deterministic delayed-storage regression at `apps/server/test/adversarial.test.ts:533`; TypeScript and targeted Biome pass. Database execution is pending a valid test database. |
| F-003 | High | Report moderation concurrency | At the starting commit, `apps/server/src/modules/moderation/reports.ts:159-179` read one report before opening the transaction. Two requests could pass the open check and later apply opposing content actions; requests naming different reports did not share a lock. | Two admins could both receive success for `keep` and `remove`. The second action could remove content after a keep decision or clear a hold after removal, while report rows reflected only one resolution. | `apps/server/src/modules/moderation/reports.ts:163-196` resolves the report's content id, locks the shared content row, then locks and rechecks the selected report inside the same transaction. | Every resolution for the same content serializes on one row and takes locks in a consistent order. The loser observes resolved state and returns 409 before mutating content. | Distinct-report opposing-decision regression at `apps/server/test/adversarial.test.ts:353`; existing same-report concurrency coverage retained. Database execution is pending a valid test database. |
| F-004 | Medium | Analytics input validation | At the starting commit, `apps/server/src/modules/analytics/routes.ts:59-64` combined a shape regex with `Date.parse`. JavaScript normalizes some impossible dates instead of rejecting them. | `from=2026-02-31` could pass application validation and reach a PostgreSQL `::date` cast, producing a 500 for client input. | `apps/server/src/lib/iso-date.ts:4-17` parses at UTC midnight and requires the serialized date to exactly equal the input. Analytics calls it at `apps/server/src/modules/analytics/routes.ts:45-46`. | Round-trip equality rejects normalized overflow days while preserving valid dates, including leap day, and keeps the field-specific 400 message. | `apps/server/src/lib/iso-date.test.ts`; API regression at `apps/server/test/analytics.test.ts:499`; six focused CSRF/date tests pass. |

### Material before/after excerpts

F-001 changed the custom-route boundary from no request-origin decision to an explicit ambient-credential gate:

```ts
if (!request.headers.has("cookie")) return;
if (request.headers.get("authorization")?.startsWith("Bearer ")) return;

if (!normalizedOrigin || !trustedOrigins.has(normalizedOrigin)) {
  throw forbidden("Cross-site cookie-authenticated request refused.");
}
```

F-002 moved the authoritative state check into the mutating transaction:

```ts
const [claimed] = await tx
  .update(content)
  .set({ ...input.patch, updatedAt: new Date() })
  .where(and(
    eq(content.id, input.contentId),
    eq(content.designerId, input.designerId),
    inArray(content.status, [...EDITABLE_STATUSES]),
  ))
  .returning({ id: content.id });
```

F-003 now serializes a decision on the thing the decision actually affects:

```ts
await tx
  .select({ id: content.id })
  .from(content)
  .where(eq(content.id, candidate.contentId))
  .limit(1)
  .for("update");
```

## 4. Detailed findings

### F-001 — cross-site custom mutations accepted ambient session cookies

- **Severity:** Critical
- **Status:** Fixed
- **Location:** original `apps/server/src/app.ts:108-111`; session cookie policy `packages/auth/src/index.ts:86-88`; final guard `apps/server/src/lib/csrf.ts:15-37` and `apps/server/src/app.ts:112`
- **Component/actor:** custom Elysia API routes; authenticated web designers, admins, and super admins
- **Observed behavior:** credentialed CORS and `SameSite=None` cookies were configured, but custom unsafe routes made no `Origin`/CSRF decision.
- **Expected behavior/source:** the specification requires safe cross-origin session behavior and server-enforced authorization. Ambient browser credentials on unsafe methods require a request-authenticity boundary in addition to CORS.
- **Concrete exploit:** a malicious page can auto-submit `application/x-www-form-urlencoded` fields for role assignment while a super admin is signed in. The browser need not expose the response for the server-side role mutation to occur.
- **Root cause:** CORS was treated as the cross-site mutation boundary even though it is principally a response-reading policy.
- **Fix:** require a configured trusted `Origin` for unsafe requests carrying cookies, while exempting safe methods, bearer clients, and Better Auth's own route namespace.
- **Validation:** unit branch coverage; composed-app form POST test; real listening server returned 403 and `{ error: { code: "FORBIDDEN", ... } }`.

### F-002 — designer edits could cross the submit/review boundary

- **Severity:** High
- **Status:** Fixed
- **Location:** original `apps/server/src/modules/content/designer-routes.ts:285-325` and `:465-485`; final `:60-91`, `:359-365`, and `:520-525`
- **Component/actor:** designer asset/tag mutation and admin review
- **Observed behavior:** editability was checked before asynchronous object metadata lookup or tag validation. Dependent-row changes happened later without a locked/conditional content-status check.
- **Expected behavior/source:** the lifecycle specification and existing route comments require an approval to cover the exact title, image, and tags reviewed by an admin.
- **Failure mode:** submission changes `draft` to `pending_review` while the asset request is waiting on R2; asset confirmation then deletes the reviewed asset, inserts another, and changes the primary key.
- **Root cause:** a useful early validation was mistaken for the authoritative concurrency check.
- **Fix:** a shared transaction-first conditional update claims ownership and an editable status before either assets or tags change.
- **Validation:** the regression deliberately pauses `storage.stat` after the old precheck, submits the content, then releases confirmation and expects 409 with the original asset intact. Test execution requires the unavailable test database; the code compiles and passes targeted Biome.

### F-003 — opposing report decisions were not serialized by content

- **Severity:** High
- **Status:** Fixed
- **Location:** original `apps/server/src/modules/moderation/reports.ts:159-179`; final `:163-196`
- **Component/actor:** admin report queue and content visibility/status
- **Observed behavior:** the selected report was read outside the transaction, and the transaction did not establish a common lock for every report on the content.
- **Expected behavior/source:** report resolution applies to all open reports for the content, and concurrent moderation must produce one accepted decision and one conflict.
- **Failure mode:** `keep` and `remove` requests, especially when naming two different open report ids, could both pass stale checks and both mutate content.
- **Root cause:** the lock identity was narrower than the aggregate being decided.
- **Fix:** resolve content id, lock the content row first, then lock/recheck the report and perform resolution in the same transaction.
- **Validation:** added a two-reporter, two-report-id opposing-decision test. Database execution remains blocked; TypeScript and targeted Biome pass.

### F-004 — impossible ISO-shaped dates could become server errors

- **Severity:** Medium
- **Status:** Fixed
- **Location:** original `apps/server/src/modules/analytics/routes.ts:59-64`; final `apps/server/src/lib/iso-date.ts:4-17`
- **Component/actor:** designer/super-admin analytics callers
- **Observed behavior:** `Date.parse` accepted normalized dates such as `2026-02-31`.
- **Expected behavior/source:** malformed client input must return 4xx and analytics accepts real UTC calendar dates in `YYYY-MM-DD` form.
- **Impact:** invalid dates could escape to database casts and return 500, creating noisy operational failures and an inconsistent API contract.
- **Root cause:** syntactic shape and JavaScript parseability were used as a substitute for calendar validity.
- **Fix:** canonical UTC round-trip validation.
- **Validation:** focused tests cover a valid leap day, invalid leap day, 31st-day overflow, malformed width, field-specific errors, and an API-level case.

### F-005 — download idempotency claim can commit without the download event

- **Severity:** Medium
- **Status:** Deferred
- **Location:** `apps/server/src/modules/downloads/service.ts:81-96`, `:99-143`, and `:150-190`
- **Component/actor:** end-user download, analytics, ranking, and designer counters
- **Observed behavior:** `claimIdempotencyKey` commits before the separate event/counter CTE.
- **Expected behavior/source:** the download section requires idempotency, event insertion, counters, and the returned URL to remain consistent under retries and failures.
- **Failure mode:** the claim succeeds, then the event/counter statement fails. A retry within 60 seconds sees the claim and returns `recorded: false` plus a signed URL even though no event or counter was recorded. Reusing one key for another content id also returns the stored first-content URL instead of rejecting misuse.
- **Root cause:** the performance optimization made event plus counters atomic with each other, but left the idempotency claim outside that atomic unit.
- **Recommendation:** make claim, event insert, and counter update one transaction or one data-modifying CTE. Store and validate the content id on replay; return 409 for key reuse across different content. Preserve the current single-round-trip goal if one SQL statement can express it.
- **Why deferred:** this is the busiest write path and needs real PostgreSQL concurrency/failure tests and query-count measurement. Those prerequisites were unavailable.
- **Validation evidence:** static transaction-boundary analysis; existing tests cover ordinary concurrent replays but not failure after claim.

### F-006 — durable report quota uses a count-then-insert race

- **Severity:** Medium
- **Status:** Deferred
- **Location:** `apps/server/src/modules/moderation/reports.ts:62`, `:132-148`, then insertion at `:66-75`
- **Component/actor:** authenticated end-user reporting and moderation queue
- **Observed behavior:** the last-hour count and insert are separate committed operations.
- **Expected behavior/source:** report limits are intentionally database-backed so they survive restarts; concurrent submissions should not bypass the same limit.
- **Failure mode:** many simultaneous reports against different content can all observe 19 and all insert, exceeding the limit. The unique per-user/content constraint prevents duplicates on one item but does not protect the per-hour aggregate.
- **Root cause:** no per-reporter serialization or durable quota row surrounds the aggregate decision.
- **Recommendation:** use a transaction-scoped per-reporter advisory lock around count and insert, or a dedicated durable quota bucket with atomic increment/expiry semantics. Add a real-PostgreSQL concurrency test.
- **Why deferred:** it changes the submit transaction boundary and requires database concurrency verification. The current unique constraint and five-distinct-reporter hold threshold limit immediate damage, so this is not ranked High.

### F-007 — provider identity uniqueness is not enforced by the database

- **Severity:** Medium
- **Status:** Deferred
- **Location:** `packages/db/src/schema/auth.ts:74-96`; corresponding migration definitions
- **Component/actor:** Google/Firebase account linking and every authenticated user
- **Observed behavior:** `account` has only `account_userId_idx`; `(provider_id, account_id)` is not unique.
- **Expected behavior/source:** an external provider subject must resolve to one account identity. Better Auth lookup behavior also keys identities by provider plus account id.
- **Failure mode:** concurrent first-time linking can create duplicate rows for the same external identity. Even if both currently point at one user, the missing invariant permits ambiguous authentication data and makes future repair/migration harder.
- **Root cause:** application-level lookup/link logic is relied upon without the matching database constraint.
- **Recommendation:** inspect production-like data for duplicates, reconcile them, then add a unique composite index/constraint and an adversarial concurrent-link test.
- **Why deferred:** adding the constraint without auditing existing rows could make migration fail. No test database was available to verify empty and upgrade migrations.

### F-008 — daily rollup upsert and stale-row prune are not atomic together

- **Severity:** Medium
- **Status:** Deferred
- **Location:** `apps/server/src/jobs/rollup-daily-stats.ts:41-70` and `:80-93`
- **Component/actor:** designer and platform analytics
- **Observed behavior:** rollup upsert commits, then `pruneStaleRows` runs as a second statement outside a transaction.
- **Expected behavior/source:** one recomputation should represent one day consistently and be retry-safe.
- **Failure mode:** a failure between statements leaves updated aggregates beside stale rows. The recorded job failure and a rerun repair the data, but dashboards can show a mixed snapshot until that rerun.
- **Root cause:** each statement is individually idempotent, but the pair lacks a shared transaction.
- **Recommendation:** execute both statements in one transaction while preserving the advisory job lock; add a failure-injection test proving rollback of the upsert when prune fails.
- **Why deferred:** the current system converges on retry and records failed jobs, reducing severity. Real database verification is still required for the transaction change.

### F-009 — production Docker builds are not pinned/reproducible and run privileged

- **Severity:** Medium
- **Status:** Deferred
- **Location:** `apps/server/Dockerfile:1-16`; `apps/web/Dockerfile:1-28`; root `package.json` package manager field
- **Component/actor:** production deployment and platform operator
- **Observed behavior:** both builds copy Bun from floating `oven/bun:1`, use `bun install` without `--frozen-lockfile`, and leave the runtime process as root.
- **Expected behavior/source:** production artifacts should match CI's Bun 1.3.10/lockfile resolution and use least privilege.
- **Failure mode:** a later `bun:1` or dependency resolution can produce an image different from CI; compromise of a root-running application has a larger container blast radius. The local Bun 1.2.19 server-build failure demonstrates that toolchain parity materially affects this repository.
- **Root cause:** Dockerfiles predate the pinned CI/runtime contract and lack a dedicated runtime user.
- **Recommendation:** pin `oven/bun:1.3.10`, use `bun install --frozen-lockfile`, introduce a non-root runtime user, and verify file ownership plus health checks with `bun run docker:build`.
- **Why deferred:** Docker was unavailable and changing users without image-level verification risks an unreadable standalone/build output.

### F-010 — CI does not validate the implemented web panels

- **Severity:** Low
- **Status:** Deferred
- **Location:** `.github/workflows/ci.yml:42-61`
- **Component/actor:** maintainers and web-panel users
- **Observed behavior:** CI Biome covers server/db/env/auth and builds only the server. Its comment still describes web/UI as scaffolded, although the panels are implemented.
- **Expected behavior/source:** CI should cover shipped applications and match the documented local checks.
- **Impact:** web lint regressions or production-build failures can merge without CI noticing.
- **Root cause:** CI scope was not widened when Phase 2 web panels landed.
- **Recommendation:** first clean or ratchet the existing web/UI Biome debt, then include web/UI checks and a web production build with a non-secret test `NEXT_PUBLIC_SERVER_URL`.
- **Why deferred:** repository-wide Biome currently reports 161 pre-existing errors, so blindly widening CI would make every change red. This review does not perform unrelated mass formatting.

## 5. Left unchanged — and why

### Deferred actionable findings

| Area/file | Concern investigated | Evidence considered | Why it was left unchanged | When it should be revisited |
|---|---|---|---|---|
| Downloads service | Idempotency claim is separate from event/counter write (F-005). | Service transaction boundaries, idempotency tests, spec atomicity requirement, query-count comments. | Correct repair affects the hottest write path and needs Postgres failure/concurrency tests plus query-count verification. | Before launch; include cross-content key misuse behavior. |
| Reports service | Per-hour report count races concurrent inserts (F-006). | Database-backed limit code, uniqueness, automatic-hold threshold, single-instance assumption. | A safe advisory-lock/quota change requires real database concurrency coverage. | Soon; before exposing reporting to untrusted high-volume traffic. |
| Auth schema/migrations | Missing provider/account composite uniqueness (F-007). | Better Auth identity lookup model, schema, migrations, linking code. | A blind unique migration can fail on existing duplicates; data must be audited first. | Before launch and before importing/merging users. |
| Daily rollup | Upsert and prune commit separately (F-008). | Rollup code, idempotency tests, job-run failure records, advisory job lock. | Retry converges and failures are observable; transaction repair needs DB tests. | Soon, especially before analytics becomes operationally important. |
| Dockerfiles | Floating Bun, non-frozen install, root runtime (F-009). | Dockerfiles, packageManager pin, CI pin, local build behavior. | Docker daemon unavailable; permission-sensitive image changes could not be verified. | Before the first production image is approved. |
| CI | Web/UI not linted and web not built (F-010). | CI file, implemented panel routes, current broad Biome result, successful local web build. | Widening CI now would institutionalize a permanently failing pipeline unless existing debt is first cleaned or ratcheted. | Next platform-maintenance change. |

### Investigated architecture and intentionally preserved behavior

| Area/file | Concern investigated | Evidence considered | Why it was left unchanged | When it should be revisited |
|---|---|---|---|---|
| Direct-to-R2 uploads | Whether images should pass through the API for validation. | Spec upload boundary; presigned PUT flow; storage metadata verification; size/MIME/key binding; fake-storage tests. | Direct upload prevents API memory/bandwidth pressure. Confirmation trusts R2 metadata, binds keys to content, and cleanup lists the bucket so abandoned uploads remain discoverable. | If malware scanning, transformations, or regulated content handling become product requirements. |
| Optional Firebase/Google/R2 providers | Whether missing credentials should prevent boot. | Typed env schemas, lazy storage resolution, conditional Google provider, explicit errors. | The documented contract is fail-on-use, not fail-on-boot. Unrelated health, moderation text, and other routes can remain available. | If a deployment profile guarantees a provider and wants stricter startup readiness checks. |
| Firebase-to-Better-Auth exchange | Whether custom mobile exchange weakens privileged auth. | JOSE issuer/audience/signature/expiry checks; verified-email linking; default role; Google-only privileged web path; disabled email/password. | It provides the documented bridge to opaque Better Auth bearer sessions without allowing role input or unverified-email linking. | If Firebase identity policy changes or a second mobile identity provider is introduced. |
| Cookie cache/session revocation | Whether five-minute cookie caching leaves stale privilege. | Better Auth config, in-process bearer/session caches, role-change session deletion, `invalidateAll`, request-local memoization tests. | Role changes revoke database sessions and clear caches. The cache is a bounded performance trade-off, not authority independent of the session lifecycle. | When sessions are distributed across multiple API instances; cache invalidation must then become cross-instance. |
| Single-process rate limiting | Whether Redis is required now. | Spec deployment ceiling, trusted-proxy default false, per-address and global limiter tests, durable report count. | The current deployment is explicitly one API process. A distributed limiter would add infrastructure without improving correctness today. F-006 is separately recorded because its durable database quota has an intra-process SQL race. | Before horizontal API scaling or when abuse evidence justifies shared quotas. |
| Separate scheduled-job process | Whether jobs should run in every API instance. | Job runner, scheduler, Compose services, advisory lock, catch-up/job-run tests. | Separation avoids duplicate background work and keeps API startup/request resources independent. Advisory locking also protects manual/scheduled overlap. | If moving to a managed scheduler or queue worker platform. |
| Manual production migrations | Whether the server should auto-migrate. | README/deployment docs, Drizzle scripts, CI migration step, spec decision. | Manual/explicit migration preserves operator control and avoids multiple app replicas racing schema changes. | If a deployment orchestrator gains a dedicated one-shot migration phase. |
| No backend image processing | Whether thumbnails/resizing/moderation are missing. | Explicitly deferred scope, direct object flow, signed previews/downloads. | This is a product/platform choice, not a defect. The backend validates actual MIME/size but does not claim to transform images. | When bandwidth, accessibility, moderation, or device compatibility data demonstrates the need. |
| No multi-tenancy/teams | Whether designer ownership needs organization ids. | Product actors, schema ownership, role guards, explicit exclusions. | Current ownership is individual designer plus platform admins; adding organizations would change the product and authorization model. | Only after teams/organizations become a stated requirement. |
| Native Phase 3 UI | Existing scaffold contains email/password forms while server disables email/password. | Native files, auth client, SecureStore, server auth config, explicit Phase 3 deferral. | The complete end-user UI is explicitly not shipped here. Building Firebase onboarding/feed/search/download/report screens would exceed this review. The server correctly does not enable a weaker password path merely to satisfy scaffold components. | At Phase 3 start; replace/remove scaffold password screens as part of the chosen Firebase UX. |
| Feed/search ranking SQL | Whether raw SQL should be simplified. | Spec weights, indexes, cursor tests, prior performance commit, benchmark/query-count comments. | The SQL is deliberately database-shaped and performance-sensitive. No concrete correctness regression was found, and no test DB was available for plans/benchmarks. | With production relevance data, scale-threshold evidence, or a reproducible query-plan regression. |
| `createApp` vs observability entrypoint | Whether logging should move into the test app. | Source comments, test-runner AsyncLocalStorage history, production 404 handling. | The split is deliberate and protects Bun test completion while the outer app normalizes unmatched-route behavior. | Only after the upstream AsyncLocalStorage behavior is demonstrably fixed and regression-tested. |
| Storage deletion after database delete | Whether deleting the only row first makes objects unrecoverable. | Designer delete comments, bucket-prefix listing, nightly orphan cleanup, storage-failure tests. | Cleanup authority is the bucket listing, not only the database reference. A failed immediate delete remains discoverable and retryable after the row is gone. | If bucket listing is removed or object naming stops embedding the content id. |

## 6. API and UI parity

| Web capability | Backend endpoint(s) | Parity assessment |
|---|---|---|
| Session bootstrap/sign-out | `/v1/auth/me`, Better Auth sign-out | Implemented; credentialed requests and 401 session clearing are centralized. |
| Designer list/create/detail/edit/delete | `/v1/designer/content`, `/v1/designer/content/:id` | Implemented with designer ownership enforced server-side. |
| Designer image upload/confirmation | `/v1/designer/content/:id/upload-url`, `/assets` | Implemented as direct PUT plus confirmation; F-002 closes the submit race. |
| Designer tags and submission | `/v1/designer/content/:id/tags`, `/submit` | Implemented; F-002 also protects concurrent retagging. |
| Designer analytics | `/v1/designer/analytics/summary`, `/by-content`, `/by-region`, `/timeseries` | All four endpoints have UI consumers. |
| Moderation queue/detail/actions | `/v1/admin/content/queue`, `/content/:id`, `/approve`, `/reject`, `/remove`, `/restore` | Implemented; roles are enforced by route macros rather than navigation alone. |
| Report queue/resolution | `/v1/admin/reports`, `/reports/:id/resolve` | Implemented; F-003 serializes opposing decisions. |
| Super-admin directory/roles/invites | `/v1/admin/users`, `/roles/assign`, `/roles/invites` | Implemented. |
| Super-admin audit | `/v1/admin/audit/actions`, `/audit/roles`, `/content/:id/audit` | Implemented in audit and content detail screens. |
| Super-admin content directory | `/v1/admin/content`, `/content/:id/audit` | Implemented. |
| Platform analytics | `/v1/admin/analytics/overview`, `/timeseries`, `/by-designer` | Implemented. |

Backend web-panel endpoints without a current UI are `/v1/admin/analytics/by-content` and `/v1/admin/analytics/by-region`. They are valid super-admin APIs and are retained for future dashboard expansion; their presence is not a permission mismatch.

Mobile-facing `/v1/me/profile`, `/v1/feed`, `/v1/search`, `/v1/content/:id/download`, and `/v1/content/:id/report` intentionally have no web-panel UI. No web UI call was found without a valid backend endpoint, and no implemented web payload was found to request a role or ownership scope the server does not authorize.

The native scaffold's email/password calls are not compatible with the intentionally disabled server capability. This is recorded as deferred Phase 3 scaffold work, not a reason to enable password authentication.

## 7. Security boundary assessment

### Authentication

- Firebase ID tokens are verified through JOSE using the Google key set and checked for issuer, audience/project, signature, expiry, and verified identity fields before exchange.
- Firebase account linking uses verified email only and otherwise keys by Firebase subject.
- Privileged web sign-in is Google-based; email/password is disabled.
- The role field is declared `input: false`, defaults to `user`, and role changes go through a super-admin route.

### Sessions and tokens

- Better Auth opaque sessions support browser cookies and mobile bearer tokens through the Expo/bearer plugins.
- Cookies are `HttpOnly`, `Secure`, and `SameSite=None` for the documented cross-origin web deployment.
- Session resolution is memoized per request and separately bounded for bearer lookups.
- Role changes revoke target sessions and invalidate in-process caches.
- The review found no deliberate logging of bearer tokens, secrets, signed URLs, or unmasked user identity; evlog identity masking is enabled.

### Role authorization and ownership

- Route macros enforce `designer`, `admin`, and `super_admin` roles server-side.
- Designer content and analytics paths derive ownership from the session rather than accepting a caller-selected designer id.
- Super-admin-only role, audit, global-content, and platform-analytics routes are guarded independently of UI navigation.
- F-002 closes the identified ownership/lifecycle time-of-check gap.

### CORS, CSRF, and cookies

- CORS is limited to the configured web origin and permits credentials and required methods/headers.
- F-001 adds the previously missing mutation-authenticity check for ambient cookies.
- Bearer clients remain independent of browser Origin because their credential is not ambient.

### Storage authorization

- Upload keys contain content id plus a random suffix; confirmation requires the expected content prefix and actual R2 metadata.
- Upload and preview/download URLs are signed and short-lived.
- Objects are not public, cross-content key attachment is rejected, and bucket-driven cleanup keeps abandoned/failure cases discoverable.

### Secret and XSS handling

- Server-only environment values remain server-only; public web/native variables contain base URLs, not secrets.
- No committed credential was observed in the reviewed files.
- React renders user-controlled titles, reasons, and audit text through normal escaped JSX; no `dangerouslySetInnerHTML` or equivalent unsafe rendering path was found.
- API incidental errors collapse to a generic INTERNAL envelope.

### Rate-limit trust boundaries

- Proxy headers default to untrusted and are used only when the deployment explicitly enables trusted proxy behavior.
- Firebase verification has per-address and global in-process ceilings appropriate to the documented single instance.
- F-006 remains the identified race in the otherwise durable report quota.

## 8. Database and concurrency assessment

- **Lifecycle atomicity:** central `transition()` locks content, validates the current state, updates lifecycle fields, scores visible content, and writes audit history in the caller's transaction. Concurrent approval coverage already exists.
- **Designer edits:** F-002 adds a conditional transaction-first content claim for assets and tags, preventing post-submit mutation.
- **Downloads:** event insertion and counters are one data-modifying CTE, and counters use atomic SQL increments. F-005 remains because the idempotency claim is outside that atomic unit.
- **Reporting threshold:** threshold evaluation locks content and counts open reports before applying the hold, preventing lost threshold transitions. F-006 remains for the per-user rate quota.
- **Report decisions:** F-003 serializes decisions on content and rechecks the report under lock.
- **Role changes:** role mutation, audit, session revocation, and cache invalidation follow the intended privileged path. F-007 remains the provider identity constraint gap.
- **Scheduled jobs:** a separate process plus advisory locking protects overlapping manual/scheduled runs. Job runs record success/failure and catch-up logic is present.
- **Rollups:** upsert/prune are individually idempotent and tests describe expected convergence; F-008 is the non-atomic pair.
- **Migrations and destructive helpers:** production migrations are explicit; test helpers require a database name ending in `_test`. Empty-database migration verification was blocked because no authorized test connection was available.
- **Indexes/constraints:** feed/search/report/content query indexes and key ownership/uniqueness constraints were inspected. The material missing constraint is F-007.

## 9. Verification results

| Command/test | Baseline result | Final result | Notes |
|---|---|---|---|
| `git status --short --branch` | Pass: clean `main...origin/main` | Expected dirty local fix branch | No pre-existing user changes; final status is listed below. |
| `bun install --frozen-lockfile` | Pass after sandbox cache access was allowed | Pass: 1,028 installs checked across 1,138 packages, no changes | Installed Bun is 1.2.19, not repository-pinned 1.3.10. Lockfile unchanged. |
| `bun run db:up` | Blocked: Docker daemon/service stopped | Not rerun; service remained stopped | No volumes or databases were changed. |
| `bun run db:migrate:test` | Not run during initial baseline | Blocked: `TEST_DATABASE_URL` unset | Local PostgreSQL rejected documented dev credentials; no private credential probing. |
| `bun run check-types` | Pass | Pass | Server, web, and shared UI type checks all exited 0. |
| Repository-wide `bunx biome check apps/server apps/web packages/auth packages/db packages/env packages/ui` | Fail: 166 pre-existing errors, predominantly CRLF formatting | Fail: 161 pre-existing errors | No broad formatting rewrite. |
| Targeted Biome over all changed source/test files | N/A | Pass: 12 files, no diagnostics | Report is Markdown and not in the TypeScript Biome set. |
| Initial focused CSRF/date tests | Red: 2 missing-module errors before implementation | Pass: 6 tests, 11 assertions | Demonstrates the TDD red/green boundary. |
| Focused library suite | N/A | Pass: 28 tests, 43 assertions | Errors, pagination, CSRF, and strict date suites. |
| Composed-app CSRF regression | N/A | Pass: 1 test, 2 assertions | Uses `createApp().handle()` and a form-encoded role-assignment request. |
| Real listening-server CSRF request | N/A | Pass: HTTP 403 plus correct error envelope | Used an ephemeral port and temporary process environment; no `.env` change. |
| `bun run test` | Blocked/fail: 32 pass, 55 fail, 16 load errors | Blocked/fail: 38 pass, 56 fail, 16 load errors | Primary cause is missing `TEST_DATABASE_URL`/server env; Bun 1.2.19 then emits cascading initialization errors. New database-backed race tests were not falsely claimed as passing. |
| `bun run --filter server build` | Fail: tsdown could not import `unrun` | Same failure | Consistent with local toolchain/dependency resolution mismatch; no source diagnostic emitted. |
| `bun run --filter web build` | Blocked: `NEXT_PUBLIC_SERVER_URL` unset | Pass with temporary `http://localhost:3000` value | Next.js 16.3 production build compiled, typechecked, and generated all 14 routes. |
| `git diff --check` | N/A | Pass | Only Git's local CRLF conversion warnings; no whitespace errors. |
| Feed/search benchmark | Not run | Not run | No feed/search/ranking query changed, and the required test database was unavailable. |
| Docker build | Not run | Not run | Docker daemon stopped and Dockerfiles were deliberately left unchanged. |

## 10. Final diff inventory

| File | Type | Finding | Reason |
|---|---|---|---|
| `apps/server/src/app.ts` | Production code | F-001 | Composes the CSRF plugin at the custom API boundary. |
| `apps/server/src/lib/csrf.ts` | Production code | F-001 | Implements the pure unsafe-cookie-origin decision. |
| `apps/server/src/lib/csrf-plugin.ts` | Production code | F-001 | Adapts the decision to Elysia with configured trusted origins. |
| `apps/server/src/lib/csrf.test.ts` | Test | F-001 | Covers cross-site, missing-origin, trusted-origin, bearer, and safe-method behavior. |
| `apps/server/src/lib/csrf-app.test.ts` | Test | F-001 | Proves the composed app blocks a form-encoded privileged mutation. |
| `apps/server/src/lib/iso-date.ts` | Production code | F-004 | Provides canonical calendar-date validation. |
| `apps/server/src/lib/iso-date.test.ts` | Test | F-004 | Covers leap days, normalized overflow dates, and malformed forms. |
| `apps/server/src/modules/analytics/routes.ts` | Production code | F-004 | Uses the strict shared validator. |
| `apps/server/src/modules/content/designer-routes.ts` | Production code | F-002 | Adds transaction-first editable row claims for assets and tags. |
| `apps/server/src/modules/moderation/reports.ts` | Production code | F-003 | Locks shared content and rechecks the report inside the transaction. |
| `apps/server/test/analytics.test.ts` | Test | F-004 | Adds an API regression for `2026-02-31`. |
| `apps/server/test/adversarial.test.ts` | Test | F-002, F-003 | Adds deterministic asset/submit racing and distinct-report opposing decisions. |
| `GREETINGS_REVIEW.md` | Documentation | All | Records findings, decisions, evidence, limitations, and follow-up. |

No secret, `.env`, migration, generated build artifact, dependency update, lockfile churn, user-owned change, broad formatting rewrite, or unrelated refactor is included. Nothing is staged or committed.

## 11. Recommended follow-up

### Must fix before launch

1. Resolve F-005 with an atomic idempotency/event/counter design and failure-injection tests.
2. Resolve F-007 after auditing duplicate provider identities, then verify both empty and upgrade migrations.
3. Resolve F-009 and build/run both production images under Docker, including health checks and file permissions.
4. Run the complete suite on Bun 1.3.10 against a disposable migrated PostgreSQL test database. Repeat the new F-002/F-003 concurrency tests enough times to detect flakiness.
5. Treat the currently unexecuted database regressions as a launch gate, not as assumed passes.

### Should fix soon

1. Resolve F-006 with per-reporter serialization or an atomic durable quota.
2. Wrap F-008's rollup upsert/prune pair in one transaction with rollback coverage.
3. Clean or ratchet web/UI Biome debt, then resolve F-010 by adding web checks/build to CI.
4. Align every local/build environment to Bun 1.3.10 so build failures are reproducible rather than version-dependent.

### Future scale work

- Add a distributed session/rate-limit invalidation mechanism only before horizontal API scaling.
- Revisit download-event partitioning and platform-count caching at the documented scale ceilings, not preemptively.
- Use production query plans and relevance data before changing feed/search ranking SQL.

### Product decisions needed

- Decide whether the super-admin dashboard should expose the existing by-content and by-region analytics endpoints.
- At Phase 3 start, choose the Firebase mobile sign-in UX and remove/replace the incompatible email/password scaffold screens.
- Decide whether image transformation/moderation becomes a platform requirement based on real bandwidth, safety, and device evidence.

### Intentionally deferred Phase 3 work

- Mobile onboarding, feed, search, download/share, and report screens.
- Notifications, response localization, download history, backend image processing, and other explicitly excluded product scope.

These are not defects in the reviewed Phase 1/2 repository and should not be mixed into the launch-fix branch without an approved product plan.

---

## 12. Resolution (follow-up pass)

The findings above were verified against a running PostgreSQL, which the
original pass could not reach. All four fixes were confirmed genuine: reverting
each one makes its regression test fail, and the CSRF finding was confirmed by
exploit — a cross-site form promoted an account to `super_admin`, and the same
request returns 403 after the fix. Full suite: 476 passing.

Every deferred finding has since been closed, with three corrections:

| ID | Original status | Now | Correction |
|---|---|---|---|
| F-005 | Deferred, Medium | **Fixed** | Understated. Beyond the failure window, reusing one key for different content deterministically returned the *wrong image*, uncounted. Claim, event and counters are one statement; cross-content reuse is a 409. |
| F-006 | Deferred | **Fixed** | Confirmed by test: a burst of 30 concurrent reports all committed against a limit of 20. Advisory lock keyed per reporter. |
| F-007 | Deferred, "duplicate rows" | **Fixed** | Misdiagnosed. Duplicate rows do not occur — `user.email` is unique and blocks them. The real defect is that concurrent first sign-in returns **500** to all but one caller. Adding the recommended index alone would have swapped one 500 for another; the fix is the index *plus* retrying the lookup. |
| F-008 | Deferred | **Fixed** | Upsert and prune now share a transaction. |
| F-009 | Deferred | **Fixed** | Bun pinned to 1.3.10, `--frozen-lockfile`, non-root runtime. Both images built and run: server reaches the database and serves health/readiness, web serves its routes, both as uid 10001. |
| F-010 | Deferred | **Fixed** | The stated blocker does not exist in this repository. Biome reports **0** findings in `apps/web` and 4 in `packages/ui` scaffold — not 161. The CRLF debt appears to have been an artefact of the reviewing environment. CI now lints `apps/web`, builds it, and runs the query-count benchmark. |

One finding the review missed: it exempted `/api/auth/*` from the CSRF guard on
the grounds that Better Auth owns that contract. It does not check request
origin — a cross-site sign-out was accepted. The exemption has been removed and
sign-in, the OAuth callback and bearer clients were each verified unaffected.
