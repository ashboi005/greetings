import fs from "node:fs";
import path from "node:path";
import type { ExpoConfig } from "expo/config";

/**
 * Expo config, derived from the Firebase files rather than duplicating them.
 *
 * Google sign-in needs two values that Firebase already ships inside
 * `google-services.json` and `GoogleService-Info.plist`:
 *
 *   - the **web** OAuth client ID, which turns the account picker's token into
 *     a Firebase credential. `GoogleSignin.configure()` runs in JS and cannot
 *     read those files, so it has to be handed over at runtime.
 *   - `REVERSED_CLIENT_ID`, the URL scheme iOS redirects back into after the
 *     picker.
 *
 * Both are read here instead of being copied into `.env` and `app.json` by
 * hand. Copying them by hand is not hard, it is just silently wrong the moment
 * someone re-downloads the config files for a different project — which happens
 * every time Firebase gains a provider, because enabling one rewrites them.
 *
 * So: drop the two files in this directory and everything else follows. Nothing
 * to paste, and no way for the pasted copy to drift from the real one.
 *
 * When Google is not configured yet, this degrades rather than failing: the
 * plugin and the client ID are simply left out, and `isGoogleSignInAvailable()`
 * in lib/firebase.ts hides the button. Phone and email do not depend on any of
 * it.
 */

const PROJECT_ROOT = __dirname;

/**
 * Both Firebase files are gitignored, so an EAS build server never has them on
 * disk. They are uploaded as EAS "file" environment variables instead, which
 * EAS materialises somewhere on the build machine and exposes as an absolute
 * path in these two variables. Locally the variables are unset and the files
 * sitting in this directory are used. See docs/mobile-app.md §Building.
 */
const ANDROID_CONFIG =
	process.env.GOOGLE_SERVICES_JSON ??
	path.join(PROJECT_ROOT, "google-services.json");
const IOS_CONFIG =
	process.env.GOOGLE_SERVICE_INFO_PLIST ??
	path.join(PROJECT_ROOT, "GoogleService-Info.plist");

const BUNDLE_ID = "dev.ashwathsoni.greetings";

/**
 * The web OAuth client from `google-services.json`.
 *
 * `client_type: 3` is Google's numbering for a web client; 1 is Android and 2
 * is iOS. It has to be the web one — the native client IDs produce a token
 * Firebase will not accept, which surfaces as a confusing "missing identity
 * token" rather than as a wrong-value error.
 *
 * Absent until Google sign-in is enabled in the Firebase console, because
 * enabling it is what creates the OAuth clients.
 */
function readGoogleWebClientId(): string | undefined {
	if (!fs.existsSync(ANDROID_CONFIG)) return undefined;

	try {
		const parsed = JSON.parse(fs.readFileSync(ANDROID_CONFIG, "utf8")) as {
			client?: {
				oauth_client?: { client_id?: string; client_type?: number }[];
			}[];
		};

		for (const client of parsed.client ?? []) {
			for (const oauth of client.oauth_client ?? []) {
				if (oauth.client_type === 3 && oauth.client_id) return oauth.client_id;
			}
		}
	} catch {
		// A malformed file is the same situation as a missing one as far as this
		// is concerned; prebuild's own plugins report it properly.
	}

	return undefined;
}

/**
 * `REVERSED_CLIENT_ID` from `GoogleService-Info.plist`.
 *
 * Read with a regex rather than a plist parser: the only alternative is a
 * dependency used once, at config-evaluation time, to pull a single string out
 * of a file whose shape Apple has not changed in fifteen years.
 *
 * Falls back to deriving it from the iOS OAuth client in
 * `google-services.json`, since "reversed" is literally the dotted segments in
 * reverse — `123-abc.apps.googleusercontent.com` becomes
 * `com.googleusercontent.apps.123-abc`. That covers a plist downloaded before
 * Google was enabled while the Android file is current.
 */
function readIosUrlScheme(): string | undefined {
	if (fs.existsSync(IOS_CONFIG)) {
		try {
			const xml = fs.readFileSync(IOS_CONFIG, "utf8");
			const match = xml.match(
				/<key>REVERSED_CLIENT_ID<\/key>\s*<string>([^<]+)<\/string>/,
			);
			if (match?.[1]) return match[1].trim();
		} catch {
			// Fall through to the derivation below.
		}
	}

	return deriveIosUrlSchemeFromAndroidConfig();
}

function deriveIosUrlSchemeFromAndroidConfig(): string | undefined {
	if (!fs.existsSync(ANDROID_CONFIG)) return undefined;

	try {
		const parsed = JSON.parse(fs.readFileSync(ANDROID_CONFIG, "utf8")) as {
			client?: {
				oauth_client?: { client_id?: string; client_type?: number }[];
			}[];
		};

		for (const client of parsed.client ?? []) {
			for (const oauth of client.oauth_client ?? []) {
				// client_type 2 is the iOS OAuth client.
				if (oauth.client_type === 2 && oauth.client_id) {
					return oauth.client_id.split(".").reverse().join(".");
				}
			}
		}
	} catch {
		// Nothing usable; Google sign-in stays off.
	}

	return undefined;
}

const googleWebClientId = readGoogleWebClientId();
const iosUrlScheme = readIosUrlScheme();

/**
 * Surfaced at build time so a missing piece is visible in the terminal rather
 * than as a button that does nothing on a device.
 */
if (!googleWebClientId) {
	console.warn(
		"[greetings] Google sign-in is off: no web OAuth client (client_type 3) in " +
			"apps/native/google-services.json. Enable Google under Firebase " +
			"Authentication > Sign-in method, then re-download both config files. " +
			"Phone and email sign-in are unaffected. See docs/firebase-setup.md §3.",
	);
}

/**
 * AdMob *app* ids (the `~` ones). Google's sample app ids are the fallback:
 * they are public, documented, and can only ever serve test ads, so a build
 * without real ids is harmless rather than broken. The plugin refuses to run
 * without some value, and AdMob's SDK crashes the app at launch on Android if
 * the manifest entry is missing — so "unset" must never mean "omitted".
 */
const ADMOB_TEST_ANDROID_APP_ID = "ca-app-pub-3940256099942544~3347511713";
const ADMOB_TEST_IOS_APP_ID = "ca-app-pub-3940256099942544~1458002511";

const admobAndroidAppId =
	process.env.ADMOB_ANDROID_APP_ID || ADMOB_TEST_ANDROID_APP_ID;
const admobIosAppId = process.env.ADMOB_IOS_APP_ID || ADMOB_TEST_IOS_APP_ID;

if (
	admobAndroidAppId === ADMOB_TEST_ANDROID_APP_ID ||
	admobIosAppId === ADMOB_TEST_IOS_APP_ID
) {
	console.warn(
		"[greetings] AdMob is using Google's sample app ids, so only test ads " +
			"will serve. Set ADMOB_ANDROID_APP_ID and ADMOB_IOS_APP_ID for a store " +
			"build. See docs/mobile-app.md §Ads.",
	);
}

const TRACKING_DESCRIPTION =
	"Allow tracking to see ads that are more relevant to you. The app stays free either way.";

const plugins: NonNullable<ExpoConfig["plugins"]> = [
	"expo-font",
	"expo-localization",
	"expo-router",
	"expo-secure-store",
	"expo-asset",
	"expo-dev-client",
	"@react-native-firebase/app",
	"@react-native-firebase/auth",
	[
		"expo-build-properties",
		{
			ios: {
				// Firebase's iOS SDK ships as static frameworks.
				useFrameworks: "static",
				// Under SDK 54's precompiled React Native, RNFB's pods fail with
				// "include of non-modular header inside framework module" unless
				// they are linked statically. Every RNFB module in package.json
				// must be listed — adding one without listing it here breaks only
				// the iOS build, and only on the build server.
				forceStaticLinking: ["RNFBApp", "RNFBAuth", "RNFBAnalytics"],
			},
		},
	],
	[
		"expo-splash-screen",
		{
			image: "./assets/images/splash-icon.png",
			imageWidth: 180,
			resizeMode: "contain",
			backgroundColor: "#FFF7ED",
			dark: {
				image: "./assets/images/splash-icon.png",
				backgroundColor: "#1A1310",
			},
		},
	],
	[
		"expo-image-picker",
		{
			photosPermission:
				"Pick a photo or your logo to put on the greetings you share.",
			// Library only. Declaring these would add camera and microphone
			// permissions the app never uses, which both stores ask about.
			cameraPermission: false,
			microphonePermission: false,
		},
	],
	[
		"expo-media-library",
		{
			photosPermission: "Save greetings to your photos.",
			savePhotosPermission: "Save greetings to your photos.",
			isAccessMediaLocationEnabled: false,
		},
	],
	[
		"expo-tracking-transparency",
		{ userTrackingPermission: TRACKING_DESCRIPTION },
	],
	[
		"react-native-google-mobile-ads",
		{
			androidAppId: admobAndroidAppId,
			iosAppId: admobIosAppId,
			// Hold measurement until the consent flow in lib/ads/consent.ts has
			// run; starting it at launch would collect before anyone agreed.
			delayAppMeasurementInit: true,
			userTrackingUsageDescription: TRACKING_DESCRIPTION,
		},
	],
];

// Only registered when there is a scheme to give it — the plugin requires one,
// and a placeholder would produce a build that fails at the redirect instead of
// at config time.
if (iosUrlScheme) {
	plugins.push(["@react-native-google-signin/google-signin", { iosUrlScheme }]);
}

const config: ExpoConfig = {
	name: "Greetings",
	slug: "greetings",
	scheme: "greetings",
	version: "1.0.0",
	userInterfaceStyle: "automatic",
	orientation: "portrait",
	icon: "./assets/images/icon.png",
	backgroundColor: "#FFF7ED",
	web: { bundler: "metro", favicon: "./assets/images/favicon.png" },
	ios: {
		bundleIdentifier: BUNDLE_ID,
		googleServicesFile: IOS_CONFIG,
		// Phone-first. iPad runs the iPhone layout, which keeps App Store review
		// from demanding iPad screenshots for a layout nobody designed.
		supportsTablet: false,
		infoPlist: {
			// HTTPS only, standard crypto only: no export-compliance paperwork.
			ITSAppUsesNonExemptEncryption: false,
		},
	},
	android: {
		package: BUNDLE_ID,
		googleServicesFile: ANDROID_CONFIG,
		adaptiveIcon: {
			foregroundImage: "./assets/images/android-icon-foreground.png",
			backgroundImage: "./assets/images/android-icon-background.png",
			monochromeImage: "./assets/images/android-icon-monochrome.png",
			backgroundColor: "#E8590C",
		},
		edgeToEdgeEnabled: true,
		predictiveBackGestureEnabled: false,
		// Declared by media/picker libraries and never needed: saving is
		// write-only (MediaStore, plus WRITE_EXTERNAL_STORAGE on Android 9 and
		// older, which is kept), and picking uses the system photo picker. The
		// READ_MEDIA_* permissions would also put the app through Play's photo
		// and video permissions declaration for no benefit.
		blockedPermissions: [
			"android.permission.RECORD_AUDIO",
			"android.permission.READ_MEDIA_IMAGES",
			"android.permission.READ_MEDIA_VIDEO",
			"android.permission.READ_MEDIA_AUDIO",
			"android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
		],
	},
	plugins,
	experiments: {
		typedRoutes: true,
		reactCompiler: true,
	},
	extra: {
		// Read by lib/firebase.ts through expo-constants. Not a secret — a public
		// OAuth client identifier.
		googleWebClientId,
		// The EAS project (expo.dev/accounts/ashboi005/projects/greetings). Not a
		// secret; overridable for a fork that builds under another account.
		eas: {
			projectId:
				process.env.EAS_PROJECT_ID ?? "9484bd6a-fede-4697-8ed4-9f42aa879663",
		},
	},
	owner: process.env.EAS_OWNER ?? "ashboi005",
};

export default config;
