# Greetings — the mobile app

Everything you need to run, change, and ship `apps/native`. The API contract and its rules live in
[mobile-integration.md](./mobile-integration.md) (read it before touching anything that calls the
server); Firebase console setup lives in [firebase-setup.md](./firebase-setup.md). This file covers
the app itself.

---

## 1. Stack

| | |
|---|---|
| Runtime | Expo SDK 54, React Native 0.81 (new architecture), React 19.1, Hermes |
| Routing | expo-router 6 (typed routes) |
| UI | heroui-native + Uniwind (Tailwind classes), Ionicons, expo-image |
| Data | @tanstack/react-query + axios (`lib/api.ts`, `lib/services.ts`) |
| Auth | Firebase (`@react-native-firebase/auth`): phone OTP, email, Google → traded for an API session |
| Images | `@shopify/react-native-skia` — overlay compositing, WebP→JPEG, design rendering |
| Analytics | Google Analytics 4 via `@react-native-firebase/analytics`, Microsoft Clarity |
| Ads | Google AdMob via `react-native-google-mobile-ads` (UMP consent + iOS ATT) |
| i18n | English and Hindi UI, `lib/i18n` (no library) |
| Builds | EAS Build (cloud) for both platforms; local Android builds also work |

**The app does not run in Expo Go.** Firebase, Skia, AdMob and Clarity are native modules. You need
a development build (§3).

---

## 2. Getting the project running

### Prerequisites

- Bun 1.3+ and Node 22+
- For Android: JDK 17 and the Android SDK (Android Studio, or `brew install openjdk@17` +
  `brew install --cask android-commandlinetools`)
- For iOS on your own machine: a Mac with full Xcode and CocoaPods. Without them, build iOS on EAS (§5).
- **The two Firebase config files**, `google-services.json` and `GoogleService-Info.plist`. They are
  gitignored, so a fresh clone does not have them and `expo prebuild` fails without them — this is the
  single most likely reason "the app does not build". Download them from the Firebase console
  (project `greetings-69fc3` → Project settings → Your apps) or ask the project owner, and put both
  in `apps/native/`.

### First run

```bash
bun install                          # from the repo root
cp apps/native/.env.example apps/native/.env
cd apps/native
bunx expo prebuild --platform android   # generates android/ (never commit it)
bunx expo run:android                   # builds the dev client, installs, starts Metro
```

iOS on a Mac with Xcode: `bunx expo prebuild --platform ios && bunx expo run:ios`.

After the first native build, day-to-day work is just `bun run dev` (Metro) with the dev client
installed. Rebuild natively only when you add a native module or change `app.config.ts`.

### Which backend

`EXPO_PUBLIC_SERVER_URL` in `apps/native/.env`. It defaults to production
(`https://greetings-api.ashwathsoni.dev`). To use a local server, put your computer's **LAN IP** there
(`http://192.168.1.20:3000`). `localhost` on a phone or emulator is the phone itself, which is why a
`.env` pointing at `localhost:3000` makes the app look "not linked to the backend".

Changing any `EXPO_PUBLIC_*` value needs a Metro restart with a cleared cache
(`bunx expo start -c`), because the values are inlined into the bundle at build time.

---

## 3. How the code is organised

```
apps/native/
  app/                         routes (expo-router)
    _layout.tsx                providers, splash, screen tracking, consent/ads bootstrap
    (auth)/language.tsx        screen 1: English / हिन्दी
    (auth)/sign-in.tsx         phone · email · Google
    (onboarding)/              content languages → region → optional details
    (app)/(tabs)/              Home feed · Search · Saved · My Designs · Profile
    (app)/content/[id].tsx     a greeting: Share · Save · Customize & Share · Report
    (app)/customize/[id].tsx   the overlay editor (name, designation, phone, logo)
    (app)/design/[id].tsx      the My Designs editor
  components/
    ads/banner-slot.tsx        the only banner placement
    auth/                      one component per sign-in method
    canvas/                    Skia scene model + renderer shared by both editors
    ui/                        small shared kit (tiles, chips, empty/error states)
  contexts/auth-context.tsx    session + every redirect in the app
  lib/
    api.ts, services.ts        HTTP; every endpoint the app calls
    firebase.ts                the only file that talks to Firebase Auth
    media.ts                   download → cache → JPEG → gallery / share sheet
    analytics.ts               GA4 + Clarity behind one typed `track()`
    ads/                       consent, unit ids, interstitial pacing
    i18n/                      `useT()`, strings per screen area in strings/*.ts
```

Rules that are easy to break:

- **Redirects live only in `contexts/auth-context.tsx`.** Screens never navigate on sign-in,
  sign-out or onboarding completion.
- **Lists render `getThumbnailUrl(imageUrl, width)`, never `imageUrl`.** Saving and sharing always go
  through `lib/media.ts`, which calls the counted download endpoint.
- **Colours come from theme tokens** (`bg-accent`, `text-muted`, `bg-surface` …, defined in
  `global.css`). heroui-native has no `primary` token: `bg-primary` and `text-muted-foreground`
  silently render nothing.
- **Every UI string goes through `t()`**, with both English and Hindi in `lib/i18n/strings/`. The
  types refuse a key that exists in only one language.
- **No PII in analytics** — see the header of `lib/analytics.ts`.

---

## 4. Analytics: Google Analytics and Microsoft Clarity

Both are wired in `lib/analytics.ts` and start after the consent step in `lib/ads/consent.ts`.
Screen views are automatic (route patterns only, never ids); product events are the closed list in
`AnalyticsEvents`. Add an event there first, then call `track()`.

**Google Analytics** is the Firebase project's GA4 property. Nothing to configure in code: enable
Google Analytics on the Firebase project (Project settings → Integrations) and events appear under
Analytics in the Firebase console. Auto-collection is held off in `firebase.json` until consent.

**Microsoft Clarity**:

1. Create a project at clarity.microsoft.com → *Mobile app*.
2. Copy its project id into `EXPO_PUBLIC_CLARITY_PROJECT_ID` (in `.env` locally, and as an EAS
   environment variable for builds — §5). Unset means Clarity does not start.
3. In Clarity → Settings → Masking, keep **Strict**. The profile and overlay screens show the user's
   phone number; relaxing masking records real ones.

Clarity's mobile SDK gives heatmaps, rage/dead taps and session replays — not full video. Sessions
take about two hours to appear in the dashboard; live sessions show sooner.

---

## 5. Ads: AdMob (not AdSense)

AdSense does not serve native mobile apps. The product is **AdMob**, same Google account family,
different console.

### What is built

- **Anchored adaptive banner** directly above the tab bar, with its height reserved before it loads
  (no layout jump under the user's finger). Nowhere else.
- **Interstitial** before Save, Share and before opening Customize: preloaded, paced (none in the first
  three actions after install, then at most one every four minutes), and it never blocks the action
  — not loaded or failed means the save simply happens.
- **No ads in or near the editors.**
- **Consent**: Google's UMP form where the law requires it (EEA/UK; a no-op in India), then iOS App
  Tracking Transparency, then the ads SDK. Profile shows "Privacy choices" when UMP requires it.
- **Test ads in every development build**, whatever ids are configured.

All in `lib/ads/` and `components/ads/banner-slot.tsx`.

### Going live

1. AdMob → Apps → add the Android app and the iOS app. Each gets an **app id** (`ca-app-pub-…~…`).
2. Create two ad units per platform: *Banner* and *Interstitial*. Each gets a **unit id** (`…/…`).
3. Set the build-time app ids `ADMOB_ANDROID_APP_ID`, `ADMOB_IOS_APP_ID` and the runtime unit ids
   `EXPO_PUBLIC_ADMOB_{BANNER,INTERSTITIAL}_{ANDROID,IOS}` (see `.env.example`) as EAS environment
   variables for the `production` environment. Without them a release build serves test ads, which
   earn nothing but cannot get the account in trouble.
4. AdMob → Privacy & messaging: create a **GDPR message** (EU consent) and an **IDFA explainer** for
   iOS. UMP shows whatever is configured here; with nothing configured it shows nothing.
5. Publish `app-ads.txt` on the developer website listed in the store listings.
6. Never tap your own live ads. Add your phones as test devices in AdMob → Settings → Test devices.

---

## 6. Building and releasing

### EAS (both platforms, recommended)

One-time setup, from `apps/native`:

```bash
bunx eas-cli@latest login         # in a non-interactive shell: login --device --non-interactive
```

The EAS project already exists (`ashboi005/greetings`) and its id is in `app.config.ts`. To build
under another account, set `EAS_PROJECT_ID` and `EAS_OWNER` instead of editing the file. Building
needs access to that Expo account (owner, or invited to it).

Upload the two gitignored Firebase files as **file** variables. `app.config.ts` reads their paths
from these exact names:

```bash
bunx eas-cli@latest env:create --name GOOGLE_SERVICES_JSON --type file \
  --value ./google-services.json --environment development --environment preview --environment production --visibility secret
bunx eas-cli@latest env:create --name GOOGLE_SERVICE_INFO_PLIST --type file \
  --value ./GoogleService-Info.plist --environment development --environment preview --environment production --visibility secret
```

Profiles (`eas.json`):

| Profile | Use | Output |
|---|---|---|
| `development` | dev client for daily work | Android APK, iOS device build |
| `development-simulator` | dev client for the iOS simulator | simulator .app |
| `preview` | testers; real UI, test ads | Android APK, iOS ad-hoc |
| `production` | the stores | Android AAB, iOS App Store build |

```bash
bunx eas-cli@latest build --profile preview --platform android
bunx eas-cli@latest build --profile production --platform all
bunx eas-cli@latest submit --profile production --platform android
```

Version numbers are managed remotely by EAS (`appVersionSource: remote`, `autoIncrement` on
production). Bump the user-facing `version` in `app.config.ts` for each release.

### Local Android

```bash
cd apps/native
bunx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease     # app/build/outputs/apk/release/app-release.apk
```

A local release build is signed with the debug keystore — fine for testing on phones, not for Play.
For the store, build on EAS, which manages the upload key.

### iOS specifics

iOS links React Native Firebase statically (`forceStaticLinking` in `app.config.ts`). **Every RNFB
module in `package.json` must be listed there**, or only the iOS build fails, and only on the build
server.

---

## 7. Before the first store release

- [ ] Firebase phone auth for real SMS: Android SHA-1/SHA-256 for the **EAS upload key** and for
      **Play App Signing**, re-download `google-services.json` and re-upload it to EAS; APNs key
      for iOS. See firebase-setup.md §2.5–2.6. Until then only Firebase test numbers work.
- [ ] Google sign-in: SHA fingerprints above also apply.
- [ ] AdMob live ids and the privacy messages (§5).
- [ ] Clarity project id, masking on Strict (§4).
- [ ] A privacy policy URL naming Firebase/Google Analytics, AdMob and Microsoft Clarity, set as
      `EXPO_PUBLIC_PRIVACY_POLICY_URL` (shown in Profile) and in both store listings.
- [ ] Play Data safety form and App Store privacy labels matching what the SDKs collect
      (device identifiers, app interactions, crash/diagnostics, approximate location via ads).
- [ ] Store listing assets: screenshots, feature graphic, short and full description (English and Hindi).

---

## 8. Things that broke before, and why

| Symptom | Cause | Fixed by |
|---|---|---|
| `expo prebuild` fails on a fresh clone | Firebase files are gitignored | §2 (and EAS file variables, §6) |
| App "not linked to the backend" on a phone | `.env` pointed at `localhost` | §2 "Which backend" |
| `.env` values ignored in release builds | `runtimeEnv: process.env` defeats Expo's inlining | `packages/env/src/native.ts` lists each variable literally |
| Duplicate native modules / autolinking errors | Bun's isolated linker leaves several copies of each Expo module | `bunfig.toml`: `linker = "hoisted"` |
| "Invalid hook call" / renderer mismatch at launch | Web needs React 19.2, RN 0.81 needs 19.1.0; hoisting exposed both | `metro.config.js` pins `react` and `react-dom` to the app's copy |
| Selected chips and primary pills invisible | shadcn class names (`bg-primary`) that heroui-native does not define | theme tokens, §3 |
| AdMob fails to compile on Android | 17.x is written against RN ≥ 0.86 (Kotlin nullability errors); 16.4+ pulls Ads SDK 25.4, built with Kotlin 2.3, which Expo 54's Kotlin 2.1 cannot read | pinned to 16.3.4 (Ads SDK 25.0.0) — upgrade only together with Expo |
