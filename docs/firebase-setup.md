# Firebase setup — the app's sign-in

Firebase is the **only** way a user signs in to the app. Better Auth is the panels' login and the
app has no client for it; see §2 of [mobile-integration.md](./mobile-integration.md) for how the
two fit together.

This file is the runbook: what to create, where each value goes, and how to tell when it works.

---

## 0. What works today, and what is deferred

Three sign-in methods, and they do **not** cost the same to set up.

| Method | Works on a dev build | Needs platform setup before real use |
|---|---|---|
| **Email and password** | Yes, fully | No |
| **Google** | Yes, fully | No — just the web client ID (§3) |
| **Phone OTP** | Only with test numbers (§2.7) | **Yes — §2.5 (Android) and §2.6 (iOS)** |

**Phone is the deferred one, on purpose.** Firebase will not send an SMS until it can prove the
*app* is genuine, and that proof is per-platform: signing-certificate fingerprints on Android, an
APNs key on iOS. Neither is code, both are console and keychain work, and both can wait.

Until they are done, develop phone sign-in against **Firebase's test phone numbers** — a fixed code,
no SMS, works in the simulator. Email and Google need none of it and are complete today. There is a
matching `TODO(phone-native-setup)` block in `apps/native/lib/firebase.ts` so whoever picks this up
next finds it from the code.

Nothing about this is a code change when you do get to it: §2.5 and §2.6 are entirely console steps
plus a re-downloaded `google-services.json`.

---

## 1. The short version

**Two files and one environment variable.** Nothing else, and nothing to copy by hand.

| What | Where it goes | Where it comes from |
|---|---|---|
| `google-services.json` | `apps/native/google-services.json` | Firebase console → Android app |
| `GoogleService-Info.plist` | `apps/native/GoogleService-Info.plist` | Firebase console → iOS app |
| `FIREBASE_PROJECT_ID` | `apps/server/.env` | Firebase console → Project settings → Project ID |

Both files are gitignored, so each developer drops in their own.

**Everything Google sign-in needs is already inside those two files, and
`apps/native/app.config.ts` reads it out at build time** — the web OAuth client ID and the iOS
`REVERSED_CLIENT_ID` URL scheme. There is no `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and no value to
paste into `app.json`; both existed briefly and were removed, because a pasted copy goes stale the
moment the files are re-downloaded — which happens every time you enable a provider, since enabling
one rewrites them.

So the whole app-side setup is: put the two files in `apps/native/`. If Google is not configured in
the console yet, the config prints a warning at build time and the Google button is hidden; phone
and email are unaffected.

**There is no service-account key.** The server verifies ID tokens against Google's public JWKS with
`jose` (`apps/server/src/lib/token-verifier.ts`), so it needs to know *which project* to trust and
nothing more. No private key ever reaches this repo — that was a deliberate choice (spec §11.1) and
is worth keeping.

The project ID and the two config files must all describe the **same Firebase project**. The verifier
asserts both `iss` and `aud` against `FIREBASE_PROJECT_ID`, so a mismatch is a flat `401` on every
sign-in with nothing else wrong.

---

## 2. Firebase console, step by step

### 2.1 Create the project

1. <https://console.firebase.google.com> → **Add project**.
2. Google Analytics is optional and unrelated to auth — the app's analytics are wired separately
   (see mobile-integration.md §14).
3. **Project settings → General** → copy the **Project ID** (not the display name, not the number).
   This is the `FIREBASE_PROJECT_ID` value.

### 2.2 Register the Android app

**Project settings → Your apps → Add app → Android.**

- **Android package name:** `dev.ashwathsoni.greetings`

  It must match `android.package` in `apps/native/app.config.ts` exactly. If you want a different
  identifier, change it in both places before anyone installs a build — it is not renameable later
  without users reinstalling.
- Nickname and debug SHA-1 can be left for now; the SHA is added in §2.5.
- **Download `google-services.json`** → save as `apps/native/google-services.json`.

### 2.3 Register the iOS app

**Project settings → Your apps → Add app → iOS.**

- **Bundle ID:** `dev.ashwathsoni.greetings`, matching `ios.bundleIdentifier` in `app.config.ts`.
- **Download `GoogleService-Info.plist`** → save as `apps/native/GoogleService-Info.plist`.

### 2.4 Turn on the three providers

**Build → Authentication → Get started → Sign-in method**, then enable:

- **Phone**
- **Email/Password** — leave "Email link (passwordless sign-in)" off; the app does not use it
- **Google** — this also creates the OAuth clients you need for §3

Nothing else. The app requests no other provider.

**One setting to look at while you are here:** Authentication → Settings → User actions → *Email
enumeration protection*. Leave it **on** (the default). With it on, a wrong password and an unknown
address return the same `auth/invalid-credential`, so the sign-in screen cannot be used to discover
who has an account. `lib/firebase.ts` maps both to one message deliberately for that reason — if you
ever turn it off, the messages should get more specific to match.

### 2.5 Android: register your signing fingerprints

> **Deferred — phone sign-in only.** Skip this while developing against test numbers (§2.7). Email
> and Google sign-in do not need it.

Phone auth on Android verifies the app with Play Integrity, which identifies the build by its
signing certificate. Without the fingerprint registered, `sendVerificationCode` fails with
`auth/app-not-authorized` or falls into a reCAPTCHA challenge.

Get the debug fingerprint:

```sh
keytool -list -v \
  -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android
```

Or, after a prebuild (§6), `cd apps/native/android && ./gradlew signingReport`.

Add **both SHA-1 and SHA-256** under **Project settings → Your apps → Android → Add fingerprint**,
then **re-download `google-services.json`** — the fingerprints are baked into it.

Do this three times over the app's life: debug keystore, release/upload keystore, and — once the app
is on Play — the **App signing key certificate** from Play Console → Setup → App signing. Forgetting
the last one is the classic "works everywhere except production" bug.

### 2.6 iOS: upload an APNs key

> **Deferred — phone sign-in only.** Skip this while developing against test numbers (§2.7). Email
> and Google sign-in do not need it.

Firebase verifies an iOS app by sending it a silent push. Give it the means to:

1. Apple Developer → **Certificates, Identifiers & Profiles → Keys → +**, enable **Apple Push
   Notifications service (APNs)**, download the `.p8`. You get it once — keep it.
2. Firebase → **Project settings → Cloud Messaging → APNs Authentication Key → Upload**, with the
   Key ID and your Team ID.
3. The App ID needs the **Push Notifications** capability enabled in the Apple Developer portal.

Without APNs, iOS phone auth falls back to a reCAPTCHA web challenge. That still works — the
`@react-native-firebase/auth` config plugin writes the required URL schemes into `Info.plist`
automatically from your plist — but it is a visibly worse first-run experience, so do the APNs step
before any real user sees it.

### 2.7 Add test numbers — this is how you develop phone sign-in

**Authentication → Sign-in method → Phone → Phone numbers for testing.**

Add a number and a fixed code, e.g. `+91 90000 00001` → `123456`.

These bypass SMS entirely, work in the simulator and on an emulator, **need neither §2.5 nor §2.6**,
and cost no quota. Up to ten. This is the whole reason phone setup can be deferred: the flow is
fully testable without it. Real SMS to a real handset is for release verification, not the daily
loop.

---

## 3. Google sign-in: nothing to configure

There is no step here. `apps/native/app.config.ts` pulls both values Google needs out of the config
files you already dropped in:

| Value | Read from | Used for |
|---|---|---|
| Web OAuth client ID | `google-services.json`, the `oauth_client` entry with `"client_type": 3` | `GoogleSignin.configure()`, which is what makes the picker's token usable as a Firebase credential |
| `iosUrlScheme` | `REVERSED_CLIENT_ID` in `GoogleService-Info.plist` | The URL scheme iOS redirects back into after the picker |

It must be the **web** client (type 3), not the Android (1) or iOS (2) one — the native client IDs
produce a token Firebase rejects. That is the single most common way to get this wrong, which is why
it is not left to a human to pick. If the plist has no `REVERSED_CLIENT_ID`, the config derives the
scheme from the iOS client instead by reversing its dotted segments.

The one thing you must do is **enable Google in the console** (§2.4) and then **re-download both
files**. Firebase creates the OAuth clients when you enable the provider, so a file downloaded
beforehand has `"oauth_client": []` and carries none of this.

You can check without building:

```sh
cd apps/native && bunx expo config --type public | grep -E "googleWebClientId|iosUrlScheme"
```

Both present means Google is ready. Neither present, plus a `[greetings] Google sign-in is off…`
warning, means the files predate enabling the provider. The Google button is hidden in that state
rather than shown and then failing — `isGoogleSignInAvailable()` in `lib/firebase.ts`.

---

## 4. Email and password: the confirmation step

Email sign-in requires a **confirmed address**, and the app enforces it: `signUpWithEmail` creates
the account, asks Firebase to mail the link, and signs straight back out. Nobody gets a session
until they follow it.

That is not politeness. The server keeps a placeholder address,
`<firebase-uid>@firebase.placeholder`, for any identity whose email it cannot trust, and will only
*link* accounts on a verified one. That rule stops anyone claiming someone else's account by signing
up with their address — but it also means an unconfirmed account would land with a placeholder for
an email and be unfindable by the address its owner typed. Confirming first is what makes email
sign-in work at all.

Firebase sends the mail, so this costs no email infrastructure. (Which is exactly why the *panels*
have no verification step — nothing server-side can send email, and a super admin creating the
account is a stronger statement than a clicked link. Different population, different answer.)

Nothing to configure. If you want the mail to say something other than Firebase's default, that is
**Authentication → Templates**.

---

## 5. Where the values go

`apps/server/.env` — uncomment and set:

```sh
FIREBASE_PROJECT_ID=your-project-id
```

That is the only Firebase line. `docker-compose.yml` passes `apps/server/.env` through with
`env_file`, so a compose deployment needs no further change.

Left unset, the server still boots — deliberately, so unrelated work is not blocked — and
`POST /v1/auth/firebase` returns a clear configuration error instead.

`apps/native/.env`:

```sh
EXPO_PUBLIC_SERVER_URL=http://localhost:3000
```

That is the only variable the app takes. Nothing Firebase-related belongs here — see §3.

### Should the two config files be committed?

Google's position is that they hold identifiers, not secrets — an API key in them is restricted by
package name and signing certificate, not by being hidden. Committing them is the common choice and
makes CI builds trivial. The alternative is EAS file-type environment variables, referenced from the
same `googleServicesFile` paths. Either is defensible; what is not is having one developer's copy
differ from another's, so pick one and write it down here.

---

## 6. Building and running

The app can no longer run in **Expo Go**. `@react-native-firebase` is native code, and Expo Go ships
a fixed set of native modules that does not include it. That is the price of proper phone auth: the
JS `firebase` SDK's phone flow is built on reCAPTCHA in a WebView, which is a worse experience and
still needs native work to be reliable.

```sh
bun install

cd apps/native
bunx expo prebuild --clean     # generates ios/ and android/
bun run ios                    # or: bun run android
```

`expo prebuild` **fails** if either config file is missing — the `@react-native-firebase/auth`
plugin reads `GoogleService-Info.plist` to write the reCAPTCHA URL schemes, and stops rather than
producing a build that would fail confusingly at runtime. If you see it complain about a missing
plist, §2.3 is the step you skipped.

`app.config.ts` already carries what prebuild needs: both Firebase plugins, the bundle identifier and
package name, the `googleServicesFile` paths, and `expo-build-properties` setting
`ios.useFrameworks: "static"`, which the Firebase iOS SDK requires.

---

## 7. Checking it works

In order, because each step rules out the one before:

1. **Server knows the project.** `POST /v1/auth/firebase` with `{"idToken":"nonsense"}` should give
   `401 UNAUTHENTICATED`, not a configuration error. A configuration error means
   `FIREBASE_PROJECT_ID` is unset.
2. **Token exchange works.** In a dev build the sign-in screen has a *Development only* panel that
   takes a pasted ID token. Paste a real one and you should land in the app. This isolates the
   server exchange from anything Firebase does on the device.
3. **Email and password works.** Create an account, follow the link in the mail, come back and sign
   in. This is the cheapest end-to-end check — no SMS, no platform setup — so use it to prove the
   device half works before touching phone.
4. **Google works.** Tap *Continue with Google*. If the button is not there at all, run the
   `expo config` check in §3 — the provider is almost certainly not enabled yet.
5. **Phone flow works.** Sign in with a §2.7 test number. No SMS is sent; the fixed code is
   accepted.
6. **Real SMS works.** A real number on a real device — and only after §2.5 / §2.6 are done. Leave
   this until 1–5 pass; each real attempt spends quota and the failures here are the least specific.

### When it fails

| Symptom | Cause |
|---|---|
| `401` on every sign-in, tokens look fine | `FIREBASE_PROJECT_ID` names a different project than the config files |
| No Google button on the sign-in screen | No web OAuth client in `google-services.json` — enable Google (§2.4) and re-download both files (§3) |
| `[greetings] Google sign-in is off…` at build time | Same cause. `"oauth_client": []` means the file predates enabling the provider |
| Google picker opens, then nothing on iOS | The plist has no `REVERSED_CLIENT_ID` and the Android file has no iOS client either — re-download both |
| `auth/operation-not-allowed` | That provider is not enabled in the console (§2.4) |
| Signed up by email but stuck on "check your inbox" | The link was not followed. The address must be confirmed before a session is issued (§4) |
| `auth/invalid-credential` on a password you are sure of | Also what an *unknown address* returns, by design — email enumeration protection (§2.4) |
| `auth/app-not-authorized` | Android signing fingerprint not registered (§2.5), or `google-services.json` predates it |
| `auth/captcha-check-failed` on iOS | APNs key missing (§2.6); it fell back to reCAPTCHA and that failed too |
| `auth/invalid-phone-number` | Not E.164 by the time it reached Firebase. `toE164` in `apps/native/lib/firebase.ts` assumes +91 for bare 10-digit numbers |
| `auth/too-many-requests` | Per-device throttle. Use a test number instead of retrying |
| `auth/quota-exceeded` | Project SMS quota. The free tier is small — another reason to develop on test numbers |
| Prebuild fails on a missing plist | §2.3 |

The server-side rate limits on the exchange endpoint are separate and much higher — 6000/minute
globally, 600/minute per address (`apps/server/src/modules/auth/routes.ts`). If you are seeing `429`
from *our* API during development, something is looping, not rate-limited.
