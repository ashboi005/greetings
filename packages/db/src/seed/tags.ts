/**
 * Tag taxonomy (spec §4.3).
 *
 * Slugs are the stable identity; labels are display text and may be edited.
 * Deliberately small — a taxonomy nobody can hold in their head gets used
 * inconsistently, and designers pick these from a list on every upload.
 *
 * Language and region tags are intentionally absent: content already carries
 * `primary_language` and `region_code` as columns, and duplicating them as
 * tags would create two sources of truth for feed filtering.
 */

export const TAG_SEED = [
	// Festivals — the bulk of demand, and highly seasonal.
	{ slug: "diwali", label: "Diwali", category: "festival" },
	{ slug: "holi", label: "Holi", category: "festival" },
	{ slug: "eid", label: "Eid", category: "festival" },
	{ slug: "christmas", label: "Christmas", category: "festival" },
	{ slug: "navratri", label: "Navratri", category: "festival" },
	{ slug: "ganesh-chaturthi", label: "Ganesh Chaturthi", category: "festival" },
	{ slug: "durga-puja", label: "Durga Puja", category: "festival" },
	{ slug: "pongal", label: "Pongal", category: "festival" },
	{ slug: "onam", label: "Onam", category: "festival" },
	{ slug: "baisakhi", label: "Baisakhi", category: "festival" },
	{ slug: "raksha-bandhan", label: "Raksha Bandhan", category: "festival" },
	{ slug: "janmashtami", label: "Janmashtami", category: "festival" },
	{ slug: "makar-sankranti", label: "Makar Sankranti", category: "festival" },
	{ slug: "gudi-padwa", label: "Gudi Padwa", category: "festival" },
	{ slug: "ugadi", label: "Ugadi", category: "festival" },
	{ slug: "chhath-puja", label: "Chhath Puja", category: "festival" },
	{ slug: "karva-chauth", label: "Karva Chauth", category: "festival" },
	{ slug: "republic-day", label: "Republic Day", category: "festival" },
	{ slug: "independence-day", label: "Independence Day", category: "festival" },
	{ slug: "new-year", label: "New Year", category: "festival" },

	// Occasions — everyday reasons to send a status.
	{ slug: "good-morning", label: "Good Morning", category: "occasion" },
	{ slug: "good-night", label: "Good Night", category: "occasion" },
	{ slug: "birthday", label: "Birthday", category: "occasion" },
	{ slug: "anniversary", label: "Anniversary", category: "occasion" },
	{ slug: "get-well-soon", label: "Get Well Soon", category: "occasion" },
	{ slug: "congratulations", label: "Congratulations", category: "occasion" },
	{ slug: "thank-you", label: "Thank You", category: "occasion" },
	{ slug: "condolence", label: "Condolence", category: "occasion" },

	// Themes — the mood or subject of the image.
	{ slug: "devotional", label: "Devotional", category: "theme" },
	{ slug: "motivational", label: "Motivational", category: "theme" },
	{ slug: "nature", label: "Nature", category: "theme" },
	{ slug: "flowers", label: "Flowers", category: "theme" },
	{ slug: "family", label: "Family", category: "theme" },
	{ slug: "friendship", label: "Friendship", category: "theme" },
	{ slug: "love", label: "Love", category: "theme" },
	{ slug: "humour", label: "Humour", category: "theme" },
	{ slug: "shayari", label: "Shayari", category: "theme" },
	{ slug: "quotes", label: "Quotes", category: "theme" },
] as const;
