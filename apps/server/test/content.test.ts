import { beforeEach, describe, expect, test } from "bun:test";
import { content, moderationActions } from "@greetings/db/schema";
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

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	r2.reset();
	await seedReference();
});

/** Walks a piece of content from nothing to submitted, the way a client would. */
async function submittedContent(
	token: string,
	overrides: Record<string, unknown> = {},
) {
	const created = await api.post("/v1/designer/content", {
		token,
		body: {
			title: "Good Morning Friends",
			primaryLanguage: "hi",
			...overrides,
		},
	});
	const id = created.body.id as string;

	const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
		token,
		body: { mimeType: "image/jpeg", bytes: 2048 },
	});

	// Stand in for the client PUTting the bytes directly to R2.
	r2.putObject(url.body.storageKey);

	await api.post(`/v1/designer/content/${id}/assets`, {
		token,
		body: { storageKey: url.body.storageKey, width: 1080, height: 1920 },
	});

	await api.put(`/v1/designer/content/${id}/tags`, {
		token,
		body: { tagIds: ["tag_good-morning"] },
	});

	const submitted = await api.post(`/v1/designer/content/${id}/submit`, {
		token,
	});
	return { id, submitted, storageKey: url.body.storageKey as string };
}

describe("upload flow", () => {
	test("a designer takes an image from draft to published via admin approval", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });

		const { id, submitted } = await submittedContent(designer.token);
		expect(submitted.status).toBe(200);
		expect(submitted.body.status).toBe("pending_review");

		// It appears in the admin queue.
		const queue = await api.get("/v1/admin/content/queue", {
			token: admin.token,
		});
		expect(queue.body.map((row: { id: string }) => row.id)).toContain(id);

		const approved = await api.post(`/v1/admin/content/${id}/approve`, {
			token: admin.token,
		});
		expect(approved.status).toBe(200);
		expect(approved.body.status).toBe("published");

		const [row] = await testDb
			.select({ status: content.status, publishedAt: content.publishedAt })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.status).toBe("published");
		expect(row?.publishedAt).not.toBeNull();
	});

	test("the presigned URL is scoped to the content and carries the content type", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Test", primaryLanguage: "hi" },
		});

		const res = await api.post(
			`/v1/designer/content/${created.body.id}/upload-url`,
			{ token: designer.token, body: { mimeType: "image/png", bytes: 1024 } },
		);

		expect(res.status).toBe(200);
		expect(res.body.storageKey).toStartWith(`content/${created.body.id}/`);
		expect(res.body.uploadUrl).toContain("method=PUT");
		expect(res.body.uploadUrl).toContain(encodeURIComponent("image/png"));
	});

	test("rejects an unsupported image type", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Test", primaryLanguage: "hi" },
		});

		const res = await api.post(
			`/v1/designer/content/${created.body.id}/upload-url`,
			{ token: designer.token, body: { mimeType: "image/gif", bytes: 1024 } },
		);
		expect(res.status).toBe(400);
	});

	test("rejects a file over the size limit", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Test", primaryLanguage: "hi" },
		});

		const res = await api.post(
			`/v1/designer/content/${created.body.id}/upload-url`,
			{
				token: designer.token,
				body: { mimeType: "image/jpeg", bytes: 11 * 1024 * 1024 },
			},
		);
		expect(res.status).toBe(400);
	});

	test("refuses to confirm an asset that was never uploaded", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Test", primaryLanguage: "hi" },
		});
		const url = await api.post(
			`/v1/designer/content/${created.body.id}/upload-url`,
			{ token: designer.token, body: { mimeType: "image/jpeg", bytes: 2048 } },
		);

		// Confirm without ever putting the object.
		const res = await api.post(
			`/v1/designer/content/${created.body.id}/assets`,
			{
				token: designer.token,
				body: { storageKey: url.body.storageKey, width: 100, height: 100 },
			},
		);
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("No uploaded object");
	});

	test("records the object's real size and type, not the client's claim", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Test", primaryLanguage: "hi" },
		});
		const url = await api.post(
			`/v1/designer/content/${created.body.id}/upload-url`,
			{ token: designer.token, body: { mimeType: "image/jpeg", bytes: 2048 } },
		);

		// What actually lands differs from what was declared.
		r2.putObject(url.body.storageKey, {
			size: 4096,
			contentType: "image/webp",
		});

		const res = await api.post(
			`/v1/designer/content/${created.body.id}/assets`,
			{
				token: designer.token,
				body: { storageKey: url.body.storageKey, width: 100, height: 100 },
			},
		);
		expect(res.body.bytes).toBe(4096);
		expect(res.body.mimeType).toBe("image/webp");
	});

	test("a designer cannot attach an object belonging to other content", async () => {
		const designer = await auth.signIn({ role: "designer" });

		const mine = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Mine", primaryLanguage: "hi" },
		});

		const foreignKey = "content/someone-elses-id/abc.jpg";
		r2.putObject(foreignKey);

		const res = await api.post(`/v1/designer/content/${mine.body.id}/assets`, {
			token: designer.token,
			body: { storageKey: foreignKey, width: 100, height: 100 },
		});
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("does not belong");
	});
});

describe("submission requirements", () => {
	test("refuses to submit without an image", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "No image", primaryLanguage: "hi" },
		});
		await api.put(`/v1/designer/content/${created.body.id}/tags`, {
			token: designer.token,
			body: { tagIds: ["tag_good-morning"] },
		});

		const res = await api.post(
			`/v1/designer/content/${created.body.id}/submit`,
			{
				token: designer.token,
			},
		);
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("image");
	});

	test("refuses to submit without a tag", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "No tag", primaryLanguage: "hi" },
		});
		const url = await api.post(
			`/v1/designer/content/${created.body.id}/upload-url`,
			{ token: designer.token, body: { mimeType: "image/jpeg", bytes: 2048 } },
		);
		r2.putObject(url.body.storageKey);
		await api.post(`/v1/designer/content/${created.body.id}/assets`, {
			token: designer.token,
			body: { storageKey: url.body.storageKey, width: 100, height: 100 },
		});

		const res = await api.post(
			`/v1/designer/content/${created.body.id}/submit`,
			{
				token: designer.token,
			},
		);
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("tag");
	});

	test("rejects an unknown language and an unknown region", async () => {
		const designer = await auth.signIn({ role: "designer" });

		const badLang = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "X", primaryLanguage: "elvish" },
		});
		expect(badLang.status).toBe(400);

		const badRegion = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "X", primaryLanguage: "hi", regionCode: "IN-ZZ" },
		});
		expect(badRegion.status).toBe(400);
	});

	test("rejects unknown tags", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "X", primaryLanguage: "hi" },
		});

		const res = await api.put(`/v1/designer/content/${created.body.id}/tags`, {
			token: designer.token,
			body: { tagIds: ["tag_good-morning", "tag_nonexistent"] },
		});
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("tag_nonexistent");
	});
});

describe("lifecycle", () => {
	test("rejected content can be fixed and resubmitted", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });
		const { id } = await submittedContent(designer.token);

		const rejected = await api.post(`/v1/admin/content/${id}/reject`, {
			token: admin.token,
			body: { reason: "Text is unreadable" },
		});
		expect(rejected.body.status).toBe("rejected");

		const resubmitted = await api.post(`/v1/designer/content/${id}/submit`, {
			token: designer.token,
		});
		expect(resubmitted.status).toBe(200);
		expect(resubmitted.body.status).toBe("pending_review");

		// The old verdict must not follow it back into the queue.
		const [row] = await testDb
			.select({ rejectionReason: content.rejectionReason })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.rejectionReason).toBeNull();
	});

	test("approving twice is a conflict, not a silent no-op", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });
		const { id } = await submittedContent(designer.token);

		await api.post(`/v1/admin/content/${id}/approve`, { token: admin.token });
		const second = await api.post(`/v1/admin/content/${id}/approve`, {
			token: admin.token,
		});

		expect(second.status).toBe(409);
		expect(second.body.error.code).toBe("CONFLICT");
		expect(second.body.error.details.status).toBe("published");
	});

	test("a draft cannot be approved without review", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });

		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Sneaky", primaryLanguage: "hi" },
		});

		const res = await api.post(`/v1/admin/content/${created.body.id}/approve`, {
			token: admin.token,
		});
		expect(res.status).toBe(409);
	});

	test("published content can be removed and restored", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });
		const { id } = await submittedContent(designer.token);

		await api.post(`/v1/admin/content/${id}/approve`, { token: admin.token });

		const removed = await api.post(`/v1/admin/content/${id}/remove`, {
			token: admin.token,
			body: { reason: "Copyright complaint" },
		});
		expect(removed.body.status).toBe("removed");

		const restored = await api.post(`/v1/admin/content/${id}/restore`, {
			token: admin.token,
			body: { reason: "Complaint withdrawn" },
		});
		expect(restored.body.status).toBe("published");

		const [row] = await testDb
			.select({ removedAt: content.removedAt, hold: content.visibilityHold })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.removedAt).toBeNull();
		expect(row?.hold).toBe(false);
	});

	test("every transition leaves an audit row", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });
		const { id } = await submittedContent(designer.token);

		await api.post(`/v1/admin/content/${id}/approve`, { token: admin.token });
		await api.post(`/v1/admin/content/${id}/remove`, {
			token: admin.token,
			body: { reason: "Reported" },
		});

		const history = await testDb
			.select({
				action: moderationActions.action,
				actorId: moderationActions.actorId,
				reason: moderationActions.reason,
			})
			.from(moderationActions)
			.where(eq(moderationActions.contentId, id));

		expect(history.map((h) => h.action).sort()).toEqual([
			"approve",
			"remove",
			"submit",
		]);
		expect(history.find((h) => h.action === "remove")?.reason).toBe("Reported");
		expect(history.find((h) => h.action === "approve")?.actorId).toBe(
			admin.userId,
		);
	});

	test("a rejection must carry a reason", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });
		const { id } = await submittedContent(designer.token);

		const res = await api.post(`/v1/admin/content/${id}/reject`, {
			token: admin.token,
			body: {},
		});
		expect(res.status).toBe(422);
	});
});

describe("ownership", () => {
	test("a designer cannot see or touch another designer's content", async () => {
		const alice = await auth.signIn({ role: "designer" });
		const bob = await auth.signIn({ role: "designer" });

		const created = await api.post("/v1/designer/content", {
			token: alice.token,
			body: { title: "Alice's work", primaryLanguage: "hi" },
		});
		const id = created.body.id;

		// Indistinguishable from content that does not exist — confirming it
		// exists would itself be a disclosure.
		const upload = await api.post(`/v1/designer/content/${id}/upload-url`, {
			token: bob.token,
			body: { mimeType: "image/jpeg", bytes: 1024 },
		});
		expect(upload.status).toBe(404);

		const submit = await api.post(`/v1/designer/content/${id}/submit`, {
			token: bob.token,
		});
		expect(submit.status).toBe(404);
	});

	test("the content list shows only the caller's own work", async () => {
		const alice = await auth.signIn({ role: "designer" });
		const bob = await auth.signIn({ role: "designer" });

		await api.post("/v1/designer/content", {
			token: alice.token,
			body: { title: "Alice's", primaryLanguage: "hi" },
		});
		await api.post("/v1/designer/content", {
			token: bob.token,
			body: { title: "Bob's", primaryLanguage: "hi" },
		});

		const list = await api.get("/v1/designer/content", { token: alice.token });
		expect(list.body).toHaveLength(1);
		expect(list.body[0].title).toBe("Alice's");
	});
});

describe("tags reference", () => {
	test("GET /v1/tags returns the seeded taxonomy", async () => {
		const res = await api.get("/v1/tags");
		expect(res.status).toBe(200);

		const slugs = res.body.map((t: { slug: string }) => t.slug);
		expect(slugs).toContain("diwali");
		expect(slugs).toContain("good-morning");
	});

	test("returns every category when none is requested", async () => {
		// `t.Optional(t.UnionEnum([...]))` silently defaults an absent query
		// parameter to the first enum value, which quietly filtered this listing
		// to festivals only. Asserting the categories present, rather than that
		// the ones returned match a filter, is what catches that.
		const res = await api.get("/v1/tags");
		const categories = new Set(
			res.body.map((t: { category: string }) => t.category),
		);
		expect([...categories].sort()).toEqual(["festival", "occasion", "theme"]);
	});

	test("filters by category when one is requested", async () => {
		const res = await api.get("/v1/tags?category=theme");
		expect(res.body.length).toBeGreaterThan(0);
		expect(
			res.body.every((t: { category: string }) => t.category === "theme"),
		).toBe(true);
	});
});

describe("designer content listing", () => {
	test("returns every status when none is requested", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const admin = await auth.signIn({ role: "admin" });

		// One draft, one published.
		await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Still a draft", primaryLanguage: "hi" },
		});
		const { id } = await submittedContent(designer.token, {
			title: "Published one",
		});
		await api.post(`/v1/admin/content/${id}/approve`, { token: admin.token });

		const all = await api.get("/v1/designer/content", {
			token: designer.token,
		});
		const statuses = new Set(
			all.body.map((row: { status: string }) => row.status),
		);
		expect([...statuses].sort()).toEqual(["draft", "published"]);

		const drafts = await api.get("/v1/designer/content?status=draft", {
			token: designer.token,
		});
		expect(drafts.body).toHaveLength(1);
		expect(drafts.body[0].title).toBe("Still a draft");
	});
});
