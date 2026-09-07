import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useThemeColor } from "heroui-native";
import React from "react";

export default function TabsLayout() {
	const themeColorForeground = useThemeColor("foreground");
	const themeColorBackground = useThemeColor("background");

	return (
		<Tabs
			screenOptions={{
				headerShown: false,
				tabBarActiveTintColor: "#6366F1",
				tabBarInactiveTintColor: themeColorForeground,
				tabBarStyle: {
					backgroundColor: themeColorBackground,
					borderTopWidth: 1,
					borderTopColor: "rgba(0,0,0,0.1)",
				},
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					title: "Feed",
					tabBarIcon: ({ color, size }) => (
						<Ionicons name="images-outline" size={size} color={color} />
					),
				}}
			/>
			<Tabs.Screen
				name="search"
				options={{
					title: "Search",
					tabBarIcon: ({ color, size }) => (
						<Ionicons name="search-outline" size={size} color={color} />
					),
				}}
			/>
			<Tabs.Screen
				name="downloads"
				options={{
					title: "Downloads",
					tabBarIcon: ({ color, size }) => (
						<Ionicons name="download-outline" size={size} color={color} />
					),
				}}
			/>
			<Tabs.Screen
				name="designs"
				options={{
					title: "My Designs",
					tabBarIcon: ({ color, size }) => (
						<Ionicons name="create-outline" size={size} color={color} />
					),
				}}
			/>
			<Tabs.Screen
				name="profile"
				options={{
					title: "Profile",
					tabBarIcon: ({ color, size }) => (
						<Ionicons name="person-outline" size={size} color={color} />
					),
				}}
			/>
		</Tabs>
	);
}
