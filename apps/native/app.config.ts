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
const ANDROID_CONFIG = path.join(PROJECT_ROOT, "google-services.json");
const IOS_CONFIG = path.join(PROJECT_ROOT, "GoogleService-Info.plist");

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

const plugins: NonNullable<ExpoConfig["plugins"]> = [
	"expo-font",
	"expo-localization",
	"expo-router",
	"expo-secure-store",
	"expo-asset",
	"@react-native-firebase/app",
	"@react-native-firebase/auth",
	// Firebase's iOS SDK is distributed as static frameworks.
	["expo-build-properties", { ios: { useFrameworks: "static" } }],
];

// Only registered when there is a scheme to give it — the plugin requires one,
// and a placeholder would produce a build that fails at the redirect instead of
// at config time.
if (iosUrlScheme) {
	plugins.splice(7, 0, [
		"@react-native-google-signin/google-signin",
		{ iosUrlScheme },
	]);
}

const config: ExpoConfig = {
	name: "greetings",
	slug: "greetings",
	scheme: "greetings",
	userInterfaceStyle: "automatic",
	orientation: "default",
	web: { bundler: "metro" },
	ios: {
		bundleIdentifier: BUNDLE_ID,
		googleServicesFile: "./GoogleService-Info.plist",
	},
	android: {
		package: BUNDLE_ID,
		googleServicesFile: "./google-services.json",
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
	},
};

export default config;
