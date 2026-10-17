import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { Uniwind, useUniwind } from "uniwind";

import { getPref, setPref } from "@/lib/prefs";

/** "system" follows the phone's light/dark setting, and is the default. */
export type ThemePreference = "system" | "light" | "dark";

function storedPreference(): ThemePreference {
	const stored = getPref("theme");
	return stored === "light" || stored === "dark" ? stored : "system";
}

// Applied before the first render so a dark-mode user never sees a light frame.
Uniwind.setTheme(storedPreference());

type AppThemeContextType = {
	currentTheme: string;
	preference: ThemePreference;
	isLight: boolean;
	isDark: boolean;
	setPreference: (preference: ThemePreference) => void;
};

const AppThemeContext = createContext<AppThemeContextType | undefined>(
	undefined,
);

export const AppThemeProvider = ({
	children,
}: {
	children: React.ReactNode;
}) => {
	const { theme } = useUniwind();
	const [preference, setPreferenceState] = useState(storedPreference);

	const setPreference = useCallback((next: ThemePreference) => {
		setPref("theme", next === "system" ? null : next);
		setPreferenceState(next);
		Uniwind.setTheme(next);
	}, []);

	const value = useMemo(
		() => ({
			currentTheme: theme,
			preference,
			isLight: theme === "light",
			isDark: theme === "dark",
			setPreference,
		}),
		[theme, preference, setPreference],
	);

	return (
		<AppThemeContext.Provider value={value}>
			{children}
		</AppThemeContext.Provider>
	);
};

export function useAppTheme() {
	const context = useContext(AppThemeContext);
	if (!context) {
		throw new Error("useAppTheme must be used within AppThemeProvider");
	}
	return context;
}
