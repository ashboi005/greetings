import { beforeEach, describe, expect, test } from "bun:test";
import { content, moderationActions, reports } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { REPORT_HOLD_THRESHOLD } from "../src/modules/moderation/reports";
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

async function publish(title = "Reportable") {
	const created = await api.post("/v1/designer/content", {
		token: designerToken,
		body: { title, primaryLanguage: "hi" },
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
		body: { tagIds: ["tag_good-morning"] },
	});
	await api.post(`/v1/designer/content/${id}/submit`, { token: designerToken });
	await api.post(`/v1/admin/content/${id}/approve`, { token: adminToken });
	return id;
}

async function reader() {
	const session = await auth.signIn();
	await api.put("/v1/me/profile", {
		token: session.token,
		body: { regionCode: "IN-MH", languages: ["hi"] },
	});
	return session;
}

const report = (
	id: string,
	token: string,
	reason = "inappropriate",
	note?: string,
) =>
	api.post(`/v1/content/${id}/report`, {
		token,
		body: { reason, ...(note ? { note } : {}) },
	});

describe("submitting a report", () => {
	test("records an open report", async () => {
		const id = await publish();
		const user = await reader();

		const res = await report(id, user.token, "spam", "Selling something");

		expect(res.status).toBe(200);
		expect(res.body.status).toBe("open");
		expect(res.body.heldForReview).toBe(false);

		const [row] = await testDb
			.select()
			.from(reports)
			.where(eq(reports.contentId, id));
		expect(row?.reason).toBe("spam");
		expect(row?.note).toBe("Selling something");
		expect(row?.reporterId).toBe(user.userId);
	});

	test("refuses a second open report from the same person", async () => {
		const id = await publish();
		const user = await reader();

		await report(id, user.token);
		const second = await report(id, user.token, "copyright");

		expect(second.status).toBe(409);
		expect(second.body.error.message).toContain("already reported");
	});

	test("allows a fresh report after the previous one was resolved", async () => {
		const id = await publish();
		const user = await reader();

		const first = await report(id, user.token);
		await api.post(`/v1/admin/reports/${first.body.id}/resolve`, {
			token: adminToken,
			body: { action: "keep" },
		});

		// Content that was kept can still deteriorate, or be reported for a
		// different reason — the constraint is on *open* reports only.
		const again = await report(id, user.token, "wrong_info");
		expect(again.status).toBe(200);
	});

	test("different people may each report the same item", async () => {
		const id = await publish();
		const a = await reader();
		const b = await reader();

		expect((await report(id, a.token)).status).toBe(200);
		expect((await report(id, b.token)).status).toBe(200);

		const rows = await testDb
			.select()
			.from(reports)
			.where(eq(reports.contentId, id));
		expect(rows).toHaveLength(2);
	});

	test("refuses to report content that is not published", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designerToken,
			body: { title: "A draft", primaryLanguage: "hi" },
		});
		const user = await reader();

		const res = await report(created.body.id, user.token);
		expect(res.status).toBe(409);
	});

	test("404s for content that does not exist", async () => {
		const user = await reader();
		expect((await report("nope", user.token)).status).toBe(404);
	});

	test("rejects an unknown reason", async () => {
		const id = await publish();
		const user = await reader();
		const res = await report(id, user.token, "because-i-said-so");
		expect(res.status).toBe(422);
	});

	test("requires authentication", async () => {
		const id = await publish();
		const res = await api.post(`/v1/content/${id}/report`, {
			body: { reason: "spam" },
		});
		expect(res.status).toBe(401);
	});
});

describe("the automatic hold", () => {
	/** Reports an item from `count` distinct users. */
	async function reportFrom(id: string, count: number) {
		const results = [];
		for (let i = 0; i < count; i++) {
			const user = await reader();
			results.push(await report(id, user.token));
		}
		return results;
	}

	test("hides content once the threshold is reached", async () => {
		const id = await publish();

		const results = await reportFrom(id, REPORT_HOLD_THRESHOLD);

		// Only the report that crossed the line reports the hold.
		expect(
			results.slice(0, -1).every((r) => r.body.heldForReview === false),
		).toBe(true);
		expect(results.at(-1)?.body.heldForReview).toBe(true);

		const [row] = await testDb
			.select({ hold: content.visibilityHold, status: content.status })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.hold).toBe(true);
		// A hold hides content; it does not remove it. That is still an admin's
		// call.
		expect(row?.status).toBe("published");
	});

	test("held content disappears from the feed", async () => {
		const id = await publish();
		const viewer = await reader();

		const before = await api.get("/v1/feed", { token: viewer.token });
		expect(before.body.items.map((i: { id: string }) => i.id)).toContain(id);

		await reportFrom(id, REPORT_HOLD_THRESHOLD);

		const after = await api.get("/v1/feed", { token: viewer.token });
		expect(after.body.items.map((i: { id: string }) => i.id)).not.toContain(id);
	});

	test("held content can no longer be downloaded", async () => {
		const id = await publish();
		await reportFrom(id, REPORT_HOLD_THRESHOLD);

		const user = await reader();
		const res = await api.post(`/v1/content/${id}/download`, {
			token: user.token,
			body: {},
		});
		expect(res.status).toBe(409);
	});

	test("stays visible below the threshold", async () => {
		const id = await publish();
		await reportFrom(id, REPORT_HOLD_THRESHOLD - 1);

		const [row] = await testDb
			.select({ hold: content.visibilityHold })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.hold).toBe(false);
	});

	test("records the hold as a system action, with no actor", async () => {
		const id = await publish();
		await reportFrom(id, REPORT_HOLD_THRESHOLD);

		const [action] = await testDb
			.select()
			.from(moderationActions)
			.where(eq(moderationActions.action, "hold"));

		expect(action?.actorId).toBeNull();
		expect(action?.reason).toContain("Automatically held");
	});

	test("concurrent reports crossing the threshold hold exactly once", async () => {
		const id = await publish();

		// Five distinct users all reporting at the same moment: without the row
		// lock each could count four and none would hold.
		const users = await Promise.all(
			Array.from({ length: REPORT_HOLD_THRESHOLD }, () => reader()),
		);
		await Promise.all(users.map((u) => report(id, u.token)));

		const [row] = await testDb
			.select({ hold: content.visibilityHold })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.hold).toBe(true);

		const holds = await testDb
			.select()
			.from(moderationActions)
			.where(eq(moderationActions.action, "hold"));
		expect(holds).toHaveLength(1);
	});
});

describe("the admin queue", () => {
	test("groups by content, most-reported first", async () => {
		const quiet = await publish("Only one complaint");
		const noisy = await publish("Many complaints");

		const a = await reader();
		const b = await reader();
		const c = await reader();

		await report(quiet, a.token);
		await report(noisy, a.token);
		await report(noisy, b.token);
		await report(noisy, c.token);

		const res = await api.get("/v1/admin/reports", { token: adminToken });
		expect(res.status).toBe(200);
		expect(res.body).toHaveLength(2);
		expect(res.body[0].contentId).toBe(noisy);
		expect(Number(res.body[0].reportCount)).toBe(3);
		expect(res.body[1].contentId).toBe(quiet);
	});

	test("lists the distinct reasons given", async () => {
		const id = await publish();
		const a = await reader();
		const b = await reader();

		await report(id, a.token, "copyright");
		await report(id, b.token, "spam");

		const res = await api.get("/v1/admin/reports", { token: adminToken });
		expect([...res.body[0].reasons].sort()).toEqual(["copyright", "spam"]);
	});

	test("shows nothing once everything is resolved", async () => {
		const id = await publish();
		const user = await reader();
		const submitted = await report(id, user.token);

		await api.post(`/v1/admin/reports/${submitted.body.id}/resolve`, {
			token: adminToken,
			body: { action: "keep" },
		});

		const res = await api.get("/v1/admin/reports", { token: adminToken });
		expect(res.body).toEqual([]);
	});
});

describe("resolving reports", () => {
	async function reportedContent(reporters = 1) {
		const id = await publish();
		let firstReportId = "";
		for (let i = 0; i < reporters; i++) {
			const user = await reader();
			const res = await report(id, user.token);
			if (i === 0) firstReportId = res.body.id;
		}
		return { id, reportId: firstReportId };
	}

	test("keeping clears every open report and lifts the hold", async () => {
		const { id, reportId } = await reportedContent(REPORT_HOLD_THRESHOLD);

		const res = await api.post(`/v1/admin/reports/${reportId}/resolve`, {
			token: adminToken,
			body: { action: "keep", note: "Reviewed, nothing wrong" },
		});

		expect(res.status).toBe(200);
		expect(res.body.resolved).toBe(REPORT_HOLD_THRESHOLD);

		const [row] = await testDb
			.select({ hold: content.visibilityHold, status: content.status })
			.from(content)
			.where(eq(content.id, id));
		// Leaving the hold on would keep the content invisible despite the admin
		// having cleared it.
		expect(row?.hold).toBe(false);
		expect(row?.status).toBe("published");

		const open = await testDb
			.select()
			.from(reports)
			.where(eq(reports.status, "open"));
		expect(open).toHaveLength(0);
	});

	test("a kept item comes back into the feed", async () => {
		const { id, reportId } = await reportedContent(REPORT_HOLD_THRESHOLD);
		const viewer = await reader();

		expect(
			(await api.get("/v1/feed", { token: viewer.token })).body.items.map(
				(i: { id: string }) => i.id,
			),
		).not.toContain(id);

		await api.post(`/v1/admin/reports/${reportId}/resolve`, {
			token: adminToken,
			body: { action: "keep" },
		});

		expect(
			(await api.get("/v1/feed", { token: viewer.token })).body.items.map(
				(i: { id: string }) => i.id,
			),
		).toContain(id);
	});

	test("removing takes the content down", async () => {
		const { id, reportId } = await reportedContent(2);

		const res = await api.post(`/v1/admin/reports/${reportId}/resolve`, {
			token: adminToken,
			body: { action: "remove", note: "Breaches guidelines" },
		});

		expect(res.body.contentStatus).toBe("removed");

		const [row] = await testDb
			.select({ status: content.status })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.status).toBe("removed");

		const rows = await testDb.select().from(reports);
		expect(rows.every((r) => r.status === "resolved_removed")).toBe(true);
	});

	test("resolving one report resolves every open report on that content", async () => {
		const { reportId } = await reportedContent(3);

		const res = await api.post(`/v1/admin/reports/${reportId}/resolve`, {
			token: adminToken,
			body: { action: "keep" },
		});

		// Otherwise the same item bounces straight back to the top of the queue.
		expect(res.body.resolved).toBe(3);
	});

	test("refuses to resolve an already-resolved report", async () => {
		const { reportId } = await reportedContent(1);

		await api.post(`/v1/admin/reports/${reportId}/resolve`, {
			token: adminToken,
			body: { action: "keep" },
		});
		const second = await api.post(`/v1/admin/reports/${reportId}/resolve`, {
			token: adminToken,
			body: { action: "keep" },
		});

		expect(second.status).toBe(409);
	});

	test("404s for an unknown report", async () => {
		const res = await api.post("/v1/admin/reports/nope/resolve", {
			token: adminToken,
			body: { action: "keep" },
		});
		expect(res.status).toBe(404);
	});

	test("records who resolved it and why", async () => {
		const { reportId } = await reportedContent(1);

		await api.post(`/v1/admin/reports/${reportId}/resolve`, {
			token: adminToken,
			body: { action: "keep", note: "Checked with the designer" },
		});

		const [row] = await testDb
			.select()
			.from(reports)
			.where(eq(reports.id, reportId));
		expect(row?.resolvedBy).toBeTruthy();
		expect(row?.resolvedAt).not.toBeNull();
		expect(row?.resolutionNote).toBe("Checked with the designer");
	});
});
