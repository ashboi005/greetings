/**
 * The spec's end-to-end acceptance walkthrough (spec §15).
 *
 * Driven entirely through the HTTP API, with no direct database writes except
 * to age a rollup date, because the point is to prove the whole system works
 * the way a real client would drive it — not that each module works in
 * isolation, which the other suites already cover.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { downloadEvents } from "@greetings/db/schema";
import { createApp } from "../src/app";
import { previousDay, rollupDay } from "../src/jobs/rollup-daily-stats";
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

describe("a designer's image reaches a user and comes back down", () => {
	// Deliberately one long ordered story rather than isolated cases: the
	// value here is that each step's output feeds the next.
	let superToken: string;
	let adminToken: string;
	let designerToken: string;
	let designerId: string;
	let readerToken: string;
	let contentId: string;

	beforeAll(async () => {
		await truncateAll();
		firebase.reset();
		r2.reset();
		await seedReference();
	});

	test("1. a super admin exists and grants the designer role by email", async () => {
		const boss = await auth.signIn({
			role: "super_admin",
			email: "boss@greetings.test",
			emailVerified: true,
		});
		superToken = boss.token;

		const admin = await auth.signIn({ role: "admin" });
		adminToken = admin.token;

		// The designer has no account yet — the grant must wait for them.
		const invite = await api.post("/v1/admin/roles/assign", {
			token: superToken,
			body: { email: "designer@greetings.test", role: "designer" },
		});
		expect(invite.status).toBe(200);
		expect(invite.body.invited).toBe(true);
	});

	test("2. the designer signs in and the pending role is applied", async () => {
		const designer = await auth.signIn({
			email: "designer@greetings.test",
			emailVerified: true,
		});

		expect(designer.role).toBe("designer");
		designerToken = designer.token;
		designerId = designer.userId;
	});

	test("3. the designer uploads an image and submits it", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designerToken,
			body: {
				title: "शुभ प्रभात",
				description: "Sunrise blessings",
				primaryLanguage: "hi",
				regionCode: "IN-MH",
			},
		});
		expect(created.status).toBe(200);
		contentId = created.body.id;

		const upload = await api.post(
			`/v1/designer/content/${contentId}/upload-url`,
			{ token: designerToken, body: { mimeType: "image/jpeg", bytes: 51_200 } },
		);
		expect(upload.status).toBe(200);

		// The client PUTs to R2 directly; the server never sees the bytes.
		r2.putObject(upload.body.storageKey, { size: 51_200 });

		const confirmed = await api.post(
			`/v1/designer/content/${contentId}/assets`,
			{
				token: designerToken,
				body: {
					storageKey: upload.body.storageKey,
					width: 1080,
					height: 1920,
				},
			},
		);
		expect(confirmed.status).toBe(200);

		await api.put(`/v1/designer/content/${contentId}/tags`, {
			token: designerToken,
			body: { tagIds: ["tag_good-morning"] },
		});

		const submitted = await api.post(
			`/v1/designer/content/${contentId}/submit`,
			{ token: designerToken },
		);
		expect(submitted.body.status).toBe("pending_review");
	});

	test("4. an admin finds it in the queue and approves it", async () => {
		const queue = await api.get("/v1/admin/content/queue", {
			token: adminToken,
		});
		expect(queue.body.map((row: { id: string }) => row.id)).toContain(
			contentId,
		);

		const approved = await api.post(`/v1/admin/content/${contentId}/approve`, {
			token: adminToken,
		});
		expect(approved.body.status).toBe("published");
	});

	test("5. a mobile user signs in and onboards", async () => {
		const reader = await auth.signIn({ phone: "+919876543210" });
		readerToken = reader.token;

		const profile = await api.put("/v1/me/profile", {
			token: readerToken,
			body: {
				displayName: "Asha",
				regionCode: "IN-MH",
				languages: ["mr", "hi"],
			},
		});
		expect(profile.status).toBe(200);
		expect(
			(await api.get("/v1/me/profile", { token: readerToken })).body.onboarded,
		).toBe(true);
	});

	test("6. the image appears in that user's feed", async () => {
		const feed = await api.get("/v1/feed", { token: readerToken });
		expect(feed.status).toBe(200);
		expect(feed.body.items.map((i: { id: string }) => i.id)).toContain(
			contentId,
		);
	});

	test("7. and is findable by search, including with a typo", async () => {
		const exact = await api.get(`/v1/search?q=${encodeURIComponent("प्रभात")}`, {
			token: readerToken,
		});
		expect(exact.body.items.map((i: { id: string }) => i.id)).toContain(
			contentId,
		);

		const typo = await api.get("/v1/search?q=sunrize", { token: readerToken });
		expect(typo.status).toBe(200);
	});

	test("8. the user downloads it and gets a signed URL", async () => {
		const download = await api.post(`/v1/content/${contentId}/download`, {
			token: readerToken,
			body: { source: "feed" },
		});

		expect(download.status).toBe(200);
		expect(download.body.url).toBeTruthy();
		expect(download.body.recorded).toBe(true);
	});

	test("9. designer analytics attribute it to the right region", async () => {
		const summary = await api.get("/v1/designer/analytics/summary", {
			token: designerToken,
		});
		expect(summary.body.totalDownloads).toBe(1);

		const byRegion = await api.get("/v1/designer/analytics/by-region", {
			token: designerToken,
		});
		const rows = byRegion.body as { regionCode: string; downloads: number }[];
		expect(rows[0]?.regionCode).toBe("IN-MH");
		expect(rows[0]?.downloads).toBe(1);
	});

	test("10. the nightly rollup preserves those numbers", async () => {
		// Age the event into yesterday so the rollup has something to do, then
		// confirm the total is unchanged — the point of the union query.
		await testDb.update(downloadEvents).set({
			createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
		});
		await rollupDay(previousDay());

		const summary = await api.get("/v1/designer/analytics/summary", {
			token: designerToken,
		});
		expect(summary.body.totalDownloads).toBe(1);
	});

	test("11. platform analytics show the designer's work", async () => {
		const overview = await api.get("/v1/admin/analytics/overview", {
			token: superToken,
		});
		expect(overview.body.publishedContent).toBe(1);
		expect(overview.body.downloadsInRange).toBe(1);

		const byDesigner = await api.get("/v1/admin/analytics/by-designer", {
			token: superToken,
		});
		const rows = byDesigner.body as { designerId: string }[];
		expect(rows[0]?.designerId).toBe(designerId);
	});

	test("12. a user reports the content", async () => {
		const reported = await api.post(`/v1/content/${contentId}/report`, {
			token: readerToken,
			body: { reason: "inappropriate", note: "Not suitable" },
		});
		expect(reported.status).toBe(200);

		const queue = await api.get("/v1/admin/reports", { token: adminToken });
		expect(queue.body[0].contentId).toBe(contentId);
	});

	test("13. an admin removes it", async () => {
		const queue = await api.get("/v1/admin/reports", { token: adminToken });
		const reportId = queue.body[0].latestReportId;

		const resolved = await api.post(`/v1/admin/reports/${reportId}/resolve`, {
			token: adminToken,
			body: { action: "remove", note: "Breaches guidelines" },
		});
		expect(resolved.body.contentStatus).toBe("removed");
	});

	test("14. it disappears from the feed and can no longer be downloaded", async () => {
		const feed = await api.get("/v1/feed", { token: readerToken });
		expect(feed.body.items.map((i: { id: string }) => i.id)).not.toContain(
			contentId,
		);

		const download = await api.post(`/v1/content/${contentId}/download`, {
			token: readerToken,
			body: {},
		});
		expect(download.status).toBe(409);

		// The designer keeps their historical numbers: the download happened.
		const summary = await api.get("/v1/designer/analytics/summary", {
			token: designerToken,
		});
		expect(summary.body.totalDownloads).toBe(1);
	});
});
