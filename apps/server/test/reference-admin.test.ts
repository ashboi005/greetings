/**
 * Taxonomy management (spec §4.6).
 *
 * The interesting cases are not "can an admin rename a tag" — they are the ones
 * where editing reference data could damage something that already exists:
 * deleting a tag that content depends on, retiring a language out from under a
 * reader, or editing without leaving a trace of who did it.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	content,
	contentTags,
	languages,
	referenceChangeLog,
	regions,
	tags,
	userLanguages,
} from "@greetings/db/schema";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { clearReferenceCache } from "../src/lib/reference-cache";
import { testDb, truncateAll } from "./db";
import { fakeObjectStorage, fakeTokenVerifier } from "./fakes";
import { authHelper, client, seedReference } from "./helpers";

const firebase = fakeTokenVerifier();
const app = createApp({
	tokenVerifier: firebase.verifier,
	objectStorage: fakeObjectStorage().storage,
});
const api = client(app);
const auth = authHelper(api, firebase);

beforeEach(async () => {
	await truncateAll();
	await seedReference();
	// The public reference endpoints cache for a minute in process. Without this
	// the second test in a file would assert against the first test's data.
	clearReferenceCache();
});

/** A published item, enough to make a tag or language genuinely in use. */
async function seedContent(
	designerId: string,
	over: Partial<typeof content.$inferInsert> = {},
) {
	const id = crypto.randomUUID();
	await testDb.insert(content).values({
		id,
		designerId,
		title: "Good morning",
		status: "published",
		primaryLanguage: "hi",
		publishedAt: new Date(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	});
	return id;
}

describe("who may edit the taxonomy", () => {
	test("designers and readers cannot, admins and super admins can", async () => {
		const reader = await auth.signIn();
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });
		const boss = await auth.signIn({ role: "super_admin" });

		expect((await api.get("/v1/admin/reference/tags")).status).toBe(401);
		expect(
			(await api.get("/v1/admin/reference/tags", { token: reader.token }))
				.status,
		).toBe(403);
		expect(
			(await api.get("/v1/admin/reference/tags", { token: designer.token }))
				.status,
		).toBe(403);
		expect(
			(await api.get("/v1/admin/reference/tags", { token: admin.token }))
				.status,
		).toBe(200);
		expect(
			(await api.get("/v1/admin/reference/tags", { token: boss.token })).status,
		).toBe(200);
	});

	test("a designer cannot create a tag either", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const res = await api.post("/v1/admin/reference/tags", {
			token: designer.token,
			body: { slug: "sneaky", label: "Sneaky", category: "theme" },
		});
		expect(res.status).toBe(403);

		const rows = await testDb
			.select()
			.from(tags)
			.where(eq(tags.slug, "sneaky"));
		expect(rows).toHaveLength(0);
	});
});

describe("tags", () => {
	test("a created tag appears in the public list", async () => {
		const admin = await auth.signIn({ role: "admin" });

		const created = await api.post("/v1/admin/reference/tags", {
			token: admin.token,
			body: {
				slug: "pongal-wishes",
				label: "Pongal Wishes",
				category: "festival",
			},
		});
		expect(created.status).toBe(200);
		expect(created.body.usageCount).toBe(0);

		// The point of invalidating the cache on write: without it this is the
		// old list for up to a minute and the admin thinks the save failed.
		const publicList = await api.get("/v1/tags", { token: admin.token });
		const slugs = (publicList.body as { slug: string }[]).map((t) => t.slug);
		expect(slugs).toContain("pongal-wishes");
	});

	test("a duplicate slug is a 409, not a 500", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const body = {
			slug: "diwali",
			label: "Diwali again",
			category: "festival" as const,
		};

		const res = await api.post("/v1/admin/reference/tags", {
			token: admin.token,
			body,
		});
		expect(res.status).toBe(409);
		expect(res.body.error.message).toContain("already exists");
	});

	test("a malformed slug is rejected before it reaches the database", async () => {
		const admin = await auth.signIn({ role: "admin" });

		for (const slug of [
			"Has Spaces",
			"UPPER",
			"trailing-",
			"-leading",
			"double--hyphen",
		]) {
			const res = await api.post("/v1/admin/reference/tags", {
				token: admin.token,
				body: { slug, label: "x", category: "theme" },
			});
			// 422, not 400: schema validation is Elysia's, and the error plugin maps
			// it to UNPROCESSABLE. A 400 here would mean the handler ran.
			expect(res.status).toBe(422);
		}
	});

	test("retiring a tag hides it publicly but keeps it on existing content", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const designer = await auth.signIn({ role: "designer" });
		const contentId = await seedContent(designer.userId);
		await testDb.insert(contentTags).values({ contentId, tagId: "tag_diwali" });

		const res = await api.patch("/v1/admin/reference/tags/tag_diwali", {
			token: admin.token,
			body: { isActive: false },
		});
		expect(res.status).toBe(200);
		expect(res.body.isActive).toBe(false);
		expect(res.body.usageCount).toBe(1);

		const publicList = await api.get("/v1/tags", { token: admin.token });
		const slugs = (publicList.body as { slug: string }[]).map((t) => t.slug);
		expect(slugs).not.toContain("diwali");

		// Still attached — retiring is not a silent detach.
		const links = await testDb
			.select()
			.from(contentTags)
			.where(eq(contentTags.tagId, "tag_diwali"));
		expect(links).toHaveLength(1);
	});

	test("an admin list shows retired tags so they can be brought back", async () => {
		const admin = await auth.signIn({ role: "admin" });
		await api.patch("/v1/admin/reference/tags/tag_diwali", {
			token: admin.token,
			body: { isActive: false },
		});

		const adminList = await api.get("/v1/admin/reference/tags", {
			token: admin.token,
		});
		const found = (
			adminList.body as { slug: string; isActive: boolean }[]
		).find((t) => t.slug === "diwali");
		expect(found?.isActive).toBe(false);

		const back = await api.patch("/v1/admin/reference/tags/tag_diwali", {
			token: admin.token,
			body: { isActive: true },
		});
		expect(back.body.isActive).toBe(true);
	});

	test("deleting a tag that content uses is refused, and does not detach it", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const designer = await auth.signIn({ role: "designer" });
		const contentId = await seedContent(designer.userId);
		await testDb.insert(contentTags).values({ contentId, tagId: "tag_diwali" });

		const res = await api.delete("/v1/admin/reference/tags/tag_diwali", {
			token: admin.token,
		});
		expect(res.status).toBe(409);
		expect(res.body.error.message).toContain("Retire it instead");

		// The reason this test exists. content_tags.tag_id is ON DELETE CASCADE,
		// so a delete Postgres allowed would have silently stripped the tag from
		// this post rather than failing. Both rows must survive.
		expect(
			await testDb.select().from(tags).where(eq(tags.id, "tag_diwali")),
		).toHaveLength(1);
		expect(
			await testDb
				.select()
				.from(contentTags)
				.where(eq(contentTags.tagId, "tag_diwali")),
		).toHaveLength(1);
	});

	test("an unused tag can be deleted", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const created = await api.post("/v1/admin/reference/tags", {
			token: admin.token,
			body: { slug: "typo-tag", label: "Typo", category: "theme" },
		});

		const res = await api.delete(
			`/v1/admin/reference/tags/${created.body.id}`,
			{ token: admin.token },
		);
		expect(res.status).toBe(200);
		expect(
			await testDb.select().from(tags).where(eq(tags.slug, "typo-tag")),
		).toHaveLength(0);
	});

	test("renaming to an existing slug is a 409 and leaves the row untouched", async () => {
		const admin = await auth.signIn({ role: "admin" });

		const res = await api.patch("/v1/admin/reference/tags/tag_diwali", {
			token: admin.token,
			body: { slug: "holi" },
		});
		expect(res.status).toBe(409);

		const [row] = await testDb
			.select()
			.from(tags)
			.where(eq(tags.id, "tag_diwali"));
		expect(row?.slug).toBe("diwali");
	});

	test("a PATCH with no fields is rejected rather than logged as a no-op change", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const res = await api.patch("/v1/admin/reference/tags/tag_diwali", {
			token: admin.token,
			body: {},
		});
		expect(res.status).toBe(400);

		expect(
			await testDb
				.select()
				.from(referenceChangeLog)
				.where(eq(referenceChangeLog.entityKey, "tag_diwali")),
		).toHaveLength(0);
	});

	test("changing only the label does not silently change the category", async () => {
		const admin = await auth.signIn({ role: "admin" });

		// A tag that is deliberately NOT in the first enum category. Written as
		// t.Optional(t.UnionEnum(...)), an absent `category` arrives as the first
		// member — "festival" — and this rename would quietly recategorise the
		// tag. Every non-festival tag in the taxonomy was one edit away from it.
		const [before] = await testDb
			.select()
			.from(tags)
			.where(eq(tags.category, "theme"))
			.limit(1);
		if (!before) throw new Error("seed has no theme tag to test with");

		const res = await api.patch(`/v1/admin/reference/tags/${before.id}`, {
			token: admin.token,
			body: { label: "Renamed only" },
		});
		expect(res.status).toBe(200);
		expect(res.body.label).toBe("Renamed only");
		expect(res.body.category).toBe("theme");

		const [after] = await testDb
			.select()
			.from(tags)
			.where(eq(tags.id, before.id));
		expect(after?.category).toBe("theme");
	});

	test("editing an unknown tag is a 404", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const res = await api.patch("/v1/admin/reference/tags/tag_nope", {
			token: admin.token,
			body: { label: "x" },
		});
		expect(res.status).toBe(404);
	});
});

describe("languages", () => {
	test("added, renamed, and retired", async () => {
		const admin = await auth.signIn({ role: "admin" });

		const created = await api.post("/v1/admin/reference/languages", {
			token: admin.token,
			body: { code: "tcy", name: "Tulu", nativeName: "ತುಳು" },
		});
		expect(created.status).toBe(200);

		const renamed = await api.patch("/v1/admin/reference/languages/tcy", {
			token: admin.token,
			body: { name: "Tulu (Coastal)" },
		});
		expect(renamed.body.name).toBe("Tulu (Coastal)");
		// Untouched fields survive a partial update.
		expect(renamed.body.nativeName).toBe("ತುಳು");

		await api.patch("/v1/admin/reference/languages/tcy", {
			token: admin.token,
			body: { isActive: false },
		});
		const publicList = await api.get("/v1/languages", { token: admin.token });
		expect(
			(publicList.body as { code: string }[]).map((l) => l.code),
		).not.toContain("tcy");
	});

	test("a language in use cannot be deleted", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const designer = await auth.signIn({ role: "designer" });
		await seedContent(designer.userId, { primaryLanguage: "hi" });

		const res = await api.delete("/v1/admin/reference/languages/hi", {
			token: admin.token,
		});
		expect(res.status).toBe(409);
		expect(
			await testDb.select().from(languages).where(eq(languages.code, "hi")),
		).toHaveLength(1);
	});

	test("a language only a reader prefers still cannot be deleted", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const reader = await auth.signIn();
		await testDb
			.insert(userLanguages)
			.values({ userId: reader.userId, languageCode: "ta" });

		const res = await api.delete("/v1/admin/reference/languages/ta", {
			token: admin.token,
		});
		expect(res.status).toBe(409);
	});

	test("the code cannot be changed, because content references it", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const res = await api.patch("/v1/admin/reference/languages/hi", {
			token: admin.token,
			body: { code: "hin", name: "Hindi" },
		});
		// Elysia rejects the unknown property rather than silently ignoring it.
		expect([200, 400]).toContain(res.status);

		const [row] = await testDb
			.select()
			.from(languages)
			.where(eq(languages.code, "hi"));
		expect(row?.code).toBe("hi");
	});
});

describe("regions", () => {
	test("added, renamed, and retired", async () => {
		const admin = await auth.signIn({ role: "admin" });

		const created = await api.post("/v1/admin/reference/regions", {
			token: admin.token,
			body: { code: "IN-XX", name: "Test Territory" },
		});
		expect(created.status).toBe(200);

		await api.patch("/v1/admin/reference/regions/IN-XX", {
			token: admin.token,
			body: { isActive: false },
		});

		const publicList = await api.get("/v1/regions", { token: admin.token });
		expect(
			(publicList.body as { code: string }[]).map((r) => r.code),
		).not.toContain("IN-XX");
	});

	test("a malformed region code is rejected", async () => {
		const admin = await auth.signIn({ role: "admin" });
		for (const code of ["mh", "IN_MH", "INMH", "IN-"]) {
			const res = await api.post("/v1/admin/reference/regions", {
				token: admin.token,
				body: { code, name: "x" },
			});
			expect(res.status).toBe(422);
		}
	});

	test("a region a user lives in cannot be deleted", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const reader = await auth.signIn();
		await api.put("/v1/me/profile", {
			token: reader.token,
			body: { regionCode: "IN-MH", languages: ["hi"] },
		});

		const res = await api.delete("/v1/admin/reference/regions/IN-MH", {
			token: admin.token,
		});
		expect(res.status).toBe(409);
		expect(
			await testDb.select().from(regions).where(eq(regions.code, "IN-MH")),
		).toHaveLength(1);
	});
});

describe("the audit trail", () => {
	test("every kind of change is recorded with the actor and both versions", async () => {
		const admin = await auth.signIn({ role: "admin" });

		const created = await api.post("/v1/admin/reference/tags", {
			token: admin.token,
			body: { slug: "audit-me", label: "Audit me", category: "theme" },
		});
		const tagId = created.body.id as string;

		await api.patch(`/v1/admin/reference/tags/${tagId}`, {
			token: admin.token,
			body: { label: "Audited" },
		});
		await api.patch(`/v1/admin/reference/tags/${tagId}`, {
			token: admin.token,
			body: { isActive: false },
		});
		await api.patch(`/v1/admin/reference/tags/${tagId}`, {
			token: admin.token,
			body: { isActive: true },
		});
		await api.delete(`/v1/admin/reference/tags/${tagId}`, {
			token: admin.token,
		});

		const log = await api.get(
			`/v1/admin/reference/log?entity=tag&entityKey=${tagId}`,
			{ token: admin.token },
		);
		const actions = (log.body as { action: string }[]).map((e) => e.action);
		// Newest first.
		expect(actions).toEqual([
			"delete",
			"activate",
			"deactivate",
			"update",
			"create",
		]);

		const entries = log.body as {
			action: string;
			actorId: string;
			before: { label?: string } | null;
			after: { label?: string } | null;
		}[];
		for (const entry of entries) expect(entry.actorId).toBe(admin.userId);

		const rename = entries.find((e) => e.action === "update");
		expect(rename?.before?.label).toBe("Audit me");
		expect(rename?.after?.label).toBe("Audited");

		const create = entries.find((e) => e.action === "create");
		expect(create?.before).toBeNull();

		const removal = entries.find((e) => e.action === "delete");
		expect(removal?.after).toBeNull();
		// The record outlives the row it describes, which is the whole point.
		expect(removal?.before?.label).toBe("Audited");
	});

	test("a refused change leaves no log entry", async () => {
		const admin = await auth.signIn({ role: "admin" });

		await api.post("/v1/admin/reference/tags", {
			token: admin.token,
			body: { slug: "diwali", label: "Duplicate", category: "festival" },
		});

		// The insert and its log entry share a transaction, so a rejected insert
		// must not leave a "created" entry behind claiming otherwise.
		const created = await testDb
			.select()
			.from(referenceChangeLog)
			.where(
				and(
					eq(referenceChangeLog.entity, "tag"),
					eq(referenceChangeLog.action, "create"),
				),
			);
		expect(created).toHaveLength(0);
	});

	test("history survives filtering by entity", async () => {
		const admin = await auth.signIn({ role: "admin" });
		await api.post("/v1/admin/reference/languages", {
			token: admin.token,
			body: { code: "bho", name: "Bhojpuri", nativeName: "भोजपुरी" },
		});
		await api.post("/v1/admin/reference/regions", {
			token: admin.token,
			body: { code: "IN-ZZ", name: "Zed" },
		});

		const onlyLanguages = await api.get(
			"/v1/admin/reference/log?entity=language",
			{ token: admin.token },
		);
		const entities = (onlyLanguages.body as { entity: string }[]).map(
			(e) => e.entity,
		);
		expect(entities.length).toBeGreaterThan(0);
		expect(new Set(entities)).toEqual(new Set(["language"]));
	});
});

describe("the read cache does not mix filtered and unfiltered lists", () => {
	test("a retired region never appears in the public list, whichever ran first", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const reader = await auth.signIn();

		await api.patch("/v1/admin/reference/regions/IN-MH", {
			token: admin.token,
			body: { isActive: false },
		});

		// Warm the cache through the *validation* path first. It caches the
		// unfiltered list, and when both paths shared one key this call decided
		// what the public endpoint returned for the next minute — leaking the
		// retired region into the onboarding picker.
		const stillAccepted = await api.put("/v1/me/profile", {
			token: reader.token,
			body: { regionCode: "IN-MH", languages: ["hi"] },
		});
		expect(stillAccepted.status).toBe(200);

		const publicList = await api.get("/v1/regions", { token: reader.token });
		expect(
			(publicList.body as { code: string }[]).map((r) => r.code),
		).not.toContain("IN-MH");
	});

	test("a retired language likewise", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const reader = await auth.signIn();

		await api.patch("/v1/admin/reference/languages/ta", {
			token: admin.token,
			body: { isActive: false },
		});

		// Someone who already chose it keeps working: retiring is not deletion.
		const stillAccepted = await api.put("/v1/me/profile", {
			token: reader.token,
			body: { regionCode: "IN-MH", languages: ["ta"] },
		});
		expect(stillAccepted.status).toBe(200);

		const publicList = await api.get("/v1/languages", { token: reader.token });
		expect(
			(publicList.body as { code: string }[]).map((l) => l.code),
		).not.toContain("ta");
	});
});
