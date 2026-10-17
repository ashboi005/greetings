import { Ionicons } from "@expo/vector-icons";
import { cn, useThemeColor } from "heroui-native";
import { Pressable, Text, View } from "react-native";

import { useT } from "@/lib/i18n";
import type { Language } from "@/lib/types";

/** The server accepts 1–10 content languages (§3). */
export const MAX_LANGUAGES = 10;

/**
 * Multi-select of *content* languages — what greetings to show, not what
 * language the app speaks (§3 is emphatic that the two never mix).
 *
 * Each card leads with the language's own name in its own script: "मराठी" is
 * recognised at a glance by the person it is for, "Marathi" is a foreign word
 * to them. The English name sits underneath for everyone else. System font on
 * purpose — the heading face carries Latin and Devanagari only, and these
 * names span a dozen scripts.
 */
export function LanguageSelect({
	languages,
	selected,
	onChange,
}: {
	languages: Language[];
	selected: string[];
	onChange: (next: string[]) => void;
}) {
	const t = useT();
	const accentSoftForeground = useThemeColor("accent-soft-foreground");
	const atLimit = selected.length >= MAX_LANGUAGES;

	const toggle = (code: string) => {
		if (selected.includes(code)) {
			onChange(selected.filter((c) => c !== code));
		} else if (!atLimit) {
			onChange([...selected, code]);
		}
	};

	return (
		<View>
			<View className="flex-row flex-wrap gap-3">
				{languages.map((language) => {
					const isSelected = selected.includes(language.code);
					const isBlocked = atLimit && !isSelected;
					return (
						<Pressable
							key={language.code}
							onPress={() => toggle(language.code)}
							disabled={isBlocked}
							accessibilityRole="checkbox"
							accessibilityState={{
								checked: isSelected,
								disabled: isBlocked,
							}}
							accessibilityLabel={`${language.nativeName}, ${language.name}`}
							style={{ flexBasis: "45%", flexGrow: 1 }}
							className={cn(
								"min-h-16 flex-row items-center gap-2 rounded-2xl border-2 px-4 py-3",
								isSelected
									? "border-accent bg-accent-soft"
									: "border-border bg-surface",
								isBlocked && "opacity-50",
							)}
						>
							<View className="flex-1">
								<Text
									numberOfLines={1}
									className="font-semibold text-foreground text-xl"
								>
									{language.nativeName}
								</Text>
								{language.nativeName !== language.name ? (
									<Text numberOfLines={1} className="text-muted text-sm">
										{language.name}
									</Text>
								) : null}
							</View>
							{isSelected ? (
								<Ionicons
									name="checkmark-circle"
									size={24}
									color={accentSoftForeground}
								/>
							) : null}
						</Pressable>
					);
				})}
			</View>
			{atLimit ? (
				<Text className="mt-3 text-base text-muted">
					{t("common.languagesLimit", { max: MAX_LANGUAGES })}
				</Text>
			) : null}
		</View>
	);
}
