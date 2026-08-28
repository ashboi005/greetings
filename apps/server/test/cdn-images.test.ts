/**
 * CDN image URLs (spec §6, §8).
 *
 * The mobile app renders a feed of images over a slow connection, which rules
 * out both of the obvious approaches: a signed URL per tile cannot be cached
 * between sessions, and calling the tracked download endpoint per tile would
 * count a download for everything that scrolled past.
 *
 * So display goes through a public CDN URL, and only an actual save goes through
 * the counted endpoint. These tests pin both halves, and the fallback for a
 * deployment with no CDN at all.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { content } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { publicImageUrl } from "../src/lib/storage";
import { recordDownload } from "../src/modules/downloads/service";
import { testDb, truncateAll } from "./db";
import { fakeObjectStorage, fakeTokenVerifier } from "./fakes";
import { authHelper, client, seedReference } from "./helpers";

const CDN = "https://cdn.greetings.test";

const firebase = fakeTokenVerifier();
const r2 = fakeObjectStorage();

/** With a CDN, as production runs. */
const cdnApp = createApp({
	tokenVerifier: firebase.verifier,
	objectStorage: r2.storage,
	publicBaseUrl: CDN,
});

/** Without one, as local development runs. */
const plainApp = createApp({
	tokenVerifier: firebase.verifier,
	objectStorage: r2.storage,
	publicBaseUrl: undefined,
});

const cdnApi = client(cdnApp);
const plainApi = client(plainApp);
const auth = authHelper(cdnApi, firebase);

beforeEach(async () => {
	await truncateAll();
	await seedReference();
});

/** A published item with an image, visible in the feed. */
async function publish(designerId: string, key = "content/abc/def.webp") {
	const id = crypto.randomUUID();
	await testDb.insert(content).values({
		id,
		designerId,
		title: "Good morning",
		status: "published",
		primaryLanguage: "hi",
		primaryAssetKey: key,
		publishedAt: new Date(),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	r2.putObject(key);
	return id;
}

describe("building the URL", () => {
	test("joins base and key, tolerating a trailing slash", () => {
		expect(publicImageUrl("content/a/b.webp", CDN)).toBe(
			`${CDN}/content/a/b.webp`,
		);
		expect(publicImageUrl("content/a/b.webp", `${CDN}/`)).toBe(
			`${CDN}/content/a/b.webp`,
		);
		expect(publicImageUrl("content/a/b.webp", `${CDN}///`)).toBe(
			`${CDN}/content/a/b.webp`,
		);
	});

	test("is null when either side is missing", () => {
		expect(publicImageUrl(null, CDN)).toBeNull();
		expect(publicImageUrl(undefined, CDN)).toBeNull();
		expect(publicImageUrl("content/a/b.webp", undefined)).toBeNull();
		expect(publicImageUrl("", CDN)).toBeNull();
	});

	test("escapes each path segment without escaping the separators", () => {
		// Keys are generated as uuids today, so nothing here needs escaping. The
		// point is that a key is data: the day one contains a space or a query
		// character, concatenation would produce a URL pointing somewhere else.
		expect(publicImageUrl("content/a b/c?d.webp", CDN)).toBe(
			`${CDN}/content/a%20b/c%3Fd.webp`,
		);
		expect(publicImageUrl("content//a.webp", CDN)).toBe(
			`${CDN}/content/a.webp`,
		);
	});
});

describe("the feed", () => {
	test("carries a CDN url for display alongside the key", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		await publish(designer.userId, "content/xyz/pic.webp");

		const res = await cdnApi.get("/v1/feed", { token: reader.token });
		expect(res.status).toBe(200);

		const [item] = res.body.items as {
			storageKey: string;
			imageUrl: string;
		}[];
		expect(item?.storageKey).toBe("content/xyz/pic.webp");
		expect(item?.imageUrl).toBe(`${CDN}/content/xyz/pic.webp`);
	});

	test("search carries it too", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		await publish(designer.userId, "content/xyz/pic.webp");

		const res = await cdnApi.get("/v1/search?q=morning", {
			token: reader.token,
		});
		const [item] = res.body.items as { imageUrl: string }[];
		expect(item?.imageUrl).toBe(`${CDN}/content/xyz/pic.webp`);
	});

	test("is null when the deployment has no CDN, rather than a broken url", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		await publish(designer.userId);

		const res = await plainApi.get("/v1/feed", { token: reader.token });
		const [item] = res.body.items as { imageUrl: string | null }[];
		expect(item?.imageUrl).toBeNull();
	});

	test("browsing the feed records no downloads", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		const id = await publish(designer.userId);

		await cdnApi.get("/v1/feed", { token: reader.token });
		await cdnApi.get("/v1/feed", { token: reader.token });

		// The whole reason display and saving are different URLs. If a tile were
		// rendered through the download endpoint, this would be 2.
		const [row] = await testDb
			.select({ downloads: content.downloadCount })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.downloads).toBe(0);
	});
});

describe("downloading", () => {
	test("returns a permanent CDN url and still counts the download", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		const id = await publish(designer.userId, "content/xyz/pic.webp");

		const res = await cdnApi.post(`/v1/content/${id}/download`, {
			token: reader.token,
			body: { source: "feed" },
		});

		expect(res.status).toBe(200);
		expect(res.body.url).toBe(`${CDN}/content/xyz/pic.webp`);
		// Null, not 300: the client may cache this file indefinitely, which is the
		// point of serving it from the CDN.
		expect(res.body.expiresInSeconds).toBeNull();
		expect(res.body.recorded).toBe(true);

		const [row] = await testDb
			.select({ downloads: content.downloadCount })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.downloads).toBe(1);
	});

	test("falls back to an expiring signed url with no CDN configured", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		const id = await publish(designer.userId);

		const res = await plainApi.post(`/v1/content/${id}/download`, {
			token: reader.token,
		});

		expect(res.status).toBe(200);
		expect(res.body.url).toContain("fake-r2.test");
		expect(res.body.expiresInSeconds).toBe(300);
		expect(res.body.recorded).toBe(true);
	});

	test("an idempotent replay reports the same expiry as the original", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		const id = await publish(designer.userId, "content/xyz/pic.webp");

		const first = await recordDownload({
			contentId: id,
			userId: reader.userId,
			source: "detail",
			idempotencyKey: "key-1",
			storage: r2.storage,
			publicBaseUrl: CDN,
		});
		const replay = await recordDownload({
			contentId: id,
			userId: reader.userId,
			source: "detail",
			idempotencyKey: "key-1",
			storage: r2.storage,
			publicBaseUrl: CDN,
		});

		expect(replay.recorded).toBe(false);
		expect(replay.url).toBe(first.url);
		expect(replay.expiresInSeconds).toBeNull();

		// Counted once despite two calls.
		const [row] = await testDb
			.select({ downloads: content.downloadCount })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.downloads).toBe(1);
	});

	test("a replay of a signed url is not reported as permanent", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		const id = await publish(designer.userId);

		// Stored before the CDN existed…
		await recordDownload({
			contentId: id,
			userId: reader.userId,
			source: "detail",
			idempotencyKey: "key-2",
			storage: r2.storage,
		});

		// …and replayed after it was switched on. The stored URL is still the
		// expiring one, so saying it never expires would have the client cache a
		// link that dies in five minutes.
		const replay = await recordDownload({
			contentId: id,
			userId: reader.userId,
			source: "detail",
			idempotencyKey: "key-2",
			storage: r2.storage,
			publicBaseUrl: CDN,
		});

		expect(replay.recorded).toBe(false);
		expect(replay.expiresInSeconds).toBe(300);
	});

	test("a held item is still refused even though its url is guessable", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		const id = await publish(designer.userId);
		await testDb
			.update(content)
			.set({ visibilityHold: true })
			.where(eq(content.id, id));

		const res = await cdnApi.post(`/v1/content/${id}/download`, {
			token: reader.token,
		});

		// The endpoint still enforces state. What a public bucket gives up is
		// enforcement of the *counter* for someone who bypasses the API entirely,
		// not enforcement of moderation decisions for someone who does not.
		expect(res.status).toBe(409);
	});
});
