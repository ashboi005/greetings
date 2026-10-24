/**
 * The app's own UI language. Not to be confused with the *content* languages a
 * user picks in onboarding, which drive the feed and go to the server — this
 * one is purely client-side and never leaves the device.
 * docs/mobile-integration.md §3.
 */
export type AppLanguage = "en" | "hi";

/**
 * Declares one namespace of UI strings.
 *
 * Hindi must carry exactly the English keys: the type below makes a missing or
 * misspelt Hindi key a compile error rather than an English word appearing
 * mid-sentence in a Hindi screen.
 *
 * `{name}` placeholders are filled by `t(key, { name })`.
 */
export function defineStrings<const E extends Record<string, string>>(strings: {
	en: E;
	hi: { [K in keyof E]: string };
}) {
	return strings;
}
