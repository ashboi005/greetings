/**
 * Bundled fonts for everything drawn onto an image.
 *
 * Bundled rather than system fonts because a name is the one thing on a
 * customised greeting that must never render as boxes, and Indic shaping
 * varies across Android OEMs (docs/mobile-integration.md §9). Skia gets its
 * own font provider — it cannot see fonts loaded through expo-font — and
 * every paragraph lists the display font first and the Noto script fonts
 * after it, so whatever script someone types falls through to a face that
 * has it.
 *
 * Loaded once per app run and shared: about 4 MB of TTFs, which is not
 * something to re-read every time an editor opens.
 */

import { Kalam_400Regular } from "@expo-google-fonts/kalam/400Regular";
import { Kalam_700Bold } from "@expo-google-fonts/kalam/700Bold";
import { NotoSansBengali_400Regular } from "@expo-google-fonts/noto-sans-bengali/400Regular";
import { NotoSansBengali_700Bold } from "@expo-google-fonts/noto-sans-bengali/700Bold";
import { NotoSansDevanagari_400Regular } from "@expo-google-fonts/noto-sans-devanagari/400Regular";
import { NotoSansDevanagari_700Bold } from "@expo-google-fonts/noto-sans-devanagari/700Bold";
import { NotoSansGujarati_400Regular } from "@expo-google-fonts/noto-sans-gujarati/400Regular";
import { NotoSansGujarati_700Bold } from "@expo-google-fonts/noto-sans-gujarati/700Bold";
import { NotoSansGurmukhi_400Regular } from "@expo-google-fonts/noto-sans-gurmukhi/400Regular";
import { NotoSansGurmukhi_700Bold } from "@expo-google-fonts/noto-sans-gurmukhi/700Bold";
import { NotoSansKannada_400Regular } from "@expo-google-fonts/noto-sans-kannada/400Regular";
import { NotoSansKannada_700Bold } from "@expo-google-fonts/noto-sans-kannada/700Bold";
import { NotoSansMalayalam_400Regular } from "@expo-google-fonts/noto-sans-malayalam/400Regular";
import { NotoSansMalayalam_700Bold } from "@expo-google-fonts/noto-sans-malayalam/700Bold";
import { NotoSansTamil_400Regular } from "@expo-google-fonts/noto-sans-tamil/400Regular";
import { NotoSansTamil_700Bold } from "@expo-google-fonts/noto-sans-tamil/700Bold";
import { NotoSansTelugu_400Regular } from "@expo-google-fonts/noto-sans-telugu/400Regular";
import { NotoSansTelugu_700Bold } from "@expo-google-fonts/noto-sans-telugu/700Bold";
import { NotoSerif_400Regular } from "@expo-google-fonts/noto-serif/400Regular";
import { NotoSerif_700Bold } from "@expo-google-fonts/noto-serif/700Bold";
import { Poppins_400Regular } from "@expo-google-fonts/poppins/400Regular";
import { Poppins_700Bold } from "@expo-google-fonts/poppins/700Bold";
import { Skia, type SkTypefaceFontProvider } from "@shopify/react-native-skia";
import { useEffect, useState } from "react";
import { Image } from "react-native";

import type { StringKey } from "@/lib/i18n";
import type { FontId } from "./scene";

/** Display fonts offered in the editors, in the order they are shown. */
export const FONTS: { id: FontId; family: string; label: StringKey }[] = [
	{ id: "poppins", family: "Poppins", label: "editor.fontClean" },
	{ id: "kalam", family: "Kalam", label: "editor.fontHandwritten" },
	{ id: "serif", family: "Noto Serif", label: "editor.fontClassic" },
];

/**
 * Script fallbacks, after the display font. Devanagari first: it is the most
 * common script typed here, and neither Noto Serif nor the system face on
 * some phones carries it.
 */
const SCRIPT_FAMILIES = [
	"Noto Sans Devanagari",
	"Noto Sans Bengali",
	"Noto Sans Gujarati",
	"Noto Sans Gurmukhi",
	"Noto Sans Kannada",
	"Noto Sans Malayalam",
	"Noto Sans Tamil",
	"Noto Sans Telugu",
];

const SOURCES: Record<string, number[]> = {
	Poppins: [Poppins_400Regular, Poppins_700Bold],
	Kalam: [Kalam_400Regular, Kalam_700Bold],
	"Noto Serif": [NotoSerif_400Regular, NotoSerif_700Bold],
	"Noto Sans Devanagari": [
		NotoSansDevanagari_400Regular,
		NotoSansDevanagari_700Bold,
	],
	"Noto Sans Bengali": [NotoSansBengali_400Regular, NotoSansBengali_700Bold],
	"Noto Sans Gujarati": [NotoSansGujarati_400Regular, NotoSansGujarati_700Bold],
	"Noto Sans Gurmukhi": [NotoSansGurmukhi_400Regular, NotoSansGurmukhi_700Bold],
	"Noto Sans Kannada": [NotoSansKannada_400Regular, NotoSansKannada_700Bold],
	"Noto Sans Malayalam": [
		NotoSansMalayalam_400Regular,
		NotoSansMalayalam_700Bold,
	],
	"Noto Sans Tamil": [NotoSansTamil_400Regular, NotoSansTamil_700Bold],
	"Noto Sans Telugu": [NotoSansTelugu_400Regular, NotoSansTelugu_700Bold],
};

/** The family list for a paragraph: chosen display font, then every script. */
export function fontFamilies(font: FontId): string[] {
	const display = FONTS.find((f) => f.id === font)?.family ?? "Poppins";
	return [display, ...SCRIPT_FAMILIES];
}

let loading: Promise<SkTypefaceFontProvider> | null = null;

/**
 * Skia's own `useFonts` swallows a failed load and stays null forever, which
 * would leave an editor spinning; this one rejects, and a failed attempt is
 * forgotten so the next editor that opens tries again.
 */
function loadFontProvider(): Promise<SkTypefaceFontProvider> {
	loading ??= (async () => {
		const provider = Skia.TypefaceFontProvider.Make();
		const entries = Object.entries(SOURCES).flatMap(([family, modules]) =>
			modules.map((m) => [family, m] as const),
		);
		await Promise.all(
			entries.map(async ([family, module]) => {
				const data = await Skia.Data.fromURI(
					Image.resolveAssetSource(module).uri,
				);
				const typeface = Skia.Typeface.MakeFreeTypeFaceFromData(data);
				if (!typeface) throw new Error(`Could not load font ${family}`);
				provider.registerFont(typeface, family);
			}),
		);
		return provider;
	})().catch((cause) => {
		loading = null;
		throw cause;
	});
	return loading;
}

export type FontState =
	| { status: "loading" }
	| { status: "ready"; provider: SkTypefaceFontProvider }
	| { status: "error" };

export function useFontProvider(): { state: FontState; retry: () => void } {
	const [state, setState] = useState<FontState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let live = true;
		setState({ status: "loading" });
		loadFontProvider().then(
			(provider) => {
				if (live) setState({ status: "ready", provider });
			},
			() => {
				if (live) setState({ status: "error" });
			},
		);
		return () => {
			live = false;
		};
	}, [attempt]);

	return { state, retry: () => setAttempt((n) => n + 1) };
}
