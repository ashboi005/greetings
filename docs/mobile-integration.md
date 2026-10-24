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

**Firebase is the app's only login.** Three methods — phone OTP, email and password, Google — and
all three are Firebase's. There is **no Better Auth client in the app**; the panels have one, you do
not. Note that means the app's email-and-password sign-in is Firebase's, not the panels': they are
separate account systems that happen to look alike. If you find `better-auth` in a diff touching
`apps/native`, it is a mistake. See §2.

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
| `RATE_LIMITED` | 429 | Back off — see §13. |
| `INTERNAL` | 500 | Ours. Retry once, then show a generic failure. |

A `422` and a `400` both mean *you* got it wrong, but `422` is the schema layer, so `details` names
the offending field — that is the one to read when a request mysteriously fails.

---

## 2. Authentication

The server implements no sign-in of its own. **Firebase does**, on the device, and then you trade the
result for a session here. The server's only job is verifying that the Firebase token is genuine.

**Three methods, one exchange.** Phone OTP, email and password, and Google. They differ only on the
device; all three end in a Firebase ID token, and from there the path is identical.

```
┌─ device ──────────────────────┐        ┌─ our API ──────────────────┐
│ phone OTP ─┐                  │        │                            │
│ email/pw ──┼─ Firebase        │        │                            │
│ Google ────┘  sign-in         │        │                            │
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

| Method | State today |
|---|---|
| Email and password | Complete. Requires a confirmed address — see below |
| Google | Complete. Needs the Google provider enabled in Firebase, then both config files re-downloaded |
| Phone OTP | Complete in code, but **only test numbers work** until the per-platform verification is set up — `TODO(phone-native-setup)` in `lib/firebase.ts`, steps in firebase-setup.md §2.5–2.6 |

The Firebase ID token is used **once**, for this exchange, and then discarded. It is not the bearer
token — do not send it on other requests, and do not try to refresh it. What you keep is the session
token this endpoint returns.

That indirection is deliberate. A Firebase ID token expires after an hour and cannot be withdrawn
early, whereas a session issued here is revoked the moment an admin changes someone's role or resets
their password. It also means the app never needs a refresh loop.

### Which SDK, and what that costs you

`@react-native-firebase/app`, `@react-native-firebase/auth` and
`@react-native-google-signin/google-signin` — native modules, so:

- **The app cannot run in Expo Go.** Use `bunx expo prebuild` and a dev client.
- Two config files must be present before a build: `apps/native/google-services.json` and
  `apps/native/GoogleService-Info.plist`. `expo prebuild` fails without them.
- `apps/native/.env` takes `EXPO_PUBLIC_SERVER_URL` and nothing else. There are **no Firebase
  variables at all**: `app.config.ts` reads what Google sign-in needs straight out of the two
  config files, so there is no copy to keep in sync.

The JS `firebase` package is the wrong choice here: its phone flow is built on reCAPTCHA in a
WebView. **[docs/firebase-setup.md](./firebase-setup.md) is the full runbook** — console steps,
signing fingerprints, APNs, and the test numbers you should be developing against.

### The device half

`apps/native/lib/firebase.ts` is the only file that talks to Firebase:

```ts
// phone
toE164("98765 43210")             // → "+919876543210", or null if unusable
sendVerificationCode(e164)        // → { phoneNumber, confirm(code) → idToken }

// email
signInWithEmail(email, password)  // → idToken, or throws EmailNotVerifiedError
signUpWithEmail(email, password)  // creates, mails the link, signs out again
resendEmailVerification(email, password)
sendPasswordReset(email)

// google
isGoogleSignInAvailable()         // false when the web client ID is unset
signInWithGoogle()                // → idToken, or null if the picker was dismissed

signOutOfFirebase()
```

Every one of those ID tokens goes to the same place: `signInWithFirebaseToken` in
`contexts/auth-context.tsx`. Failures arrive as `FirebaseAuthError` with a message already fit to
show someone — Firebase's own `auth/*` codes belong in a log, not on a screen. Use
`authErrorMessage` from `lib/auth-errors.ts` in a screen; it covers both these and the API's
envelope.

The UI is one component per method under `components/auth/`, with `app/(auth)/sign-in.tsx` as a
shell that switches between them. They share nothing but the token they produce.

**Three things that look optional and are not.**

`toE164` defaults a bare 10-digit number to +91, because people type their number the way they say
it and Firebase rejects anything that is not E.164. An explicit `+` always wins, so someone abroad
is never rewritten.

`signInWithGoogle()` resolving to **null means the picker was dismissed** — the most common way it
ends. Do not show that as an error.

`signOutOfFirebase` runs on every sign-out, because a lingering Firebase `currentUser` can mint a
fresh ID token that the exchange would honour — a signed-out app quietly signing itself back in. It
signs out of Google too, or the next sign-in silently reuses the same account without showing the
picker, which reads as "I can't switch accounts".

### Email sign-in requires a confirmed address

`signUpWithEmail` creates the account, has Firebase mail the link, and signs straight back out. No
session is issued until the address is confirmed; `signInWithEmail` throws `EmailNotVerifiedError`
until then, which the screen turns into "check your inbox" with a resend rather than a red field.

This is load-bearing, not politeness. The server stores `<firebase-uid>@firebase.placeholder` for
any identity whose email it cannot trust and only links accounts on a verified one — that stops
anyone claiming someone else's account by signing up with their address. An unconfirmed account
would therefore land with a placeholder email and be unfindable by the address its owner typed.

Firebase sends the mail, so it costs us no email infrastructure.

### Development without an SMS

A dev build's sign-in screen has a *Development only* panel that takes a pasted Firebase ID token
straight to the exchange. It is compiled out of release builds — `__DEV__` is statically false, so
the component is dropped rather than hidden behind a flag.

Prefer Firebase's **test phone numbers** (firebase-setup.md §2.7) for day-to-day work: a fixed code,
no SMS, works in the simulator, costs no quota.

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
  falling back to the phone number. Email and Google users have their real address, because both are
  verified before they get this far.
- **`role` will be `user`** for everyone in the app. Designers and admins use the web panels; the
  app has no screens for them. The panels' own login cannot produce a `user` account — the route
  that creates password accounts refuses that role — so the two populations cannot cross over.
- **Accounts link automatically.** A verified email or a phone number matching an existing account
  resolves to one user, so you do not need an account-linking flow. Someone who signs up by email
  and later taps *Continue with Google* with the same address gets their existing account, role and
  history — not a second one.

### Keeping the session

Store the token in secure storage (`expo-secure-store`) — `lib/storage.ts` does, with a memory
fallback so the web target does not crash. It is an opaque database key, not a JWT; do not try to
decode it for an expiry.

Expiry is not explicitly configured, so it is the session store's default and should be treated as an
implementation detail. **Handle it operationally instead:** a `401` with code `UNAUTHENTICATED` on
*any* request means the session is gone. Clear the stored token and route to sign-in. The axios
response interceptor in `lib/api.ts` does exactly that, and it is the whole session-management story.

Sessions are also revoked server-side when an admin changes a user's role or resets a password, so
`401` is not always an expiry — treat all cases the same.

**But only a 401 means that.** A timeout or a 500 on the cold-start profile read means the network
is bad, not that the session died; signing the user out there logs people out for being on a train.
`readProfile` in `contexts/auth-context.tsx` separates the two, and only the first signs out.

**Signing out** is discarding the stored token, signing out of Firebase, and clearing the react-query
cache. There is no endpoint you need. Skipping the cache clear is how the next person to sign in on
that device sees the previous user's feed, downloads and designs.

### Where the redirects live

One place: the guard effect in `contexts/auth-context.tsx`. Screens do not navigate on sign-in or
sign-out. Three inputs decide it — is there a token, is the profile onboarded, has the root navigator
mounted — and a screen holding only one of them will guess wrong about the others.

| State | Lands on |
|---|---|
| No token | `/(auth)/sign-in` |
| Token, `onboarded: false` | `/(onboarding)` |
| Token, onboarded, sitting in `(auth)` or finished onboarding | `/(drawer)/(tabs)` |

If you need a new gated route group, add it to that table and that effect, not to a screen.

### `GET /v1/auth/me`

Returns `{ id, email, name, role }` for the current token. Useful as a cheap "is this token still
good" check on cold start, but §3's `GET /v1/me/profile` returns strictly more and answers the
routing question too — prefer that one and skip this.

---

## 3. Profile and onboarding

**First, a distinction that will otherwise bite you.** Screen 1's English/Hindi choice is the *app's
own* language — pure client-side i18n, no endpoint, nothing stored on the server. The `languages` in
this section are the languages of *content the user wants to see*, and they drive feed ranking. A
user can read the app in English and want Marathi greetings. Never send one as the other.

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
  "regionCode": "IN-MH",                  // required, from GET /v1/regions
  "languages": ["hi", "mr"],              // required, 1–10 codes from GET /v1/languages
  "displayName": "Ashwath",               // optional, 1–80 chars
  "designation": "Property Consultant",   // optional, ≤80 — printed on shared graphics
  "contactPhone": "+91 98765 43210"       // optional, ≤40 — printed on shared graphics
}
```

Returns `{ "ok": true }`.

- **This is a PUT, so it replaces.** Any field you omit is *cleared*, not preserved — `designation`
  and `contactPhone` behave exactly like `displayName` and `languages` already did. The profile
  editor must therefore submit the whole form every time, not just the field that changed. This is
  the single most likely way to lose a user's data in this API.
- **`contactPhone` is free text and is not the sign-in number.** Autofill it from the OTP number
  during onboarding, then let the user edit it. It is never verified and never dialled — it is
  printed. Two users may legitimately have the same one, so there is no uniqueness error to handle.
  The verified sign-in number is `phone`, and it is read-only.
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
  "phone": "+9198…" | null,              // verified at sign-in, read-only
  "designation": "Consultant" | null,
  "contactPhone": "+91 98765…" | null,   // free text, what gets printed
  "avatarKey": "avatars/…/….png" | null, // stable object key
  "avatarUrl": "https://cdn…" | null,    // what you render
  "regionCode": "IN-MH" | null,
  "languages": ["hi", "mr"],
  "onboarded": true
}
```

Everything the overlay needs is in this one response, so fetch it once on launch and keep it —
do not re-fetch it per share.

**Call this on every cold start.** It answers "is the token valid" (401 if not) and "where do I
route" (`onboarded`) in one request, and gives you everything the profile screen needs.

### The logo — three steps, same as every upload here

The user's logo or profile image, which the overlay can stamp onto a graphic. Optional.

1. `POST /v1/me/avatar/upload-url` `{ mimeType, bytes }` → `{ storageKey, uploadUrl, expiresInSeconds }`
2. `PUT` the file to `uploadUrl` with the **same** `content-type` you declared
3. `POST /v1/me/avatar` `{ storageKey }` → `{ avatarKey, avatarUrl }`

The bytes go straight to R2; the API never sees them. Step 3 is not a formality — the server does a
HEAD on the object and rejects the confirm if nothing was uploaded, if it is not an image, or if it
is bigger than claimed. **Do not skip it**, or the profile keeps its old logo and nothing tells you.

- **Limits: 5 MB, and `image/jpeg`, `image/png` or `image/webp` only.** Both are checked at step 1,
  so an oversized file fails before the user waits through an upload.
- **Uploading again replaces the logo**, and deliberately gets a *new* key. Do not cache by "the
  user's avatar" — cache by `avatarKey`, or a replaced logo will keep showing the old image from the
  CDN edge for as long as it stays cached.
- `DELETE /v1/me/avatar` removes it. `404` if there was none.
- A `400` at step 3 saying *"Storage key does not belong to you"* means you sent a key from a
  different account. That is a bug in your code, not something a user can hit.

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

## 9. Sharing: clean vs personalised

Every feed post offers two actions. They differ only in what gets drawn on top of the image — the
API call is the same one either way.

| | Share | Customize & Share |
|---|---|---|
| Image | the clean original | original + the user's details |
| API call | `POST /v1/content/{id}/download` | the same, with `customized: true` |
| Counts as a download | yes | yes |

```jsonc
// Customize & Share
POST /v1/content/{id}/download
{ "source": "feed", "customized": true }
```

`customized` is the only way anyone can tell whether this feature gets used — the overlay is drawn
on the device, so the server sees nothing else. Please set it honestly.

### The overlay is entirely yours

The server stores the *data* and never touches pixels. It returns no position, no font, no layout.
There is nothing to fetch and nothing to wait for: everything you need is already in
`GET /v1/me/profile`, which you fetched at launch.

**Default placement is bottom-right, hardcoded in the app.** Designers do not define safe areas, so
expect it to sit awkwardly on some artwork — that is exactly why the user can move it.

### What may be shown, and what may be removed

| Element | From | Rule |
|---|---|---|
| Name | `displayName` | **Mandatory.** Without it this is just Share. |
| Designation | `designation` | Removable, and absent for many users |
| Phone | `contactPhone` | Removable |
| Logo | `avatarUrl` | Toggle on/off; absent when `avatarUrl` is null |

The user can move and scale the **text block and the logo independently**, change colours, and pick
from a bundled font list. None of that is persisted — it applies to the share in progress. If you
later want "remember my layout", that is a new profile field and a backend change; ask first rather
than inventing one.

Guard the mandatory case in the UI: if `displayName` is null, either prompt for it or fall back to
plain Share. Do not render an overlay with a blank line where the name should be.

### Rendering

Use `@shopify/react-native-skia`, and read the two warnings in §8's transform section — they apply
here too.

- **Compose and export at the source image's pixel dimensions**, not at the preview size. The
  on-screen editor is a scaled view; the export must not be. Capturing the visible view is the most
  common way this ships blurry.
- **Bundle the fonts** with `expo-font`. Devanagari and Tamil shaping varies across Android OEMs,
  and a name is the one thing that must not render as boxes.
- **Fetch the full-resolution image for the export**, not the resized thumbnail you used in the
  feed. Call the download endpoint, use the URL it returns.

Then `makeImageSnapshot()` → `expo-media-library` to save, or `expo-sharing` for the share sheet.

### One product warning

`contactPhone` burned into an image is permanent and un-revocable once it is forwarded on WhatsApp.
Show a preview before the share sheet opens, and consider defaulting the phone **off** for a
first-time user. This audience will not think it through, and "why is my number on a stranger's
status" is a support problem worth avoiding.

---

## 10. My Designs

A private studio: the user composes something, it is saved to the backend, and they can come back to
it. No review, no approval, no feed — these never become public content and never appear in anyone
else's anything.

### The shape

Each design holds a **scene graph** (`designJson`), optionally **one image**, and a **flattened
preview**.

```jsonc
POST /v1/me/designs
{ "title": "Diwali poster", "designJson": { … } }

// 200
{ "id": "…", "title": "Diwali poster", "designJson": { … },
  "sourceImageUrl": null, "previewUrl": null,
  "createdAt": "…", "updatedAt": "…" }
```

**`designJson` is yours entirely.** The server stores it verbatim and never reads it, so its shape is
whatever your editor needs. Two consequences: you can change it freely without a backend deploy, and
nothing server-side will catch a malformed scene — version it yourself (`{ "version": 1, … }`) so
old designs stay openable when the editor changes.

It is capped at **256 KB**. Real scenes are a few KB; hitting this means embedding image data in the
JSON, which is what `sourceImageKey` exists to avoid. Over the cap is a `400`.

### Endpoints

| | |
|---|---|
| `POST /v1/me/designs` | create |
| `GET /v1/me/designs?cursor=&limit=` | gallery, most recently edited first |
| `GET /v1/me/designs/{id}` | one design, with `designJson`, ready to edit |
| `PATCH /v1/me/designs/{id}` | save an edit — `{ title?, designJson? }` |
| `POST /v1/me/designs/{id}/upload-url` | sign an upload — `{ purpose, mimeType, bytes }` |
| `POST /v1/me/designs/{id}/assets` | confirm it — `{ purpose, storageKey }` |

`purpose` is `"source"` (the one image the design uses) or `"preview"` (the flattened render). Same
three-step upload as the logo, same 10 MB and image-type limits.

- **The gallery omits `designJson`** — fifty designs would be fifty scene graphs. Fetch one by id
  when the user opens it.
- **`PATCH` is a merge**, unlike the profile `PUT`. Omitted fields are left alone.
- **Upload a new preview after every meaningful edit**, or the gallery keeps showing the old render.
  Nothing regenerates it server-side.
- **One image per design**, by design. Attaching a second replaces the first.

### Two things to know

**There is no delete.** Not an oversight — it is deliberate (see `docs/future-monetisation.md`).
Do not build a delete button that fails; if the user needs to hide something, that is a product
conversation, not a missing endpoint.

**Another user's design is a `404`, not a `403`**, on every route that takes an id. Do not treat 404
here as "something broke" — it means not yours, or never existed.

---

## 11. The profile screen

### Download history — `GET /v1/me/downloads?cursor=&limit=`

```jsonc
{
  "items": [{
    "id": "…", "title": "Good Morning",
    "designer": { "id": "…", "name": "…" },
    "imageUrl": "https://cdn…" | null,
    "lastDownloadedAt": "2026-08-30T…",
    "timesDownloaded": 3
  }],
  "nextCursor": "…" | null
}
```

**One entry per image, not per download** — `timesDownloaded` says how often. Ordered by most
recently taken. Same opaque cursor rules as the feed.

Content that was later removed still appears: it is the user's own history, and a hole in it would be
stranger than an entry. Tapping through to a removed item will `409` on download — handle it as "no
longer available".

### Editing details

Same `PUT /v1/me/profile` as onboarding. **Re-read the replace warning in §3** — this is where it
does damage. Load the current profile into the form, and submit every field, not only the changed
one, or you will silently wipe the user's designation.

### Saved designs

`GET /v1/me/designs` (§10).

### Deleting the account — `DELETE /v1/me`

Google Play requires an in-app way to delete an account, so there is one. Returns `{ "ok": true }`.

- **App users only.** Panel accounts get `403 FORBIDDEN`; a super admin removes those.
- **Immediate and permanent.** Sessions, profile, languages, designs, reports and the logo and
  design images in storage are deleted; the token is dead on the next request (`401`).
- **Download records are kept, unlinked.** `download_events.user_id` becomes null, so designers'
  counts and region breakdowns do not change. Download history goes with the account, since it
  was only ever reachable through it.
- **Firebase is the app's job.** The server cannot delete the Firebase identity; the app calls
  `currentUser.delete()` best-effort afterwards and then signs out as usual. Signing in again with
  the same phone or email starts a fresh, empty account.
- The web page Play also requires, for people without the app, is
  `https://greetings.ashwathsoni.dev/delete-account` (apps/web).

---

## 12. First-launch sequence

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

Note that only the `401` branch clears the token. If that profile read fails any *other* way —
timeout, 500, no connectivity — keep the session and let the screens report their own failure. See
§2, "Keeping the session".

`GET /v1/regions` and `GET /v1/languages` need no token, so prefetch them on the splash screen
rather than after sign-in — they are cached and tiny, and having them ready makes onboarding feel
instant on a slow connection.

---

## 13. Rate limits

| Endpoint | Limit |
|---|---|
| `POST /v1/auth/firebase` | 600 / minute per IP, 6000 / minute overall |
| `POST /v1/content/{id}/download` | 120 / minute per user |
| `POST /v1/content/{id}/report` | 20 / hour per user |

The sign-in limit is per IP and deliberately loose because Indian carriers use carrier-grade NAT —
thousands of genuine users share one address. You will not hit these in normal use.

There is **no `Retry-After` header**. On a `429`, back off ~30 seconds and retry once; do not loop.

---

## 14. Analytics — Google Analytics and Microsoft Clarity

Your job to integrate, both client-side. No backend endpoint is involved and none is coming: the
data goes straight from the device to Google and Microsoft, and **you read it in their dashboards**.
There is nothing for us to build and nothing for you to POST to us.

### Two corrections before you start

**GA4 for a mobile app is the Firebase Analytics SDK**, not web gtag and not AdSense-style tags. The
GA4 property *is* the Firebase project. You already have Firebase in the app for phone OTP, so this
is the same project and close to free to add — use `@react-native-firebase/analytics`.

**Microsoft Clarity ships an official React Native SDK.** Expect less than the web product: it gives
you heatmaps and rage/dead-tap signal, not full session video. Treat it as "where do people get
stuck", not as a recording tool.

Both need a config plugin and a native rebuild, so they do not work in Expo Go. Plan for a
development build.

### What to instrument

Enough to answer real questions, not everything:

- **Screen views** on every screen. Almost free and the backbone of every funnel.
- **Onboarding funnel** — started, each step completed, finished, abandoned. This is the highest-value
  thing here: it tells you which field makes people quit.
- **Sign-in method chosen** (`otp` / `google`) and whether it succeeded.
- **Share vs Customize & Share**, and which overlay elements were kept or removed. Pair it with the
  `customized` flag we store server-side.
- **My Designs** — created, edited, image added, shared.
- **Ad events** — interstitial shown, dismissed, failed to load. Without these you cannot tell an
  ad-revenue problem from an ad-loading bug.

### A hard rule: no PII

Never send a name, phone number, email, `contactPhone` or logo URL to GA or Clarity. Not as an event
parameter, not as a user property, not in a screen name. Use the opaque user id from
`GET /v1/auth/me` if you need to correlate a user across sessions, and nothing else.

Clarity masks text by default — **leave that on**, especially on the profile and overlay editor
screens where the user's phone number is on screen. Turning masking off to debug a layout will
record real users' phone numbers.

### Which system answers which question

Keep this straight or you will end up with two numbers that disagree and no idea which is right.

- **Our `download_events`** is the source of truth for *designers*: how many downloads a post got,
  from which region. Designers are paid attention on these numbers, so they are recorded
  server-side, once, at the moment of the download.
- **GA and Clarity** answer *product* questions: where users drop off, what they tap, what they never
  find. They are sampled, client-side, and blockable.

If GA's download count and ours disagree, ours is correct. Do not try to reconcile them.

---

## 15. Ads

### First: it is AdMob, not AdSense

**AdSense does not serve native mobile apps.** The product is **Google AdMob** — same account family,
different SDK and different ad units. Use `react-native-google-mobile-ads`. Do not spend a day
setting up AdSense.

### The two placements

**Interstitial before a download, customise or share.** Load it *ahead of time* — an interstitial
requested at the moment of the tap will usually not be ready, and the user waits staring at nothing.
Preload one, show it when it is available, and move on when it is not.

**Anchored adaptive banner above the bottom navigation.** Reserve its height in the layout before it
loads, or the content jumps under the user's finger as it arrives — which for this audience means
mistaps, and mistaps on ads are exactly what gets an account suspended.

### Four rules that protect the account

These are not style preferences. Violating them risks limited ad serving or suspension.

1. **Frequency-cap the interstitial.** An ad before *every single* download is both punishing for an
   older user and a policy risk. Something like one per session milestone or one per few minutes,
   never two back to back, and never on the very first action after install — let people see the app
   work before you monetise them.
2. **Never block the actual action.** If the ad fails to load or errors, the download proceeds
   immediately. A user who cannot get their image because an ad broke will uninstall.
3. **No ads on or near the design canvas.** A user dragging text with an ad nearby generates
   accidental clicks, and accidental clicks are invalid traffic.
4. **Use test ad unit IDs in development.** Tapping your own live ads is the fastest way to get an
   AdMob account banned. Swap to real IDs only in release builds.

### Before you can ship

- **iOS App Tracking Transparency** prompt, or iOS ads serve untargeted and earn very little.
- **A consent flow** — Google's UMP SDK. India's DPDP Act applies to this audience, and Play requires
  a declared data-safety section that matches what the SDKs actually collect.
- **A privacy policy URL**, required by both stores and by AdMob, naming Google, Microsoft Clarity
  and Firebase.

### Worth raising with the product owner

Interstitials on *every* download will measurably hurt retention with older, less tech-confident
users — the exact people this product is for. Worth agreeing a cap up front rather than discovering
it in the retention numbers.

---

## 16. Things not to build

Each of these is already handled, and duplicating it will cause bugs:

- **Client-side spell correction** — the search endpoint has a fuzzy fallback.
- **A tags/languages/regions cache** — HTTP caching headers are already set, and admins now edit
  these lists at runtime, so a baked-in copy will go stale.
- **Account linking UI** — sign-ins linked by verified email or phone resolve to one account.
- **Deduplication while paging** — the cursor guarantees no repeats within a session.
- **A download counter** — `downloadCount` on the item is authoritative; do not increment locally.
- **Role handling** — every app user is `role: "user"`.

## 17. Things that genuinely do not exist

So you do not go looking:

- **No push notifications.** No device token registration endpoint.
- **No favourites or collections.** Download history exists (§11); a "save for later" list does not.
- **No following a designer**, no comments, no likes, no sharing counters.
- **No server-side image processing.** No resizing pipeline, no stored thumbnail variants, no format
  conversion, and no overlay compositing. Resizing happens at the CDN edge (§8) and overlays happen
  on the device (§9). There is nothing to request and nothing to wait for.
- **No deleting a saved design** (§10). Deliberate, not missing.
- **No watermarks and no paywall.** Both are planned — see `docs/future-monetisation.md` — so avoid
  designing them out of the way.
- **No saved overlay layout.** Position, size and colour apply to the share in progress and are not
  persisted. If it should be remembered, that is a backend change; ask.

If the app needs any of these, they are backend work, not something to work around on the client.
Ask.

---

## Questions

Open `/docs` first — it answers most field-level questions definitively. For anything about *why*
something behaves as it does, `docs/specs/greetings-backend.md` is the full backend spec: §7 covers
feed ranking, §12 limits and behaviour under load, and §16 the mobile-only surface (overlays, My
Designs, history). `docs/future-monetisation.md` records what is deliberately deferred and why.

If something here disagrees with `/docs`, `/docs` wins and this file is stale — please say so.
