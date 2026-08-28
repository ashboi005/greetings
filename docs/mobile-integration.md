# Greetings — mobile integration guide

For the developer building the React Native app.

This is **not** the API contract. The generated OpenAPI document at **`/docs`** on the running
server is the contract: every path, every request and response schema, every field type, generated
from the code itself so it cannot drift. Open it first and keep it open.

This document is the part `/docs` cannot tell you — the order to call things in, what the values
mean, and the handful of decisions that will bite you if you guess. Where the two disagree, `/docs`
is right and this file is stale; please say so.

---

## 1. Ground rules

**Base URL.** Everything lives under `/v1`. Production is `https://greetings-api.ashwathsoni.dev`.
Put it in `EXPO_PUBLIC_SERVER_URL` — `packages/env/src/native.ts` already expects that name.

**Auth is a bearer token.** Send `Authorization: Bearer <token>` on every request except
`POST /v1/auth/firebase` and the three reference lists in §3, which are public. The app has no
cookie jar and needs none. Everything the panels do with cookies is irrelevant to you.

**The API never returns image bytes.** Not on any endpoint. Images are served from a Cloudflare CDN
in front of R2, and the API only ever hands you URLs. This keeps image traffic off the server
entirely. **Displaying and saving use different URLs — read §8 before building the feed.**

**Every error looks the same:**

```json
{ "error": { "code": "NOT_FOUND", "message": "No such content.", "details": null } }
```

Branch on `code`, never on the message text — messages are written for humans and will be reworded.

| `code` | HTTP | What it means for you |
|---|---|---|
| `BAD_REQUEST` | 400 | You sent something the handler rejected. Fix the call. |
| `UNAUTHENTICATED` | 401 | No token, or it expired or was revoked. Send them to sign-in. |
| `FORBIDDEN` | 403 | Signed in, wrong role. Should never happen in the app. |
| `NOT_FOUND` | 404 | Gone, or never published. |
| `CONFLICT` | 409 | Already done, or not allowed in this state. Usually not an error to show. |
| `UNPROCESSABLE` | 422 | Schema validation failed. `details` lists the fields. Fix the call. |
| `RATE_LIMITED` | 429 | Back off — see §10. |
| `INTERNAL` | 500 | Ours. Retry once, then show a generic failure. |

A `422` and a `400` both mean *you* got it wrong, but `422` is the schema layer, so `details` names
the offending field — that is the one to read when a request mysteriously fails.

---

## 2. Authentication

The server does not implement phone OTP. **Firebase does**, on the device, and then you trade the
result for a session here. The server's only job is verifying that the Firebase token is genuine.

```
┌─ device ──────────────────────┐        ┌─ our API ──────────────────┐
│ Firebase phone or Google      │        │                            │
│ sign-in completes             │        │                            │
│   ↓                           │        │                            │
│ Firebase ID token ────────────┼───────▶│ POST /v1/auth/firebase     │
│                               │        │  verifies signature vs     │
│                               │        │  Google's public JWKS      │
│                               │        │  finds or creates the user │
│ session token ◀───────────────┼────────┤  returns a session         │
│   ↓                           │        │                            │
│ store it, send as Bearer      │        │                            │
└───────────────────────────────┘        └────────────────────────────┘
```

### `POST /v1/auth/firebase`

The only endpoint that both writes and needs no token.

```jsonc
// request
{ "idToken": "<the Firebase ID token from the device SDK>" }

// response 200
{
  "token": "…",                       // send as Authorization: Bearer <token>
  "user": { "id": "…", "email": "…", "name": "…", "role": "user" },
  "onboarded": false,                 // ← routing decision, see §3
  "created": true                     // true only on the very first sign-in
}
```

Notes that matter:

- **`onboarded` is your router.** `false` means the user has no region yet and must go through
  onboarding before the feed is worth showing. Do not use `created` for this — a user who installed
  the app, signed in, and killed it during onboarding comes back with `created: false` and
  `onboarded: false`, and sending them to the feed would show them a bare global feed forever.
- **Phone-only users have a placeholder email**, shaped `<firebase-uid>@firebase.placeholder`. It is
  a real value in a required field, not a bug. Never display it. Use `displayName` from the profile,
  falling back to the phone number.
- **`role` will be `user`** for everyone in the app. Designers and admins use the web panels; the
  app has no screens for them.
- **Accounts link automatically.** Signing in with Google and later with the same phone number
  resolves to one account, so you do not need an account-linking flow.

### Keeping the session

Store the token in secure storage (`expo-secure-store`). It is an opaque database key, not a JWT —
do not try to decode it for an expiry.

Expiry is not explicitly configured, so it is Better Auth's default and should be treated as an
implementation detail. **Handle it operationally instead:** a `401` with code `UNAUTHENTICATED` on
*any* request means the session is gone. Clear the stored token and route to sign-in. A single
interceptor doing that is the whole session-management story.

Sessions are also revoked server-side when an admin changes a user's role or resets a password, so
`401` is not always an expiry — treat all cases the same.

**Signing out** is discarding the stored token. There is no endpoint you need.

### `GET /v1/auth/me`

Returns `{ id, email, name, role }` for the current token. Useful as a cheap "is this token still
good" check on cold start, but §3's `GET /v1/me/profile` returns strictly more and answers the
routing question too — prefer that one and skip this.

---

## 3. Profile and onboarding

Onboarding is **not** cosmetic, which is worth knowing because it affects how hard you should push
users through it. The region chosen here is stamped onto every download event for analytics, and
region plus languages are two of the three ranking signals in the feed. **A user who skips
onboarding gets only global content, ranked by recency and popularity alone.** The feed will not be
empty, but it will not be personalised either.

### Reference data — the pickers

Three lists. **All three are public — no token required**, which is the exception to §1's rule and
deliberate: it means you can prefetch the pickers on the splash screen, before the user has signed
in, so onboarding renders instantly the moment they arrive.

| Endpoint | Returns |
|---|---|
| `GET /v1/regions` | `[{ code: "IN-MH", name: "Maharashtra" }]` — 36 Indian states and UTs |
| `GET /v1/languages` | `[{ code: "hi", name: "Hindi", nativeName: "हिन्दी" }]` — 23 languages |
| `GET /v1/tags` | `[{ id, slug, label, category }]` — 38 tags, for search filters |

`GET /v1/tags?category=festival` narrows it. Categories are `festival`, `language`, `region`,
`theme`, `occasion`.

Two things about these:

- **Show `nativeName`, not `name`.** The audience is older users picking their own language. "हिन्दी"
  is recognised instantly; "Hindi" is a word in a foreign script. Use `name` only for search
  matching and for your own debugging.
- **They are cached, so just fetch them.** All three send
  `Cache-Control: public, max-age=300, stale-while-revalidate=3600`. Let the HTTP layer do its job
  rather than building your own cache. They change rarely, but admins *can* now edit them from the
  panel, so do not bake them into the bundle.

Retired entries are filtered out server-side, so anything you receive is safe to display.

### `PUT /v1/me/profile` — complete onboarding

One call does the whole thing. It is also the "edit my profile" endpoint — same route, same body.

```jsonc
{
  "regionCode": "IN-MH",          // required, from GET /v1/regions
  "languages": ["hi", "mr"],      // required, 1–10 codes from GET /v1/languages
  "displayName": "Ashwath"        // optional, 1–80 chars
}
```

Returns `{ "ok": true }`.

- **`languages` is a full replacement**, not a merge. To remove one, send the array without it.
- **Multiple languages are normal and encouraged.** Someone in Maharashtra plausibly wants Marathi
  and Hindi. Each matching language is worth the same ranking bonus, so more selections means a
  richer feed — a multi-select, not a radio group.
- **The two failure statuses differ, which is worth knowing before you write the error handler.**
  An unknown `regionCode` is a **`404 NOT_FOUND`**; an unknown language code is a **`400
  BAD_REQUEST`** listing the offending codes. Both mean "that code does not exist" — handle them the
  same way and just show the message.
- **A retired code is still accepted here.** If an admin retires a region or language after someone
  chose it, the picker stops offering it but saving the profile keeps working, so an existing user
  is never locked out of editing their own name.
- Re-calling it later is a profile edit. The original onboarding timestamp is preserved server-side;
  you are not re-onboarding anyone.

### `GET /v1/me/profile`

```jsonc
{
  "displayName": "Ashwath" | null,
  "phone": "+9198…" | null,
  "regionCode": "IN-MH" | null,
  "languages": ["hi", "mr"],
  "onboarded": true
}
```

**Call this on every cold start.** It answers "is the token valid" (401 if not) and "where do I
route" (`onboarded`) in one request, and gives you everything the profile screen needs.

---

## 4. The feed

### `GET /v1/feed?cursor=&limit=`

`limit` defaults to **20** and caps at **50**.

```jsonc
{
  "items": [
    {
      "id": "…",
      "title": "Good Morning",
      "description": "…" | null,
      "primaryLanguage": "hi",
      "regionCode": "IN-MH" | null,     // null = global content
      "downloadCount": 128,
      "publishedAt": "2026-08-19T…",
      "designer": { "id": "…", "name": "…" },
      "storageKey": "content/…/….webp" | null,  // object key; useful as a cache key
      "imageUrl": "https://cdn…/content/…/….webp" | null  // ← what you display. §8.
    }
  ],
  "nextCursor": "…" | null              // null means you have reached the end
}
```

### How ranking works, and why you should care

```
score = 2.0 × (content language is one of mine)
      + 1.5 × (content region is my region)
      + 1.0 × (content region is null, i.e. global)
      + recency decay (7-day half-life)
      + 0.5 × ln(1 + downloads in the last 7 days)
```

The one consequence for the UI: **the global term guarantees the feed is never empty.** Every global
item scores at least 1.0 before recency, so a user in a region with no local content still gets a
full feed. You do not need an empty state for "nothing in your region" — only for genuine
end-of-list.

### Paging

Pass `nextCursor` back as `cursor`. Stop when `nextCursor` is `null`.

**The ordering is stable within a session**, and this is a real guarantee, not a hope. The ranking
score is stored on the row and recomputed by a nightly job, not calculated from `now()` per request
— so it does not drift between page 1 and page 2. Items will not repeat or be skipped mid-scroll.

Practical rules:

- **Never pass a page number.** There is no offset pagination anywhere in this API.
- **Never hand-build or parse a cursor.** It is opaque; a malformed one is a `400`.
- **Pull-to-refresh means dropping the cursor**, not reusing it — start a fresh page 1.
- **Do not persist a cursor across app launches.** It stays valid, but overnight the nightly rescore
  moves things and you would resume into a stale position. Refetch from the top.

---

## 5. Search

### `GET /v1/search?q=&tags=&language=&region=&cursor=&limit=`

Same item shape as the feed, plus a `rank` number. Same cursor rules.

| Param | Notes |
|---|---|
| `q` | Free text, max 100 chars. **Optional.** |
| `tags` | Comma-separated **tag ids** — the `id` from `GET /v1/tags`, not the slug or the label |
| `language` | A language code |
| `region` | A region code |

Two design points:

- **Omit `q` to browse by filters alone.** Tag-only browsing — "show me all Diwali" — is the same
  endpoint with no `q`. You do not need a separate browse API, and for this audience tapping a
  festival tile will be far more used than typing.
- **Misspellings still work.** There is a trigram fuzzy fallback behind the full-text match, so
  "diwlai" finds Diwali. Do not build client-side spell correction.

Results are ranked by text relevance then recency — deliberately *not* by the personalised feed
score, because someone who typed a word wants that word, not what we think they like.

---

## 6. Downloading an image

This is the most important endpoint in the app and the one with real rules.

### `POST /v1/content/{id}/download`

```jsonc
// headers
{ "Idempotency-Key": "<a fresh uuid per download attempt>" }   // optional but do send it

// body — entirely optional
{ "source": "feed" }        // "feed" | "search" | "detail"; defaults to "detail"

// response 200
{
  "url": "https://cdn.example.com/content/…/….webp",
  "expiresInSeconds": null,   // null = permanent CDN url, safe to cache
  "recorded": true            // false when an idempotency replay returned a stored url
}
```

**Check `expiresInSeconds`.** `null` means a CDN URL that never expires — fetch the bytes, save them
locally, and reuse the local file forever. A **number** (300) means this deployment has no CDN and
the URL is signed and dies in five minutes — fetch immediately and never store the URL. See §8.

**Send `Idempotency-Key`.** A fresh UUID per *attempt* — the same value if the user retries after a
timeout, a new one when they deliberately download again. Within a 60-second window, reusing a key
returns the same URL and does not count a second download. This is what makes retries on a flaky
connection safe, which matters a lot on the connections this audience has. Reusing one key for a
*different* content id is a `409`.

**Set `source` honestly** (`feed`, `search`, or `detail`). It is the only signal designers get about
where their work is found, and it feeds their analytics.

**This endpoint is the only way to get image bytes**, which is exactly why download counts can be
trusted — the objects are not publicly reachable, so nothing can be hotlinked around the counter.

Rate limit: **120 per minute per user**. Generous for real use; you will only hit it with a bug.

---

## 7. Reporting content

### `POST /v1/content/{id}/report`

```jsonc
{
  "reason": "inappropriate",   // inappropriate | copyright | spam | wrong_info | other
  "note": "optional, ≤1000 chars"
}
```

Returns `{ id, status, heldForReview }`.

- **One open report per person per item.** A second is a `409` — treat it as success in the UI
  ("thanks, you have already reported this") rather than an error. Nothing has gone wrong.
- **`heldForReview: true`** means this report crossed the threshold (5 reports) and the content is
  now hidden pending an admin decision. Worth acknowledging warmly; the user just did something.
- Limit: **20 reports per hour per user.**

Content that gets held disappears from the feed on the next fetch. If the user is still looking at
it, the download call returns **`409 CONFLICT`** — "This content is not available for download" —
not a `404`, because the item exists but is not downloadable in its current state. Handle it as
"this is no longer available" and pop the screen; it is a normal race, not a crash.

---

## 8. Images: displaying vs saving

Two different URLs, for two different jobs. Get this right and the feed is cheap; get it wrong and
you either destroy the download analytics or make the app unusable on a 3G connection.

### Displaying — use `imageUrl`, free and uncounted

Every feed and search item carries **`imageUrl`**: a permanent, public CDN URL for the full-size
image, served from Cloudflare's edge.

```jsonc
{
  "storageKey": "content/9f2…/a71….webp",
  "imageUrl":   "https://cdn.example.com/content/9f2…/a71….webp"
}
```

**Never render `imageUrl` as-is in a list.** It is the full-size original, and a grid of them will
burn a user's data and stall the scroll. Ask Cloudflare for a resized copy instead.

The transform is a **path prefix**, inserted between the origin and the object path — *not* a query
string. `?width=400` is silently ignored and you get the full-size image back, which is the failure
mode to watch for, because it looks like it works:

```
https://cdn.example.com/cdn-cgi/image/width=400,format=auto/content/9f2…/a71….webp
                        └──────────── inserted ────────────┘
```

Build it from `imageUrl` with `URL`, not string concatenation:

```ts
/** A resized copy of a CDN image. `opts` is Cloudflare's comma-separated list. */
export function transform(imageUrl: string, opts: string): string {
  const u = new URL(imageUrl);
  return `${u.origin}/cdn-cgi/image/${opts}${u.pathname}`;
}

const thumb = (url: string, width: number) =>
  transform(url, `width=${Math.round(width * PixelRatio.get())},format=auto,quality=80`);

<Image source={{ uri: thumb(item.imageUrl, 180) }} />
```

**Use `format=auto`, not `format=webp`.** Measured on the live CDN: `format=webp` was ignored and
returned JPEG, while `format=auto` returned WebP to a client whose `Accept` header offers it. React
Native sends a suitable `Accept` header, so `auto` gets you WebP on Android and a sensible fallback
elsewhere.

Useful options: `width`, `height`, `quality` (1–100), `format=auto`, `fit=scale-down|contain|cover`.
`fit=scale-down` never enlarges, which is what you want for thumbnails.

Real numbers from the current bucket, for a 15956-byte source:

| Options | Result |
|---|---|
| none (original) | 15956 B |
| `width=100,format=auto` | **2390 B** |
| `width=400,format=auto` | 15058 B |
| `width=400,format=auto,quality=80` | 12524 B |

Ask for roughly the pixel width you will actually paint — multiply by `PixelRatio.get()`. Two or
three fixed sizes across the whole app cache far better at the edge than a size computed per device;
the first request for a given size pays for the transform and every later one is a cache hit.

`imageUrl` is `null` when a deployment has no CDN configured — local development against a dev
server, for example. Render a placeholder rather than crashing; do not construct a URL yourself.

**Browsing costs nothing and counts nothing.** Fetching `imageUrl` never touches our API, so scroll
as freely as you like. There is a test asserting that paging the feed records zero downloads.

### Saving — call the download endpoint, once

When the user actually taps download or share, call `POST /v1/content/{id}/download` (§6). That is
the call that records the download, credits the designer, and feeds their analytics.

It returns a CDN URL too — the same permanent one — with **`expiresInSeconds: null`**, meaning it
does not expire and the file is safe to cache on the device forever. Fetch the bytes once, save
locally, and if the user re-opens the same image later, use the local copy rather than calling again.

```jsonc
{ "url": "https://cdn.example.com/content/…webp", "expiresInSeconds": null, "recorded": true }
```

If `expiresInSeconds` comes back as a **number** (300), this deployment has no CDN and the URL is a
signed one that dies in five minutes — fetch it immediately and do not cache the URL. Branch on
`expiresInSeconds === null`, not on the URL's shape.

### The rule in one line

**Scrolling uses `imageUrl`. Tapping download calls the download endpoint.** One is display and is
free; the other is an event we count. Do not call the download endpoint to render a tile, and do not
save an image without calling it.

### Honest caveat

Because the bucket sits behind a public CDN, anyone who knows an object key can fetch it without
going through the counted endpoint. That is a deliberate trade — cached, resizable images are worth
far more on Indian mobile connections than a counter nobody is trying to evade — but it means the
download count is accurate for well-behaved clients rather than enforced. Please keep the app
well-behaved: it is the only client.

Moderation is *not* affected: a removed or held item still returns `409` from the download endpoint,
and it drops out of the feed, so no new `imageUrl` is handed out for it.

---

## 9. First-launch sequence

```
cold start
   │
   ├─ no stored token ──▶ Firebase sign-in ──▶ POST /v1/auth/firebase ──▶ store token
   │                                                    │
   └─ stored token ─────────────────────────────────────┤
                                                        ▼
                                          GET /v1/me/profile
                                           │           │
                                 401 ──────┘           └────▶ 200
                                  │                            │
                          clear token,                 onboarded === false
                          back to sign-in                  │         │
                                                          yes        no
                                                           │         │
                                              GET /v1/regions   ┌────▼────┐
                                              GET /v1/languages │  feed   │
                                                   │            └─────────┘
                                          PUT /v1/me/profile
                                                   │
                                                   ▼
                                                 feed
```

`GET /v1/regions` and `GET /v1/languages` need no token, so prefetch them on the splash screen
rather than after sign-in — they are cached and tiny, and having them ready makes onboarding feel
instant on a slow connection.

---

## 10. Rate limits

| Endpoint | Limit |
|---|---|
| `POST /v1/auth/firebase` | 600 / minute per IP, 6000 / minute overall |
| `POST /v1/content/{id}/download` | 120 / minute per user |
| `POST /v1/content/{id}/report` | 20 / hour per user |

The sign-in limit is per IP and deliberately loose because Indian carriers use carrier-grade NAT —
thousands of genuine users share one address. You will not hit these in normal use.

There is **no `Retry-After` header**. On a `429`, back off ~30 seconds and retry once; do not loop.

---

## 11. Things not to build

Each of these is already handled, and duplicating it will cause bugs:

- **Client-side spell correction** — the search endpoint has a fuzzy fallback.
- **A tags/languages/regions cache** — HTTP caching headers are already set, and admins now edit
  these lists at runtime, so a baked-in copy will go stale.
- **Account linking UI** — sign-ins linked by verified email or phone resolve to one account.
- **Deduplication while paging** — the cursor guarantees no repeats within a session.
- **A download counter** — `downloadCount` on the item is authoritative; do not increment locally.
- **Role handling** — every app user is `role: "user"`.

## 12. Things that genuinely do not exist

So you do not go looking:

- **No push notifications.** No device token registration endpoint.
- **No favourites, collections, or history.** Downloads are recorded for analytics, but there is no
  endpoint to read a user's own download history back.
- **No following a designer**, no comments, no likes, no sharing counters.
- **No account deletion endpoint.**
- **No server-side image processing.** No resizing pipeline, no stored thumbnail variants, no format
  conversion in the backend. Resizing happens at the CDN edge from query parameters you add — see
  §8. There is nothing to request and nothing to wait for.

If the app needs any of these, they are backend work, not something to work around on the client.
Ask.

---

## Questions

Open `/docs` first — it answers most field-level questions definitively. For anything about *why*
something behaves as it does, `docs/specs/greetings-backend.md` is the full backend spec; §7 covers
feed ranking and §12 covers limits and behaviour under load.
