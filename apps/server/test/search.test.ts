import { beforeEach, describe, expect, test } from "bun:test";
import { content } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
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
let readerToken: string;

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	r2.reset();
	await seedReference();

	designerToken = (await auth.signIn({ role: "designer" })).token;
	adminToken = (await auth.signIn({ role: "admin" })).token;

	const session = await auth.signIn();
	await api.put("/v1/me/profile", {
		token: session.token,
		body: { regionCode: "IN-MH", languages: ["hi"] },
	});
	readerToken = session.token;
});

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
		body: { storageKey: url.body.storageKey, width: 1, height: 1 },
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

const idsOf = (body: { items: { id: string }[] }) =>
	body.items.map((i) => i.id);

describe("full-text search", () => {
	test("matches on a word in the title", async () => {
		const morning = await publish({ title: "Good Morning Friends" });
		await publish({ title: "Happy Diwali" });

		const res = await api.get("/v1/search?q=morning", { token: readerToken });
		expect(res.status).toBe(200);
		expect(idsOf(res.body)).toEqual([morning]);
	});

	test("matches words in the description too", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designerToken,
			body: {
				title: "Untitled",
				description: "sunrise blessings for everyone",
				primaryLanguage: "hi",
			},
		});
		const url = await api.post(
			`/v1/designer/content/${created.body.id}/upload-url`,
			{ token: designerToken, body: { mimeType: "image/jpeg", bytes: 100 } },
		);
		r2.putObject(url.body.storageKey);
		await api.post(`/v1/designer/content/${created.body.id}/assets`, {
			token: designerToken,
			body: { storageKey: url.body.storageKey, width: 1, height: 1 },
		});
		await api.put(`/v1/designer/content/${created.body.id}/tags`, {
			token: designerToken,
			body: { tagIds: ["tag_good-morning"] },
		});
		await api.post(`/v1/designer/content/${created.body.id}/submit`, {
			token: designerToken,
		});
		await api.post(`/v1/admin/content/${created.body.id}/approve`, {
			token: adminToken,
		});

		const res = await api.get("/v1/search?q=sunrise", { token: readerToken });
		expect(idsOf(res.body)).toEqual([created.body.id]);
	});

	test("finds non-Latin titles", async () => {
		const hindi = await publish({ title: "शुभ प्रभात" });
		await publish({ title: "Good Night" });

		const res = await api.get(`/v1/search?q=${encodeURIComponent("प्रभात")}`, {
			token: readerToken,
		});
		expect(idsOf(res.body)).toEqual([hindi]);
	});

	test("a misspelling still finds the content", async () => {
		const morning = await publish({ title: "Morning" });
		await publish({ title: "Diwali" });

		// The trigram fallback exists for exactly this: the audience is older
		// users typing on phone keyboards.
		const res = await api.get("/v1/search?q=mornin", { token: readerToken });
		expect(idsOf(res.body)).toContain(morning);
	});

	test("an exact match outranks a fuzzy one", async () => {
		const exact = await publish({ title: "Diwali" });
		const fuzzy = await publish({ title: "Diwaali Nights" });

		const res = await api.get("/v1/search?q=Diwali", { token: readerToken });
		const ids = idsOf(res.body);

		expect(ids[0]).toBe(exact);
		expect(ids).toContain(fuzzy);
	});

	test("returns nothing for a query that matches nothing", async () => {
		await publish({ title: "Good Morning" });
		const res = await api.get("/v1/search?q=zzzzqqqq", { token: readerToken });
		expect(res.body.items).toEqual([]);
	});

	test("only published content is searchable", async () => {
		await api.post("/v1/designer/content", {
			token: designerToken,
			body: { title: "Secret Draft Morning", primaryLanguage: "hi" },
		});

		const res = await api.get("/v1/search?q=Morning", { token: readerToken });
		expect(res.body.items).toEqual([]);
	});
});

describe("filters", () => {
	test("filters by tag", async () => {
		const diwali = await publish({ title: "Lamps", tagIds: ["tag_diwali"] });
		await publish({ title: "Sunrise", tagIds: ["tag_good-morning"] });

		const res = await api.get("/v1/search?tags=tag_diwali", {
			token: readerToken,
		});
		expect(idsOf(res.body)).toEqual([diwali]);
	});

	test("accepts several tags and matches any of them", async () => {
		const a = await publish({ title: "A", tagIds: ["tag_diwali"] });
		const b = await publish({ title: "B", tagIds: ["tag_holi"] });
		await publish({ title: "C", tagIds: ["tag_good-morning"] });

		const res = await api.get("/v1/search?tags=tag_diwali,tag_holi", {
			token: readerToken,
		});
		expect(idsOf(res.body).sort()).toEqual([a, b].sort());
	});

	test("filters by language and by region", async () => {
		const marathi = await publish({ title: "One", language: "mr" });
		await publish({ title: "Two", language: "hi" });

		const byLanguage = await api.get("/v1/search?language=mr", {
			token: readerToken,
		});
		expect(idsOf(byLanguage.body)).toEqual([marathi]);

		const regional = await publish({ title: "Three", region: "IN-TN" });
		const byRegion = await api.get("/v1/search?region=IN-TN", {
			token: readerToken,
		});
		expect(idsOf(byRegion.body)).toEqual([regional]);
	});

	test("combines a query with a tag filter", async () => {
		const wanted = await publish({
			title: "Morning Lamps",
			tagIds: ["tag_diwali"],
		});
		await publish({ title: "Morning Sun", tagIds: ["tag_good-morning"] });

		const res = await api.get("/v1/search?q=morning&tags=tag_diwali", {
			token: readerToken,
		});
		expect(idsOf(res.body)).toEqual([wanted]);
	});

	test("browsing with no query returns newest first", async () => {
		const older = await publish({
			title: "Older",
			publishedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
		});
		const newer = await publish({ title: "Newer" });

		const res = await api.get("/v1/search", { token: readerToken });
		expect(idsOf(res.body)).toEqual([newer, older]);
	});
});

describe("search pagination", () => {
	test("pages through results without duplicates or gaps", async () => {
		const created = new Set<string>();
		for (let i = 0; i < 11; i++) {
			created.add(
				await publish({
					title: `Morning number ${i}`,
					publishedAt: new Date(Date.now() - i * 3600 * 1000),
				}),
			);
		}

		const seen: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 10; page++) {
			const url: string = cursor
				? `/v1/search?q=morning&limit=4&cursor=${encodeURIComponent(cursor)}`
				: "/v1/search?q=morning&limit=4";
			const res = await api.get(url, { token: readerToken });
			expect(res.status).toBe(200);

			seen.push(...idsOf(res.body));
			cursor = res.body.nextCursor;
			if (!cursor) break;
		}

		expect(seen).toHaveLength(11);
		expect(new Set(seen)).toEqual(created);
	});

	test("rejects a malformed cursor", async () => {
		const res = await api.get("/v1/search?cursor=rubbish", {
			token: readerToken,
		});
		expect(res.status).toBe(400);
	});

	test("requires authentication", async () => {
		const res = await api.get("/v1/search?q=morning");
		expect(res.status).toBe(401);
	});
});
