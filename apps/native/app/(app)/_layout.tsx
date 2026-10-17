import { Stack } from "expo-router";

/**
 * Everything behind sign-in and onboarding. The tabs sit at the bottom of this
 * stack and every detail or editor screen pushes over them, which also keeps
 * the tab bar's banner ad off the editing canvas (§15 rule 3).
 */
export default function AppLayout() {
	return (
		<Stack screenOptions={{ headerShown: false }}>
			<Stack.Screen name="(tabs)" />
			<Stack.Screen name="content/[id]" />
			<Stack.Screen name="customize/[id]" options={{ gestureEnabled: false }} />
			<Stack.Screen name="design/[id]" options={{ gestureEnabled: false }} />
		</Stack>
	);
}
