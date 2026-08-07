import { beforeEach, describe, expect, test } from "bun:test";
import {
	content,
	contentAssets,
	downloadIdempotency,
} from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import {
	cleanupOrphanDrafts,
	purgeExpiredIdempotencyKeys,
} from "../src/jobs/cleanup-orphan-drafts";
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

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	r2.reset();
	await seedReference();
});

/** A draft with one confirmed asset, aged by rewriting updatedAt. */
async function agedDraft(token: string, ageDays: number) {
	const created = await api.post("/v1/designer/content", {
		token,
		body: { title: "Abandoned", primaryLanguage: "hi" },
	});
	const id = created.body.id as string;

	const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
		token,
		body: { mimeType: "image/jpeg", bytes: 2048 },
	});
	r2.putObject(url.body.storageKey);
	await api.post(`/v1/designer/content/${id}/assets`, {
		token,
		body: { storageKey: url.body.storageKey, width: 100, height: 100 },
	});

	await testDb
		.update(content)
		.set({ updatedAt: new Date(Date.now() - ageDays * DAY) })
		.where(eq(content.id, id));

	return { id, storageKey: url.body.storageKey as string };
}

describe("orphan draft cleanup", () => {
	test("deletes stale drafts and the objects behind them", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const stale = await agedDraft(designer.token, 10);

		const result = await cleanupOrphanDrafts(r2.storage);

		expect(result.draftsDeleted).toBe(1);
		expect(result.objectsDeleted).toBe(1);
		expect(r2.has(stale.storageKey)).toBe(false);

		const rows = await testDb
			.select()
			.from(content)
			.where(eq(content.id, stale.id));
		expect(rows).toHaveLength(0);

		// The asset row goes with it, by cascade.
		const assets = await testDb
			.select()
			.from(contentAssets)
			.where(eq(contentAssets.contentId, stale.id));
		expect(assets).toHaveLength(0);
	});

	test("leaves recent drafts alone", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const recent = await agedDraft(designer.token, 2);

		const result = await cleanupOrphanDrafts(r2.storage);

		expect(result.draftsDeleted).toBe(0);
		expect(r2.has(recent.storageKey)).toBe(true);
	});

	test("never touches submitted, published or rejected content", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });

		const { id } = await agedDraft(designer.token, 30);
		await api.put(`/v1/designer/content/${id}/tags`, {
			token: designer.token,
			body: { tagIds: ["tag_good-morning"] },
		});
		await api.post(`/v1/designer/content/${id}/submit`, {
			token: designer.token,
		});
		await api.post(`/v1/admin/content/${id}/approve`, { token: admin.token });

		// Age it again — published content must survive regardless.
		await testDb
			.update(content)
			.set({ updatedAt: new Date(Date.now() - 30 * DAY) })
			.where(eq(content.id, id));

		const result = await cleanupOrphanDrafts(r2.storage);
		expect(result.draftsDeleted).toBe(0);

		const rows = await testDb.select().from(content).where(eq(content.id, id));
		expect(rows).toHaveLength(1);
	});

	test("keeps the row when its object cannot be deleted, so the next run retries", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const stale = await agedDraft(designer.token, 10);

		r2.breakDeletes();
		const failed = await cleanupOrphanDrafts(r2.storage);

		expect(failed.objectsFailed).toBe(1);
		expect(failed.draftsDeleted).toBe(0);
		// Deleting the row here would have leaked the object forever, since the
		// key only exists on the row.
		expect(
			await testDb.select().from(content).where(eq(content.id, stale.id)),
		).toHaveLength(1);

		r2.breakDeletes(false);
		const retried = await cleanupOrphanDrafts(r2.storage);
		expect(retried.draftsDeleted).toBe(1);
		expect(r2.has(stale.storageKey)).toBe(false);
	});

	test("handles a draft that never got an image", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Empty", primaryLanguage: "hi" },
		});
		await testDb
			.update(content)
			.set({ updatedAt: new Date(Date.now() - 10 * DAY) })
			.where(eq(content.id, created.body.id));

		const result = await cleanupOrphanDrafts(r2.storage);
		expect(result.draftsDeleted).toBe(1);
		expect(result.objectsDeleted).toBe(0);
	});

	test("does nothing when there is nothing to do", async () => {
		const result = await cleanupOrphanDrafts(r2.storage);
		expect(result).toEqual({
			draftsDeleted: 0,
			objectsDeleted: 0,
			objectsFailed: 0,
		});
	});
});

describe("idempotency key purge", () => {
	/** Writes an idempotency record directly, at a chosen age. */
	async function storedKey(
		userId: string,
		contentId: string,
		ageMinutes: number,
	) {
		const id = crypto.randomUUID();
		await testDb.insert(downloadIdempotency).values({
			id,
			userId,
			key: `key-${id}`,
			contentId,
			signedUrl: "https://example.test/signed",
			createdAt: new Date(Date.now() - ageMinutes * 60 * 1000),
		});
		return id;
	}

	test("removes records past the retention window and keeps recent ones", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Anything", primaryLanguage: "hi" },
		});
		const contentId = created.body.id as string;

		const old = await storedKey(designer.userId, contentId, 120);
		const recent = await storedKey(designer.userId, contentId, 5);

		const result = await purgeExpiredIdempotencyKeys();
		expect(result.purged).toBe(1);

		const remaining = await testDb.select().from(downloadIdempotency);
		expect(remaining.map((r) => r.id)).toEqual([recent]);
		void old;
	});

	test("does nothing when every record is fresh", async () => {
		expect(await purgeExpiredIdempotencyKeys()).toEqual({ purged: 0 });
	});
});
