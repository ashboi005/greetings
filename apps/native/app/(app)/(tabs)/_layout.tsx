import { Ionicons } from "@expo/vector-icons";
import { BottomTabBar } from "@react-navigation/bottom-tabs";
import { Tabs } from "expo-router";
import { useThemeColor } from "heroui-native";
import { View } from "react-native";

import { BannerSlot } from "@/components/ads/banner-slot";
import { useT } from "@/lib/i18n";

type IconName = keyof typeof Ionicons.glyphMap;

/** Outline when idle, filled when selected — a second cue besides colour. */
function tabIcon(idle: IconName, active: IconName) {
	return ({ color, focused }: { color: string; focused: boolean }) => (
		<Ionicons name={focused ? active : idle} size={24} color={color} />
	);
}

/**
 * The five tabs, with the banner ad sitting directly on top of the tab bar.
 *
 * The banner goes in a custom `tabBar` rather than in each screen so it is in
 * one place, in normal layout flow (its reserved height pushes screens up
 * rather than covering them), and absent from every screen pushed over the
 * tabs — detail, customise, the design editor (§15).
 */
export default function TabsLayout() {
	const t = useT();
	const [accent, muted, background, border] = useThemeColor([
		"accent",
		"muted",
		"background",
		"border",
	]);

	return (
		<Tabs
			tabBar={(props) => (
				<View>
					<BannerSlot />
					<BottomTabBar {...props} />
				</View>
			)}
			screenOptions={{
				headerShown: false,
				tabBarActiveTintColor: accent,
				tabBarInactiveTintColor: muted,
				tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
				tabBarStyle: {
					backgroundColor: background,
					borderTopColor: border,
				},
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					title: t("common.tabHome"),
					tabBarIcon: tabIcon("home-outline", "home"),
				}}
			/>
			<Tabs.Screen
				name="search"
				options={{
					title: t("common.tabSearch"),
					tabBarIcon: tabIcon("search-outline", "search"),
				}}
			/>
			<Tabs.Screen
				name="downloads"
				options={{
					title: t("common.tabDownloads"),
					tabBarIcon: tabIcon("bookmark-outline", "bookmark"),
				}}
			/>
			<Tabs.Screen
				name="designs"
				options={{
					title: t("common.tabDesigns"),
					tabBarIcon: tabIcon("brush-outline", "brush"),
				}}
			/>
			<Tabs.Screen
				name="profile"
				options={{
					title: t("common.tabProfile"),
					tabBarIcon: tabIcon("person-circle-outline", "person-circle"),
				}}
			/>
		</Tabs>
	);
}
