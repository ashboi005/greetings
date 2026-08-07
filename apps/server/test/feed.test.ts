import { beforeEach, describe, expect, test } from "bun:test";
import { content, downloadEvents } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { currentBucket } from "../src/modules/feed/ranking";
import { testDb, truncateAll } from "./db";
import { fakeObjectStorage, fakeTokenVerifier } from "./fakes";
import { authHelper, client, seedReference } from "./helpers";

const firebase = fakeTokenVerifier();
const r2 = fakeObjectStorage();
const app = createApp({
	tokenVerifier: firebase.verifier,
	objectStorage: r2.storage,
});
const api = client(app);
const auth = authHelper(api, firebase);

let designerToken: string;
let adminToken: string;

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	r2.reset();
	await seedReference();

	designerToken = (await auth.signIn({ role: "designer" })).token;
	adminToken = (await auth.signIn({ role: "admin" })).token;
});

/** Creates published content, bypassing the upload dance where it is not the point. */
async function publish(options: {
	title: string;
	language?: string;
	region?: string | null;
	tagIds?: string[];
	publishedAt?: Date;
}) {
	const created = await api.post("/v1/designer/content", {
		token: designerToken,
		body: {
			title: options.title,
			primaryLanguage: options.language ?? "hi",
			...(options.region ? { regionCode: options.region } : {}),
		},
	});
	const id = created.body.id as string;

	const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
		token: designerToken,
		body: { mimeType: "image/jpeg", bytes: 2048 },
	});
	r2.putObject(url.body.storageKey);
	await api.post(`/v1/designer/content/${id}/assets`, {
		token: designerToken,
		body: { storageKey: url.body.storageKey, width: 1080, height: 1920 },
	});
	await api.put(`/v1/designer/content/${id}/tags`, {
		token: designerToken,
		body: { tagIds: options.tagIds ?? ["tag_good-morning"] },
	});
	await api.post(`/v1/designer/content/${id}/submit`, { token: designerToken });
	await api.post(`/v1/admin/content/${id}/approve`, { token: adminToken });

	if (options.publishedAt) {
		await testDb
			.update(content)
			.set({ publishedAt: options.publishedAt })
			.where(eq(content.id, id));
	}

	return id;
}

/**
 * Writes download events directly.
 *
 * M5 adds the endpoint that creates these; the feed's popularity term reads
 * them already, so the rows are inserted here rather than earned.
 */
async function recordDownloads(contentId: string, count: number, at: Date) {
	const [row] = await testDb
		.select({ designerId: content.designerId })
		.from(content)
		.where(eq(content.id, contentId))
		.limit(1);

	if (!row) throw new Error(`No content ${contentId} to record downloads for`);

	const session = await auth.signIn();

	await testDb.insert(downloadEvents).values(
		Array.from({ length: count }, () => ({
			contentId,
			designerId: row.designerId,
			userId: session.userId,
			source: "feed" as const,
			createdAt: at,
		})),
	);
}

/** An onboarded end user with a region and languages. */
async function reader(region: string, languages: string[]) {
	const session = await auth.signIn();
	await api.put("/v1/me/profile", {
		token: session.token,
		body: { regionCode: region, languages },
	});
	return session.token;
}

describe("feed visibility", () => {
	test("shows published content and hides everything else", async () => {
		const published = await publish({ title: "Published one" });

		// A draft, and a submitted-but-unapproved item.
		await api.post("/v1/designer/content", {
			token: designerToken,
			body: { title: "Just a draft", primaryLanguage: "hi" },
		});
		const rejectedId = await publish({ title: "Then removed" });
		await api.post(`/v1/admin/content/${rejectedId}/remove`, {
			token: adminToken,
			body: { reason: "no" },
		});

		const token = await reader("IN-MH", ["hi"]);
		const feed = await api.get("/v1/feed", { token });

		const ids = feed.body.items.map((i: { id: string }) => i.id);
		expect(ids).toEqual([published]);
	});

	test("hides content under a visibility hold", async () => {
		const id = await publish({ title: "Held back" });
		await testDb
			.update(content)
			.set({ visibilityHold: true })
			.where(eq(content.id, id));

		const token = await reader("IN-MH", ["hi"]);
		const feed = await api.get("/v1/feed", { token });
		expect(feed.body.items).toHaveLength(0);
	});

	test("requires authentication", async () => {
		const res = await api.get("/v1/feed");
		expect(res.status).toBe(401);
	});
});

describe("personalisation", () => {
	test("two users in different regions get different orderings", async () => {
		const mh = await publish({ title: "Maharashtra item", region: "IN-MH" });
		const tn = await publish({ title: "Tamil Nadu item", region: "IN-TN" });

		const mhReader = await reader("IN-MH", ["hi"]);
		const tnReader = await reader("IN-TN", ["hi"]);

		const mhFeed = await api.get("/v1/feed", { token: mhReader });
		const tnFeed = await api.get("/v1/feed", { token: tnReader });

		expect(mhFeed.body.items[0].id).toBe(mh);
		expect(tnFeed.body.items[0].id).toBe(tn);
	});

	test("a language match outranks a region match", async () => {
		// Weights are 2.0 for language against 1.5 for region, so the
		// language-matched item must come first.
		const languageMatch = await publish({
			title: "Marathi, wrong region",
			language: "mr",
			region: "IN-TN",
		});
		await publish({
			title: "Hindi, right region",
			language: "hi",
			region: "IN-MH",
		});

		const token = await reader("IN-MH", ["mr"]);
		const feed = await api.get("/v1/feed", { token });
		expect(feed.body.items[0].id).toBe(languageMatch);
	});

	test("global content reaches a user whose region has none of its own", async () => {
		const global = await publish({ title: "Everywhere", region: null });

		// This reader's region has no content at all.
		const token = await reader("IN-LD", ["hi"]);
		const feed = await api.get("/v1/feed", { token });

		expect(feed.body.items.map((i: { id: string }) => i.id)).toContain(global);
	});

	test("a user who has not onboarded still gets a feed", async () => {
		await publish({ title: "Global", region: null });
		await publish({ title: "Regional", region: "IN-MH" });

		const session = await auth.signIn();
		const feed = await api.get("/v1/feed", { token: session.token });

		// No region and no languages means no personalisation, but recency and
		// the global term still produce a ranking rather than an empty feed.
		expect(feed.body.items.length).toBe(2);
	});
});

describe("ranking signals", () => {
	test("newer content outranks older, all else equal", async () => {
		const old = await publish({
			title: "Older",
			publishedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
		});
		const fresh = await publish({ title: "Newer" });

		const token = await reader("IN-MH", ["hi"]);
		const feed = await api.get("/v1/feed", { token });

		const ids = feed.body.items.map((i: { id: string }) => i.id);
		expect(ids.indexOf(fresh)).toBeLessThan(ids.indexOf(old));
	});

	test("recent downloads lift an otherwise equal item", async () => {
		const quiet = await publish({ title: "Quiet" });
		const popular = await publish({ title: "Popular" });

		// Level the recency term so popularity is the only difference between
		// them; otherwise whichever published second would win regardless.
		await testDb
			.update(content)
			.set({ publishedAt: new Date(Date.now() - 3600 * 1000) });

		await recordDownloads(popular, 25, new Date());

		const token = await reader("IN-MH", ["hi"]);
		const feed = await api.get("/v1/feed", { token });
		const ids = feed.body.items.map((i: { id: string }) => i.id);

		expect(ids.indexOf(popular)).toBeLessThan(ids.indexOf(quiet));
	});

	test("downloads older than the window do not count", async () => {
		const stale = await publish({ title: "Once popular" });
		const fresh = await publish({ title: "Popular now" });

		await testDb
			.update(content)
			.set({ publishedAt: new Date(Date.now() - 3600 * 1000) });

		// Ten times the downloads, but all outside the seven-day window.
		await recordDownloads(
			stale,
			50,
			new Date(Date.now() - 30 * 24 * 3600 * 1000),
		);
		await recordDownloads(fresh, 5, new Date());

		const token = await reader("IN-MH", ["hi"]);
		const feed = await api.get("/v1/feed", { token });
		const ids = feed.body.items.map((i: { id: string }) => i.id);

		// If the window were ignored, the item with 50 downloads would win.
		expect(ids.indexOf(fresh)).toBeLessThan(ids.indexOf(stale));
	});
});

describe("pagination stability", () => {
	test("paging the whole feed yields every item exactly once", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 12; i++) {
			ids.add(await publish({ title: `Item ${i}` }));
		}

		const token = await reader("IN-MH", ["hi"]);

		const seen: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 10; page++) {
			const url: string = cursor
				? `/v1/feed?limit=5&cursor=${encodeURIComponent(cursor)}`
				: "/v1/feed?limit=5";
			const res = await api.get(url, { token });
			expect(res.status).toBe(200);

			seen.push(...res.body.items.map((i: { id: string }) => i.id));
			cursor = res.body.nextCursor;
			if (!cursor) break;
		}

		expect(seen).toHaveLength(12);
		expect(new Set(seen).size).toBe(12);
		expect(new Set(seen)).toEqual(ids);
	});

	test("a cursor pins the clock, so content published mid-page does not shift the ordering", async () => {
		for (let i = 0; i < 6; i++) {
			await publish({ title: `Original ${i}` });
		}

		const token = await reader("IN-MH", ["hi"]);
		const first = await api.get("/v1/feed?limit=3", { token });
		const firstIds = first.body.items.map((i: { id: string }) => i.id);

		// Something new arrives between pages — the classic source of
		// duplicates in an unstable feed.
		await publish({ title: "Arrived mid-session" });

		const second = await api.get(
			`/v1/feed?limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`,
			{ token },
		);
		const secondIds = second.body.items.map((i: { id: string }) => i.id);

		// No repeats across the boundary.
		expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
	});

	test("the last page reports no next cursor", async () => {
		await publish({ title: "Only one" });
		const token = await reader("IN-MH", ["hi"]);

		const res = await api.get("/v1/feed?limit=5", { token });
		expect(res.body.items).toHaveLength(1);
		expect(res.body.nextCursor).toBeNull();
	});

	test("rejects a malformed cursor rather than ignoring it", async () => {
		const token = await reader("IN-MH", ["hi"]);
		const res = await api.get("/v1/feed?cursor=not-a-cursor", { token });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("BAD_REQUEST");
	});

	test("the bucket is stable within the hour", () => {
		const base = new Date("2026-08-08T14:00:00Z");
		const later = new Date("2026-08-08T14:59:59Z");
		const nextHour = new Date("2026-08-08T15:00:00Z");

		expect(currentBucket(base)).toBe(currentBucket(later));
		expect(currentBucket(nextHour)).not.toBe(currentBucket(base));
	});
});
