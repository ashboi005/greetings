import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { Drawer } from "expo-router/drawer";
import { useThemeColor } from "heroui-native";
import { useCallback } from "react";
import { Pressable, Text } from "react-native";

import { ThemeToggle } from "@/components/theme-toggle";

function DrawerLayout() {
	const themeColorForeground = useThemeColor("foreground");
	const themeColorBackground = useThemeColor("background");

	const renderThemeToggle = useCallback(() => <ThemeToggle />, []);

	return (
		<Drawer
			screenOptions={{
				headerTintColor: themeColorForeground,
				headerStyle: { backgroundColor: themeColorBackground },
				headerTitleStyle: {
					fontWeight: "600",
					color: themeColorForeground,
				},
				headerRight: renderThemeToggle,
				drawerStyle: { backgroundColor: themeColorBackground },
			}}
		>
			<Drawer.Screen
				name="(tabs)"
				options={{
					headerTitle: "Greetings",
					drawerLabel: ({
						color,
						focused,
					}: {
						color: string;
						focused: boolean;
					}) => (
						<Text style={{ color: focused ? color : themeColorForeground }}>
							Home
						</Text>
					),
					drawerIcon: ({
						size,
						color,
						focused,
					}: {
						size: number;
						color: string;
						focused: boolean;
					}) => (
						<Ionicons
							name="home-outline"
							size={size}
							color={focused ? color : themeColorForeground}
						/>
					),
					headerRight: () => (
						<Link href="/modal" asChild>
							<Pressable className="mr-4">
								<Ionicons
									name="add-outline"
									size={24}
									color={themeColorForeground}
								/>
							</Pressable>
						</Link>
					),
				}}
			/>
		</Drawer>
	);
}

export default DrawerLayout;
