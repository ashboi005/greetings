/**
 * Deliberate attempts to break the API.
 *
 * Everything here started as a suspicion about my own code rather than a
 * feature to verify. Tests that fail on first run are the point; the ones that
 * passed stay because the property is worth pinning down.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { content, reports, userProfiles } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { consumeGlobal, defaultStore } from "../src/lib/rate-limit";
import { FIREBASE_VERIFY_GLOBAL_LIMIT } from "../src/modules/auth/routes";
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

let designer: Awaited<ReturnType<typeof auth.signIn>>;
let admin: Awaited<ReturnType<typeof auth.signIn>>;

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	r2.reset();
	defaultStore.clear();
	await seedReference();

	designer = await auth.signIn({ role: "designer" });
	admin = await auth.signIn({ role: "admin" });
});

async function publish(title = "Target") {
	const created = await api.post("/v1/designer/content", {
		token: designer.token,
		body: { title, primaryLanguage: "hi" },
	});
	const id = created.body.id as string;

	const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
		token: designer.token,
		body: { mimeType: "image/jpeg", bytes: 2048 },
	});
	r2.putObject(url.body.storageKey);
	await api.post(`/v1/designer/content/${id}/assets`, {
		token: designer.token,
		body: { storageKey: url.body.storageKey, width: 1, height: 1 },
	});
	await api.put(`/v1/designer/content/${id}/tags`, {
		token: designer.token,
		body: { tagIds: ["tag_good-morning"] },
	});
	await api.post(`/v1/designer/content/${id}/submit`, {
		token: designer.token,
	});
	await api.post(`/v1/admin/content/${id}/approve`, { token: admin.token });
	return id;
}

describe("tampered cursors", () => {
	const garbage = [
		"not-base64",
		Buffer.from(JSON.stringify({ b: 1, s: 1, i: "x" })).toString("base64url"),
		Buffer.from(
			JSON.stringify({ r: 0, p: "definitely not a date", i: "x" }),
		).toString("base64url"),
		Buffer.from(JSON.stringify({ t: "not a timestamp", i: "x" })).toString(
			"base64url",
		),
	];

	test("never produce a 500", async () => {
		const reader = await auth.signIn();
		const superAdmin = await auth.signIn({ role: "super_admin" });

		for (const cursor of garbage) {
			for (const path of [
				`/v1/feed?cursor=${cursor}`,
				`/v1/search?q=a&cursor=${cursor}`,
				`/v1/admin/audit/roles?cursor=${cursor}`,
				`/v1/admin/audit/actions?cursor=${cursor}`,
			]) {
				const token = path.startsWith("/v1/admin")
					? superAdmin.token
					: reader.token;
				const res = await api.get(path, { token });

				// A cursor is client-supplied. Garbage in it is the client's
				// mistake — 400 — and must never surface as a server fault,
				// which would page whoever is on call for someone's typo.
				expect([200, 400]).toContain(res.status);
			}
		}
	});
});

describe("rate limiting", () => {
	const attempt = (ip: string) =>
		api.post("/v1/auth/firebase", {
			body: { idToken: "never-registered" },
			ip,
		});

	test("rotating the forwarded header still hits a ceiling", async () => {
		// A client talking straight to the server controls x-forwarded-for
		// completely, so a per-address limit alone is decoration: send a
		// different address each request and nothing ever trips. The global
		// ceiling is what actually holds, and this proves the route consumes it
		// — the quota is spent up front, then one request from an address that
		// has never been seen is refused anyway.
		for (let i = 0; i < FIREBASE_VERIFY_GLOBAL_LIMIT; i++) {
			consumeGlobal("firebase-verify", {
				limit: Number.POSITIVE_INFINITY,
				windowSeconds: 60,
			});
		}

		const res = await attempt("203.0.113.77");
		expect(res.status).toBe(429);
		expect(res.body.error.code).toBe("RATE_LIMITED");
	});

	test("ordinary traffic from many addresses is not throttled", async () => {
		// The other half of the same property: the ceiling must sit far enough
		// above real traffic that a busy evening never touches it. Hundreds of
		// people on different networks signing in is exactly that.
		const statuses: number[] = [];
		for (let i = 0; i < 300; i++) {
			statuses.push((await attempt(`203.0.113.${i % 255}`)).status);
		}

		expect(statuses).not.toContain(429);
	});
});

describe("account linking", () => {
	test("a phone already held by another account does not 500", async () => {
		// Two Firebase identities: one links by verified email to an existing
		// user, and carries a phone number that belongs to somebody else. The
		// profile write then violates the unique index on phone.
		const first = await auth.signIn({ phone: "+919000000001" });
		await auth.signIn({
			email: "shared@example.com",
			phone: "+919000000002",
		});

		firebase.register("collide", {
			subject: "uid-collision",
			email: "shared@example.com",
			emailVerified: true,
			phone: "+919000000001",
		});

		const res = await api.post("/v1/auth/firebase", {
			body: { idToken: "collide" },
			ip: "203.0.113.99",
		});

		expect(res.status).not.toBe(500);
		expect([200, 409]).toContain(res.status);

		// Whatever the answer, the other person's number stays theirs.
		const [owner] = await testDb
			.select({ userId: userProfiles.userId })
			.from(userProfiles)
			.where(eq(userProfiles.phone, "+919000000001"));
		expect(owner?.userId).toBe(first.userId);
	});
});

describe("designers editing their own work", () => {
	test("can fix a rejected item and resubmit it", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Typo heer", primaryLanguage: "hi" },
		});
		const id = created.body.id as string;

		const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
			token: designer.token,
			body: { mimeType: "image/jpeg", bytes: 2048 },
		});
		r2.putObject(url.body.storageKey);
		await api.post(`/v1/designer/content/${id}/assets`, {
			token: designer.token,
			body: { storageKey: url.body.storageKey, width: 1, height: 1 },
		});
		await api.put(`/v1/designer/content/${id}/tags`, {
			token: designer.token,
			body: { tagIds: ["tag_good-morning"] },
		});
		await api.post(`/v1/designer/content/${id}/submit`, {
			token: designer.token,
		});
		await api.post(`/v1/admin/content/${id}/reject`, {
			token: admin.token,
			body: { reason: "Title is misspelled" },
		});

		// Without an edit endpoint a rejection is a dead end: the designer is
		// told exactly what to fix and has no way to fix it.
		const fixed = await api.patch(`/v1/designer/content/${id}`, {
			token: designer.token,
			body: { title: "Typo here" },
		});
		expect(fixed.status).toBe(200);

		const resubmitted = await api.post(`/v1/designer/content/${id}/submit`, {
			token: designer.token,
		});
		expect(resubmitted.status).toBe(200);
	});

	test("cannot edit another designer's content", async () => {
		const other = await auth.signIn({ role: "designer" });
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Mine", primaryLanguage: "hi" },
		});

		const res = await api.patch(`/v1/designer/content/${created.body.id}`, {
			token: other.token,
			body: { title: "Stolen" },
		});
		expect(res.status).toBe(404);
	});

	test("cannot rewrite a published item behind the reviewer's back", async () => {
		const id = await publish("Approved as this");

		const res = await api.patch(`/v1/designer/content/${id}`, {
			token: designer.token,
			body: { title: "Something an admin never saw" },
		});

		// The approval was of specific words. Letting them change afterwards
		// makes review meaningless.
		expect(res.status).toBe(409);

		const [row] = await testDb
			.select({ title: content.title })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.title).toBe("Approved as this");
	});

	test("can discard a draft they no longer want", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Mistake", primaryLanguage: "hi" },
		});

		const res = await api.delete(`/v1/designer/content/${created.body.id}`, {
			token: designer.token,
		});
		expect(res.status).toBe(200);

		const after = await api.get("/v1/designer/content", {
			token: designer.token,
		});
		expect(after.body).toHaveLength(0);
	});

	test("cannot delete something already published", async () => {
		const id = await publish("Live");
		const res = await api.delete(`/v1/designer/content/${id}`, {
			token: designer.token,
		});
		// Removal of live content is a moderation decision, and it has to leave
		// an audit trail. A designer deleting their own row would erase it.
		expect(res.status).toBe(409);
	});
});

describe("abandoned uploads", () => {
	test("are cleaned up even when never confirmed", async () => {
		const { cleanupOrphanDrafts } = await import(
			"../src/jobs/cleanup-orphan-drafts"
		);

		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Walked away", primaryLanguage: "hi" },
		});
		const id = created.body.id as string;

		const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
			token: designer.token,
			body: { mimeType: "image/jpeg", bytes: 2048 },
		});
		// Uploaded to R2, then the designer closed the tab. No confirm call, so
		// no content_assets row points at this object.
		r2.putObject(url.body.storageKey);

		await testDb
			.update(content)
			.set({ updatedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) })
			.where(eq(content.id, id));

		await cleanupOrphanDrafts(r2.storage);

		// Nothing in the database ever referenced this key, so a cleanup that
		// works from content_assets alone leaves it in the bucket forever.
		expect(r2.has(url.body.storageKey)).toBe(false);
	});
});

describe("report resolution", () => {
	test("resolving twice does not double-count or corrupt state", async () => {
		const id = await publish("Contested");
		const reporter = await auth.signIn();
		await api.post(`/v1/content/${id}/report`, {
			token: reporter.token,
			body: { reason: "spam" },
		});

		const queue = await api.get("/v1/admin/reports", { token: admin.token });
		const reportId = queue.body[0].latestReportId as string;

		const [first, second] = await Promise.all([
			api.post(`/v1/admin/reports/${reportId}/resolve`, {
				token: admin.token,
				body: { action: "remove", note: "gone" },
			}),
			api.post(`/v1/admin/reports/${reportId}/resolve`, {
				token: admin.token,
				body: { action: "remove", note: "gone" },
			}),
		]);

		// Two admins clicking at the same moment: one wins, the other is told
		// why. Neither may leave the content in a state nobody chose.
		const statuses = [first.status, second.status].sort();
		expect(statuses[0]).toBe(200);
		expect(statuses[1]).toBe(409);

		const [row] = await testDb
			.select({ status: content.status })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.status).toBe("removed");
	});

	test("opposing decisions cannot both be accepted", async () => {
		const id = await publish("Conflicting verdicts");
		const firstReporter = await auth.signIn();
		const secondReporter = await auth.signIn();
		await api.post(`/v1/content/${id}/report`, {
			token: firstReporter.token,
			body: { reason: "spam" },
		});
		await api.post(`/v1/content/${id}/report`, {
			token: secondReporter.token,
			body: { reason: "spam" },
		});

		const openReports = await testDb
			.select({ id: reports.id })
			.from(reports)
			.where(eq(reports.contentId, id));
		const firstReportId = openReports[0]?.id;
		const secondReportId = openReports[1]?.id;
		if (!firstReportId || !secondReportId) {
			throw new Error("Expected two open reports for the concurrency test");
		}

		const [keep, remove] = await Promise.all([
			api.post(`/v1/admin/reports/${firstReportId}/resolve`, {
				token: admin.token,
				body: { action: "keep", note: "acceptable" },
			}),
			api.post(`/v1/admin/reports/${secondReportId}/resolve`, {
				token: admin.token,
				body: { action: "remove", note: "not acceptable" },
			}),
		]);

		expect([keep.status, remove.status].sort()).toEqual([200, 409]);

		const [row] = await testDb
			.select({
				status: content.status,
				visibilityHold: content.visibilityHold,
			})
			.from(content)
			.where(eq(content.id, id));

		if (keep.status === 200) {
			expect(row).toMatchObject({ status: "published", visibilityHold: false });
		} else {
			expect(row?.status).toBe("removed");
		}
	});
});

describe("concurrent approval", () => {
	test("two admins approving at once produce one approval", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Race", primaryLanguage: "hi" },
		});
		const id = created.body.id as string;
		const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
			token: designer.token,
			body: { mimeType: "image/jpeg", bytes: 2048 },
		});
		r2.putObject(url.body.storageKey);
		await api.post(`/v1/designer/content/${id}/assets`, {
			token: designer.token,
			body: { storageKey: url.body.storageKey, width: 1, height: 1 },
		});
		await api.put(`/v1/designer/content/${id}/tags`, {
			token: designer.token,
			body: { tagIds: ["tag_good-morning"] },
		});
		await api.post(`/v1/designer/content/${id}/submit`, {
			token: designer.token,
		});

		const second = await auth.signIn({ role: "admin" });
		const results = await Promise.all([
			api.post(`/v1/admin/content/${id}/approve`, { token: admin.token }),
			api.post(`/v1/admin/content/${id}/approve`, { token: second.token }),
		]);

		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

		const audit = await api.get(`/v1/admin/content/${id}/audit`, {
			token: admin.token,
		});
		const approvals = (audit.body.timeline as { kind: string }[]).filter(
			(e) => e.kind === "approve",
		);
		expect(approvals).toHaveLength(1);
	});
});

describe("oversized input", () => {
	test("a body far past the schema limit is refused, not buffered", async () => {
		const res = await api.post("/v1/designer/content", {
			token: designer.token,
			body: {
				title: "x".repeat(5_000_000),
				primaryLanguage: "hi",
			},
		});

		expect([413, 422]).toContain(res.status);
	});
});

describe("replacing an image", () => {
	async function uploadTo(id: string) {
		const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
			token: designer.token,
			body: { mimeType: "image/jpeg", bytes: 2048 },
		});
		r2.putObject(url.body.storageKey);
		await api.post(`/v1/designer/content/${id}/assets`, {
			token: designer.token,
			body: { storageKey: url.body.storageKey, width: 1, height: 1 },
		});
		return url.body.storageKey as string;
	}

	test("leaves one image, and it is the new one", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Wrong file first", primaryLanguage: "hi" },
		});
		const id = created.body.id as string;

		const first = await uploadTo(id);
		const second = await uploadTo(id);

		const detail = await api.get(`/v1/designer/content/${id}`, {
			token: designer.token,
		});

		// A second asset nobody can ever see is storage being paid for and a
		// designer with no way to correct a mistake.
		expect(detail.body.assets).toHaveLength(1);
		expect(detail.body.assets[0].storageKey).toBe(second);
		expect(r2.has(first)).toBe(false);
	});

	test("is what a reader actually downloads", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Corrected", primaryLanguage: "hi" },
		});
		const id = created.body.id as string;

		await uploadTo(id);
		const corrected = await uploadTo(id);

		await api.put(`/v1/designer/content/${id}/tags`, {
			token: designer.token,
			body: { tagIds: ["tag_good-morning"] },
		});
		await api.post(`/v1/designer/content/${id}/submit`, {
			token: designer.token,
		});
		await api.post(`/v1/admin/content/${id}/approve`, { token: admin.token });

		const reader = await auth.signIn();
		await api.put("/v1/me/profile", {
			token: reader.token,
			body: { regionCode: "IN-MH", languages: ["hi"] },
		});

		const feed = await api.get("/v1/feed", { token: reader.token });
		const tile = feed.body.items.find((i: { id: string }) => i.id === id);
		const download = await api.post(`/v1/content/${id}/download`, {
			token: reader.token,
		});

		// The tile someone taps and the file they receive must be the same
		// image. These used to be read from two different places.
		expect(tile.storageKey).toBe(corrected);
		expect(download.body.url).toContain(corrected);
	});

	test("cannot replace the reviewed image after submission wins the race", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Submit race", primaryLanguage: "hi" },
		});
		const id = created.body.id as string;
		const original = await uploadTo(id);
		await api.put(`/v1/designer/content/${id}/tags`, {
			token: designer.token,
			body: { tagIds: ["tag_good-morning"] },
		});

		const replacement = await api.post(
			`/v1/designer/content/${id}/upload-url`,
			{
				token: designer.token,
				body: { mimeType: "image/jpeg", bytes: 2048 },
			},
		);
		r2.putObject(replacement.body.storageKey);

		let releaseStat!: () => void;
		let markStatStarted!: () => void;
		const statStarted = new Promise<void>((resolve) => {
			markStatStarted = resolve;
		});
		const mayFinishStat = new Promise<void>((resolve) => {
			releaseStat = resolve;
		});
		const delayedApp = createApp({
			tokenVerifier: firebase.verifier,
			objectStorage: {
				...r2.storage,
				async stat(key) {
					markStatStarted();
					await mayFinishStat;
					return r2.storage.stat(key);
				},
			},
		});
		const delayedApi = client(delayedApp);

		const confirm = delayedApi.post(`/v1/designer/content/${id}/assets`, {
			token: designer.token,
			body: {
				storageKey: replacement.body.storageKey,
				width: 1,
				height: 1,
			},
		});

		await statStarted;
		const submitted = await api.post(`/v1/designer/content/${id}/submit`, {
			token: designer.token,
		});
		releaseStat();
		const confirmed = await confirm;

		expect(submitted.status).toBe(200);
		expect(confirmed.status).toBe(409);

		const detail = await api.get(`/v1/designer/content/${id}`, {
			token: designer.token,
		});
		expect(detail.body.status).toBe("pending_review");
		expect(detail.body.assets).toHaveLength(1);
		expect(detail.body.assets[0].storageKey).toBe(original);
	});
});

describe("what the designer detail endpoint returns", () => {
	test("does not leak search or ranking internals", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designer.token,
			body: { title: "Private internals", primaryLanguage: "hi" },
		});

		const detail = await api.get(`/v1/designer/content/${created.body.id}`, {
			token: designer.token,
		});

		// `select()` returns the whole row, including the generated tsvector and
		// the feed's stored score. Neither is any use to a client, and the
		// tsvector grows with the description.
		for (const leaked of [
			"titleTsv",
			"baseScore",
			"recentDownloads",
			"primaryAssetKey",
		]) {
			expect(Object.keys(detail.body)).not.toContain(leaked);
		}
	});
});
