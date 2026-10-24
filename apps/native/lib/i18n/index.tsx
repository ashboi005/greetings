import { getLocales } from "expo-localization";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";

import { getPref, setPref } from "@/lib/prefs";
import type { AppLanguage } from "./define";
import auth from "./strings/auth";
import categories from "./strings/categories";
import common from "./strings/common";
import content from "./strings/content";
import designs from "./strings/designs";
import downloads from "./strings/downloads";
import editor from "./strings/editor";
import feed from "./strings/feed";
import onboarding from "./strings/onboarding";
import profile from "./strings/profile";
import search from "./strings/search";

export type { AppLanguage } from "./define";

/**
 * App UI strings, English and Hindi.
 *
 * Deliberately tiny: a dictionary per screen area, a typed `t()`, and a
 * provider. A full i18n library would buy plural rules and ICU syntax this app
 * does not need, at the cost of another dependency in the bundle.
 *
 * To add a string, add it to both `en` and `hi` in the matching file under
 * strings/ — the types refuse a key that exists in only one of them.
 */

const namespaces = {
	common,
	auth,
	onboarding,
	feed,
	categories,
	search,
	content,
	downloads,
	designs,
	editor,
	profile,
};

type Namespaces = typeof namespaces;

export type StringKey = {
	[N in keyof Namespaces]: `${N & string}.${keyof Namespaces[N]["en"] & string}`;
}[keyof Namespaces];

type Params = Record<string, string | number>;

export function translate(
	language: AppLanguage,
	key: StringKey,
	params?: Params,
): string {
	const dot = key.indexOf(".");
	const ns = key.slice(0, dot) as keyof Namespaces;
	const name = key.slice(dot + 1);

	const table = namespaces[ns][language] as Record<string, string>;
	const fallback = namespaces[ns].en as Record<string, string>;
	let text = table[name] ?? fallback[name] ?? key;

	if (params) {
		for (const [k, v] of Object.entries(params)) {
			text = text.replaceAll(`{${k}}`, String(v));
		}
	}
	return text;
}

function initialLanguage(): { language: AppLanguage; chosen: boolean } {
	const stored = getPref("appLanguage");
	if (stored === "en" || stored === "hi") {
		return { language: stored, chosen: true };
	}
	// A suggestion only, until the person picks on the first screen.
	const device = getLocales()[0]?.languageCode;
	return { language: device === "hi" ? "hi" : "en", chosen: false };
}

interface I18nContextValue {
	language: AppLanguage;
	/** False until the person has picked a language on the first screen. */
	hasChosenLanguage: boolean;
	setLanguage: (language: AppLanguage) => void;
	t: (key: StringKey, params?: Params) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState(initialLanguage);

	const setLanguage = useCallback((language: AppLanguage) => {
		setPref("appLanguage", language);
		setState({ language, chosen: true });
	}, []);

	const value = useMemo<I18nContextValue>(
		() => ({
			language: state.language,
			hasChosenLanguage: state.chosen,
			setLanguage,
			t: (key, params) => translate(state.language, key, params),
		}),
		[state, setLanguage],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
	const value = useContext(I18nContext);
	if (!value) throw new Error("useI18n must be used within I18nProvider");
	return value;
}

/** Shorthand for the common case: `const t = useT(); t("feed.title")`. */
export function useT() {
	return useI18n().t;
}
