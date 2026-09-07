import axios from "axios";
import { useRootNavigationState, useRouter, useSegments } from "expo-router";
import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { ActivityIndicator, View } from "react-native";

import { setUnauthenticatedHandler } from "@/lib/api";
import { signOutOfFirebase } from "@/lib/firebase";
import { queryClient } from "@/lib/query-client";
import { authWithFirebase, getProfile } from "@/lib/services";
import { TOKEN_STORAGE_KEY, tokenStorage } from "@/lib/storage";
import type { UserProfile } from "@/lib/types";

/**
 * The app's session, and the only thing that decides which route group you are
 * in (spec §11.1).
 *
 * Firebase authenticates the person on the device; that is the whole login. The
 * ID token it produces is traded once at `POST /v1/auth/firebase` for our own
 * session token, which every later request carries as a bearer. There is no
 * Better Auth client in this app — the panels have one, we do not.
 *
 * Routing lives here rather than in the screens because three inputs decide it
 * — is there a token, is the profile onboarded, and has the navigator mounted —
 * and a screen that owns only one of them will guess wrong about the others.
 */

/**
 * `loading` is the cold-start read of secure storage. It matters as a distinct
 * state because "no token yet" and "no token" would otherwise be the same
 * value, and the guard would bounce a signed-in user to sign-in on every launch.
 */
type AuthStatus = "loading" | "signedOut" | "signedIn";

interface AuthContextType {
	token: string | null;
	userProfile: UserProfile | null;
	status: AuthStatus;
	/** True while cold-start storage and profile reads are in flight. */
	isLoading: boolean;
	/**
	 * True only during an explicit sign-in.
	 *
	 * Separate from `isLoading` so the sign-in screen can show a spinner without
	 * the guard treating the app as still booting and re-running its redirects.
	 */
	isSigningIn: boolean;
	signInWithFirebaseToken: (idToken: string) => Promise<void>;
	signOut: () => Promise<void>;
	refreshProfile: () => Promise<UserProfile | null>;
}

const AuthContext = createContext<AuthContextType>({
	token: null,
	userProfile: null,
	status: "loading",
	isLoading: true,
	isSigningIn: false,
	signInWithFirebaseToken: async () => {},
	signOut: async () => {},
	refreshProfile: async () => null,
});

/**
 * Why a profile read failed, because the two answers are not interchangeable.
 *
 * A 401 means the session is genuinely gone and signing out is correct. Anything
 * else — a flaky connection on a train, a cold API — must leave the session
 * alone. Collapsing them is how an app logs people out for being offline.
 */
type ProfileOutcome =
	| { ok: true; profile: UserProfile }
	| { ok: false; reason: "unauthenticated" | "unavailable" };

async function readProfile(): Promise<ProfileOutcome> {
	try {
		return { ok: true, profile: await getProfile() };
	} catch (cause) {
		const status = axios.isAxiosError(cause)
			? cause.response?.status
			: undefined;
		return {
			ok: false,
			reason: status === 401 ? "unauthenticated" : "unavailable",
		};
	}
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
	const [token, setToken] = useState<string | null>(null);
	const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
	const [status, setStatus] = useState<AuthStatus>("loading");
	const [isSigningIn, setIsSigningIn] = useState(false);

	const router = useRouter();
	const segments = useSegments();
	const navigationState = useRootNavigationState();

	const handleSignOut = useCallback(async () => {
		await tokenStorage.deleteItem(TOKEN_STORAGE_KEY);
		setToken(null);
		setUserProfile(null);
		setStatus("signedOut");

		// Firebase keeps its own session, and a lingering `currentUser` can mint a
		// fresh ID token that the exchange would honour — a signed-out app quietly
		// signing itself back in.
		await signOutOfFirebase();

		// Every cached query was fetched as the previous user. Without this the
		// next person to sign in on this device sees their feed, their downloads
		// and their designs until each query happens to refetch.
		queryClient.clear();
	}, []);

	// The axios interceptor has already discarded the token by the time this
	// runs; this is what tells React about it.
	useEffect(() => {
		setUnauthenticatedHandler(() => {
			void handleSignOut();
		});
	}, [handleSignOut]);

	const refreshProfile = useCallback(async (): Promise<UserProfile | null> => {
		const outcome = await readProfile();
		if (!outcome.ok) return null;
		setUserProfile(outcome.profile);
		return outcome.profile;
	}, []);

	const signInWithFirebaseToken = useCallback(
		async (idToken: string) => {
			setIsSigningIn(true);
			try {
				const session = await authWithFirebase(idToken);
				await tokenStorage.setItem(TOKEN_STORAGE_KEY, session.token);

				// Anything cached belongs to whoever was signed in before.
				queryClient.clear();

				setToken(session.token);
				const profile = await refreshProfile();

				// `onboarded` comes back from the exchange too, and is the fallback
				// when the profile read itself failed — better than assuming the
				// person still needs onboarding and looping them through it.
				setStatus("signedIn");
				if (!profile && !session.onboarded) {
					router.replace("/(onboarding)");
				}
			} finally {
				setIsSigningIn(false);
			}
		},
		[refreshProfile, router],
	);

	// Cold start: is there a session on this device, and is it still good?
	useEffect(() => {
		let cancelled = false;

		async function restore() {
			try {
				const stored = await tokenStorage.getItem(TOKEN_STORAGE_KEY);
				if (cancelled) return;

				if (!stored) {
					setStatus("signedOut");
					return;
				}

				setToken(stored);
				const outcome = await readProfile();
				if (cancelled) return;

				if (outcome.ok) {
					setUserProfile(outcome.profile);
					setStatus("signedIn");
					return;
				}

				if (outcome.reason === "unauthenticated") {
					await handleSignOut();
					return;
				}

				// Unreachable API. Keep the session and let the screens report their
				// own failures; the profile will resolve on the next successful
				// request. Onboarding cannot be judged from here, and the guard
				// treats an unknown profile as "do not redirect".
				setStatus("signedIn");
			} catch {
				if (!cancelled) await handleSignOut();
			}
		}

		void restore();
		return () => {
			cancelled = true;
		};
	}, [handleSignOut]);

	// The guard. Every redirect in the app is one of these three.
	useEffect(() => {
		// `router.replace` before the root navigator has mounted is dropped, and
		// the app is then stuck wherever it started.
		if (!navigationState?.key) return;
		if (status === "loading" || isSigningIn) return;

		const group = segments[0];
		const inAuthGroup = group === "(auth)";
		const inOnboarding = group === "(onboarding)";

		if (status === "signedOut") {
			if (!inAuthGroup) router.replace("/(auth)/sign-in");
			return;
		}

		// A user with no region has never finished onboarding, and the feed would
		// be a bare global list forever. `created` is not the test — someone who
		// killed the app mid-onboarding comes back with `created: false`.
		if (userProfile && !userProfile.onboarded) {
			if (!inOnboarding) router.replace("/(onboarding)");
			return;
		}

		if (inAuthGroup || (inOnboarding && userProfile?.onboarded)) {
			router.replace("/(drawer)/(tabs)");
		}
	}, [
		navigationState?.key,
		status,
		isSigningIn,
		segments,
		userProfile,
		router,
	]);

	return (
		<AuthContext.Provider
			value={{
				token,
				userProfile,
				status,
				isLoading: status === "loading",
				isSigningIn,
				signInWithFirebaseToken,
				signOut: handleSignOut,
				refreshProfile,
			}}
		>
			{children}
			{status === "loading" ? <BootOverlay /> : null}
		</AuthContext.Provider>
	);
}

/**
 * Covers the navigator until the guard has had a chance to run.
 *
 * An overlay rather than rendering the children conditionally: the root
 * navigator has to be mounted for the guard's `replace` to land, so it cannot be
 * withheld while we decide where to send someone.
 */
function BootOverlay() {
	return (
		<View
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				alignItems: "center",
				justifyContent: "center",
			}}
			className="bg-background"
		>
			<ActivityIndicator size="large" />
		</View>
	);
}

export const useAuth = () => useContext(AuthContext);
