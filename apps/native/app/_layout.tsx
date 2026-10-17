import "@/global.css";
import {
	Poppins_600SemiBold,
	Poppins_700Bold,
	useFonts,
} from "@expo-google-fonts/poppins";
import {
	DarkTheme,
	DefaultTheme,
	type Theme,
	ThemeProvider,
} from "@react-navigation/native";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider, useThemeColor } from "heroui-native";
import { type ReactNode, useEffect, useMemo } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { AppThemeProvider, useAppTheme } from "@/contexts/app-theme-context";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { initAdsAndConsent, useAdsState } from "@/lib/ads/consent";
import { preloadInterstitial } from "@/lib/ads/interstitial";
import { trackScreen } from "@/lib/analytics";
import { I18nProvider } from "@/lib/i18n";
import { queryClient } from "@/lib/query-client";

// Held until the session is restored and the heading font is in, so the first
// thing anyone sees is the right screen in the right font — not a flash of the
// sign-in screen for someone who is already signed in.
void SplashScreen.preventAutoHideAsync().catch(() => {});

export const unstable_settings = {
	initialRouteName: "(app)",
};

/**
 * Screen views for analytics, named by route *pattern* — `content/[id]`, never
 * `content/9f2…`. Ids, and anything a user typed, stay out of analytics (§14).
 */
function ScreenTracker() {
	const segments = useSegments();
	const name = segments.filter((s) => !s.startsWith("(")).join("/") || "home";

	useEffect(() => {
		trackScreen(name);
	}, [name]);

	return null;
}

/** Consent → ATT → ads SDK, once, after the first frame is up. */
function AdsBootstrap() {
	const { canRequestAds } = useAdsState();

	useEffect(() => {
		void initAdsAndConsent();
	}, []);

	useEffect(() => {
		if (canRequestAds) preloadInterstitial();
	}, [canRequestAds]);

	return null;
}

function SplashGate({ fontsReady }: { fontsReady: boolean }) {
	const { isLoading } = useAuth();

	useEffect(() => {
		if (fontsReady && !isLoading) void SplashScreen.hideAsync().catch(() => {});
	}, [fontsReady, isLoading]);

	return null;
}

/**
 * React Navigation paints every screen and the tab bar with its own theme,
 * whose default background is a flat grey (#F2F2F2) that shows through any
 * screen without its own background. Feeding it our tokens makes every
 * navigator match global.css, in light and dark.
 */
function NavigationTheme({ children }: { children: ReactNode }) {
	const { isDark } = useAppTheme();
	const [background, surface, foreground, border, accent, danger] =
		useThemeColor([
			"background",
			"surface",
			"foreground",
			"border",
			"accent",
			"danger",
		]);

	const theme = useMemo<Theme>(() => {
		const base = isDark ? DarkTheme : DefaultTheme;
		return {
			...base,
			colors: {
				...base.colors,
				background,
				card: surface,
				text: foreground,
				border,
				primary: accent,
				notification: danger,
			},
		};
	}, [isDark, background, surface, foreground, border, accent, danger]);

	return <ThemeProvider value={theme}>{children}</ThemeProvider>;
}

function ThemedStatusBar() {
	const { isDark } = useAppTheme();
	return <StatusBar style={isDark ? "light" : "dark"} />;
}

function StackLayout() {
	return (
		<Stack screenOptions={{ headerShown: false }}>
			<Stack.Screen name="(app)" />
			<Stack.Screen name="(auth)" />
			<Stack.Screen name="(onboarding)" />
		</Stack>
	);
}

export default function Layout() {
	// A font that fails to load must not hold the app hostage behind the splash;
	// headings fall back to the system face.
	const [fontsLoaded, fontError] = useFonts({
		Poppins_600SemiBold,
		Poppins_700Bold,
	});

	return (
		<QueryClientProvider client={queryClient}>
			<GestureHandlerRootView style={{ flex: 1 }}>
				<KeyboardProvider>
					<AppThemeProvider>
						<HeroUINativeProvider>
							<I18nProvider>
								<AuthProvider>
									<ThemedStatusBar />
									<NavigationTheme>
										<StackLayout />
									</NavigationTheme>
									<ScreenTracker />
									<AdsBootstrap />
									<SplashGate fontsReady={fontsLoaded || Boolean(fontError)} />
								</AuthProvider>
							</I18nProvider>
						</HeroUINativeProvider>
					</AppThemeProvider>
				</KeyboardProvider>
			</GestureHandlerRootView>
		</QueryClientProvider>
	);
}
