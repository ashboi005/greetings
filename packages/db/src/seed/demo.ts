/**
 * A small, realistic dataset for a fresh environment (spec §15, M8).
 *
 * Separate from the reference seed, which is production data. This exists so a
 * newly deployed staging environment, or a developer opening the web panels
 * for the first time, has something to look at rather than empty lists.
 *
 * Never run automatically: it creates users and content that would be
 * embarrassing in production.
 *
 *   bun run db:seed:demo
 */

import { eq, like } from "drizzle-orm";
import { db } from "../index";
import {
	content,
	contentAssets,
	contentTags,
	downloadEvents,
	userProfiles,
	user as userTable,
} from "../schema";

const DEMO_PREFIX = "demo-";

const DESIGNERS = [
	{
		id: `${DEMO_PREFIX}designer-1`,
		name: "Priya Sharma",
		email: "priya@demo.greetings",
	},
	{
		id: `${DEMO_PREFIX}designer-2`,
		name: "Arun Nair",
		email: "arun@demo.greetings",
	},
];

const READERS = [
	{ id: `${DEMO_PREFIX}reader-1`, region: "IN-MH", languages: ["mr", "hi"] },
	{ id: `${DEMO_PREFIX}reader-2`, region: "IN-TN", languages: ["ta"] },
	{ id: `${DEMO_PREFIX}reader-3`, region: "IN-UP", languages: ["hi"] },
];

const CONTENT = [
	{ title: "शुभ प्रभात", language: "hi", region: null, tag: "tag_good-morning" },
	{
		title: "Good Morning Friends",
		language: "en",
		region: null,
		tag: "tag_good-morning",
	},
	{ title: "शुभ दीपावली", language: "hi", region: null, tag: "tag_diwali" },
	{
		title: "இனிய காலை வணக்கம்",
		language: "ta",
		region: "IN-TN",
		tag: "tag_good-morning",
	},
	{
		title: "शुभ सकाळ",
		language: "mr",
		region: "IN-MH",
		tag: "tag_good-morning",
	},
	{
		title: "Happy Birthday",
		language: "en",
		region: null,
		tag: "tag_birthday",
	},
	{ title: "गुड नाईट", language: "hi", region: null, tag: "tag_good-night" },
	{
		title: "Ganpati Bappa Morya",
		language: "mr",
		region: "IN-MH",
		tag: "tag_ganesh-chaturthi",
	},
];

export async function seedDemoData(): Promise<{
	designers: number;
	readers: number;
	content: number;
	downloads: number;
}> {
	const now = new Date();

	for (const designer of DESIGNERS) {
		await db
			.insert(userTable)
			.values({
				id: designer.id,
				name: designer.name,
				email: designer.email,
				emailVerified: true,
				role: "designer",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: userTable.id,
				set: { name: designer.name, role: "designer" },
			});
	}

	for (const reader of READERS) {
		await db
			.insert(userTable)
			.values({
				id: reader.id,
				name: `Demo reader ${reader.id.slice(-1)}`,
				email: `${reader.id}@demo.greetings`,
				emailVerified: true,
				role: "user",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();

		await db
			.insert(userProfiles)
			.values({
				userId: reader.id,
				regionCode: reader.region,
				onboardedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: userProfiles.userId,
				set: { regionCode: reader.region, onboardedAt: now },
			});
	}

	let downloads = 0;

	// Download events have no natural key to upsert against, so a re-run would
	// otherwise pile a second set on top of the first and leave the events
	// disagreeing with the counters. Clearing demo events first makes the whole
	// seed idempotent, like every other seed in this project.
	await db
		.delete(downloadEvents)
		.where(like(downloadEvents.contentId, `${DEMO_PREFIX}%`));

	for (const [index, item] of CONTENT.entries()) {
		const id = `${DEMO_PREFIX}content-${index}`;
		const designer = DESIGNERS[index % DESIGNERS.length];
		if (!designer) continue;

		// Staggered publication dates so the feed's recency term has something
		// to work with rather than ranking everything identically.
		const publishedAt = new Date(now.getTime() - index * 12 * 3600 * 1000);

		await db
			.insert(content)
			.values({
				id,
				designerId: designer.id,
				title: item.title,
				status: "published",
				primaryLanguage: item.language,
				regionCode: item.region,
				publishedAt,
				submittedAt: publishedAt,
				reviewedAt: publishedAt,
				createdAt: publishedAt,
				updatedAt: publishedAt,
			})
			.onConflictDoUpdate({
				target: content.id,
				set: { title: item.title, status: "published", publishedAt },
			});

		// The key points at nothing real. Demo environments are for shape and
		// flow; a broken image is a clearer signal than a stock photo that
		// someone might mistake for production content.
		await db
			.insert(contentAssets)
			.values({
				id: `${DEMO_PREFIX}asset-${index}`,
				contentId: id,
				storageKey: `content/${id}/demo.jpg`,
				mimeType: "image/jpeg",
				width: 1080,
				height: 1920,
				bytes: 204_800,
				createdAt: publishedAt,
			})
			.onConflictDoNothing();

		await db
			.insert(contentTags)
			.values({ contentId: id, tagId: item.tag })
			.onConflictDoNothing();

		// A plausible spread of downloads, weighted so the first items look
		// more popular and the analytics screens have a visible ranking.
		const count = Math.max(1, 12 - index * 2);
		for (let n = 0; n < count; n++) {
			const reader = READERS[n % READERS.length];
			if (!reader) continue;

			await db.insert(downloadEvents).values({
				contentId: id,
				designerId: designer.id,
				userId: reader.id,
				regionCode: reader.region,
				languageCode: item.language,
				source: "feed",
				createdAt: new Date(now.getTime() - (n % 7) * 24 * 3600 * 1000),
			});
			downloads++;
		}

		await db
			.update(content)
			.set({ downloadCount: count })
			.where(eq(content.id, id));
	}

	return {
		designers: DESIGNERS.length,
		readers: READERS.length,
		content: CONTENT.length,
		downloads,
	};
}

/** Removes everything `seedDemoData` created. */
export async function clearDemoData(): Promise<void> {
	// content and profiles cascade from the user rows.
	for (const person of [...DESIGNERS, ...READERS]) {
		await db.delete(userTable).where(eq(userTable.id, person.id));
	}
}
