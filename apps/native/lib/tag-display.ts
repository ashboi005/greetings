import type { AppLanguage } from "@/lib/i18n";
import type { Tag } from "@/lib/types";

/**
 * How a tag looks in the app: an emoji, and its name in the UI language.
 *
 * Presentation only — the tags themselves are fetched, because admins add,
 * rename and retire them at runtime (§3). So everything here is keyed by slug
 * and optional: a tag added tomorrow still shows, with its category's emoji
 * and the label the server sends.
 *
 * Emoji are limited to Unicode 9 and older. Newer ones (🪔 diya, 🪁 kite, 🦚
 * peacock) render as empty boxes on Android 7–9, still common on the budget
 * phones this audience uses.
 */

interface TagLook {
	emoji: string;
	hi: string;
}

const LOOKS: Record<string, TagLook> = {
	// Occasions
	"good-morning": { emoji: "🌄", hi: "सुप्रभात" },
	"good-night": { emoji: "🌙", hi: "शुभ रात्रि" },
	birthday: { emoji: "🎂", hi: "जन्मदिन" },
	anniversary: { emoji: "💑", hi: "सालगिरह" },
	congratulations: { emoji: "🎊", hi: "बधाई" },
	"thank-you": { emoji: "💝", hi: "धन्यवाद" },
	"get-well-soon": { emoji: "💐", hi: "जल्दी ठीक हों" },
	condolence: { emoji: "🕊️", hi: "श्रद्धांजलि" },

	// Festivals
	diwali: { emoji: "🎆", hi: "दीवाली" },
	holi: { emoji: "🎨", hi: "होली" },
	"raksha-bandhan": { emoji: "🎀", hi: "रक्षा बंधन" },
	"ganesh-chaturthi": { emoji: "🐘", hi: "गणेश चतुर्थी" },
	navratri: { emoji: "🔱", hi: "नवरात्रि" },
	"durga-puja": { emoji: "🔱", hi: "दुर्गा पूजा" },
	janmashtami: { emoji: "🎶", hi: "जन्माष्टमी" },
	"karva-chauth": { emoji: "🌕", hi: "करवा चौथ" },
	"chhath-puja": { emoji: "🌅", hi: "छठ पूजा" },
	"makar-sankranti": { emoji: "🌞", hi: "मकर संक्रांति" },
	pongal: { emoji: "🍚", hi: "पोंगल" },
	onam: { emoji: "🌼", hi: "ओणम" },
	baisakhi: { emoji: "🌾", hi: "बैसाखी" },
	"gudi-padwa": { emoji: "🌸", hi: "गुड़ी पड़वा" },
	ugadi: { emoji: "🌿", hi: "उगादि" },
	eid: { emoji: "🌙", hi: "ईद" },
	christmas: { emoji: "🎄", hi: "क्रिसमस" },
	"new-year": { emoji: "🎉", hi: "नया साल" },
	"independence-day": { emoji: "🇮🇳", hi: "स्वतंत्रता दिवस" },
	"republic-day": { emoji: "🇮🇳", hi: "गणतंत्र दिवस" },

	// Themes
	devotional: { emoji: "🙏", hi: "भक्ति" },
	motivational: { emoji: "💪", hi: "प्रेरणा" },
	quotes: { emoji: "💬", hi: "सुविचार" },
	shayari: { emoji: "✍️", hi: "शायरी" },
	love: { emoji: "❤️", hi: "प्यार" },
	family: { emoji: "👨‍👩‍👧", hi: "परिवार" },
	friendship: { emoji: "🤝", hi: "दोस्ती" },
	flowers: { emoji: "🌷", hi: "फूल" },
	nature: { emoji: "🌳", hi: "प्रकृति" },
	humour: { emoji: "😄", hi: "हँसी-मज़ाक" },
};

const CATEGORY_EMOJI: Record<string, string> = {
	occasion: "💌",
	festival: "🎉",
	theme: "✨",
};

/** The emoji for a tag, falling back to its category's. */
export function tagEmoji(tag: Tag): string {
	return LOOKS[tag.slug]?.emoji ?? CATEGORY_EMOJI[tag.category] ?? "✨";
}

/** The tag's name in the UI language; the server's label when untranslated. */
export function tagLabel(tag: Tag, language: AppLanguage): string {
	if (language === "hi") return LOOKS[tag.slug]?.hi ?? tag.label;
	return tag.label;
}

/**
 * Orders tags within a category: the ones listed above first, in that order —
 * everyday occasions like Good Morning lead, since they are shared daily —
 * then anything new, alphabetically.
 */
const ORDER = Object.keys(LOOKS);

export function sortForDisplay(tags: Tag[]): Tag[] {
	const rank = (tag: Tag) => {
		const index = ORDER.indexOf(tag.slug);
		return index === -1 ? ORDER.length : index;
	};
	return [...tags].sort(
		(a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label),
	);
}
