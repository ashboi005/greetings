/**
 * The audit trail, read through the API (spec §13).
 *
 * These tests assert the property that matters: after a piece of content has
 * been through the mill, a super admin who finds it can say who did each thing
 * and why, without opening a database client.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { REPORT_HOLD_THRESHOLD } from "../src/modules/moderation/reports";
import { truncateAll } from "./db";
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
let superAdmin: Awaited<ReturnType<typeof auth.signIn>>;

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	r2.reset();
	await seedReference();

	designer = await auth.signIn({ role: "designer" });
	admin = await auth.signIn({ role: "admin" });
	superAdmin = await auth.signIn({ role: "super_admin" });
});

async function draft(title: string) {
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
	return id;
}

async function publish(title = "Audited") {
	const id = await draft(title);
	await api.post(`/v1/designer/content/${id}/submit`, { token: designer.token });
	await api.post(`/v1/admin/content/${id}/approve`, { token: admin.token });
	return id;
}

describe("the content timeline", () => {
	test("names the person behind every step", async () => {
		const id = await publish("Traceable");
		await api.post(`/v1/admin/content/${id}/remove`, {
			token: admin.token,
			body: { reason: "Wrong festival date" },
		});

		const res = await api.get(`/v1/admin/content/${id}/audit`, {
			token: superAdmin.token,
		});

		expect(res.status).toBe(200);

		const byKind = new Map<string, TimelineEntry>(
			(res.body.timeline as TimelineEntry[]).map((e) => [e.kind, e]),
		);

		// Who made it.
		expect(byKind.get("created")?.actor?.id).toBe(designer.userId);
		// Who sent it for review.
		expect(byKind.get("submit")?.actor?.id).toBe(designer.userId);
		// Who approved it.
		expect(byKind.get("approve")?.actor?.id).toBe(admin.userId);
		expect(byKind.get("approve")?.actor?.role).toBe("admin");
		// Who removed it, and why.
		expect(byKind.get("remove")?.actor?.id).toBe(admin.userId);
		expect(byKind.get("remove")?.reason).toBe("Wrong festival date");
	});

	test("orders newest first", async () => {
		const id = await publish("Ordered");
		await api.post(`/v1/admin/content/${id}/remove`, {
			token: admin.token,
			body: { reason: "later" },
		});

		const res = await api.get(`/v1/admin/content/${id}/audit`, {
			token: admin.token,
		});

		const times = (res.body.timeline as TimelineEntry[]).map((e) =>
			new Date(e.at).getTime(),
		);
		expect(times).toEqual([...times].sort((a, b) => b - a));
		// The most recent thing that happened is the removal.
		expect(res.body.timeline[0].kind).toBe("remove");
	});

	test("includes reports and who made them", async () => {
		const id = await publish("Reported");
		const reporter = await auth.signIn();

		await api.post(`/v1/content/${id}/report`, {
			token: reporter.token,
			body: { reason: "copyright", note: "This is my photograph" },
		});

		const res = await api.get(`/v1/admin/content/${id}/audit`, {
			token: admin.token,
		});

		const reported = (res.body.timeline as TimelineEntry[]).find(
			(e) => e.kind === "reported",
		);
		expect(reported?.actor?.id).toBe(reporter.userId);
		expect(reported?.reason).toBe("copyright");
		expect(reported?.note).toBe("This is my photograph");
	});

	test("shows the automatic hold as having no human actor", async () => {
		const id = await publish("Brigaded");

		for (let i = 0; i < REPORT_HOLD_THRESHOLD; i++) {
			const reporter = await auth.signIn();
			await api.post(`/v1/content/${id}/report`, {
				token: reporter.token,
				body: { reason: "spam" },
			});
		}

		const res = await api.get(`/v1/admin/content/${id}/audit`, {
			token: admin.token,
		});

		const hold = (res.body.timeline as TimelineEntry[]).find(
			(e) => e.kind === "hold",
		);
		// The distinction the audit has to preserve: nobody decided this, a
		// threshold did. Attributing it to an admin would be a lie.
		expect(hold).toBeDefined();
		expect(hold?.actor).toBeNull();
		expect(hold?.reason).toContain("Automatically held");
	});

	test("records the admin who resolved a report", async () => {
		const id = await publish("Resolved");
		const reporter = await auth.signIn();

		await api.post(`/v1/content/${id}/report`, {
			token: reporter.token,
			body: { reason: "wrong_info" },
		});

		const queue = await api.get("/v1/admin/reports", { token: admin.token });
		await api.post(
			`/v1/admin/reports/${queue.body[0].latestReportId}/resolve`,
			{
				token: admin.token,
				body: { action: "keep", note: "Checked the date, it is right" },
			},
		);

		const res = await api.get(`/v1/admin/content/${id}/audit`, {
			token: admin.token,
		});

		const resolution = (res.body.timeline as TimelineEntry[]).find(
			(e) => e.kind === "report_resolved",
		);
		expect(resolution?.actor?.id).toBe(admin.userId);
		expect(resolution?.reason).toBe("resolved_kept");
		expect(resolution?.note).toBe("Checked the date, it is right");
	});

	test("404s for content that does not exist", async () => {
		const res = await api.get("/v1/admin/content/nope/audit", {
			token: admin.token,
		});
		expect(res.status).toBe(404);
	});

	test("is closed to designers and users", async () => {
		const id = await publish();
		const reader = await auth.signIn();

		expect(
			(await api.get(`/v1/admin/content/${id}/audit`, { token: reader.token }))
				.status,
		).toBe(403);
		expect(
			(
				await api.get(`/v1/admin/content/${id}/audit`, {
					token: designer.token,
				})
			).status,
		).toBe(403);
	});
});

describe("finding the item to audit", () => {
	test("searches by title across every status", async () => {
		await publish("Diwali wishes");
		const removed = await publish("Holi wishes");
		await api.post(`/v1/admin/content/${removed}/remove`, {
			token: admin.token,
			body: { reason: "duplicate" },
		});
		await draft("Never submitted");

		const res = await api.get("/v1/admin/content?q=wishes", {
			token: admin.token,
		});

		expect(res.status).toBe(200);
		const titles = res.body.map((r: { title: string }) => r.title).sort();
		expect(titles).toEqual(["Diwali wishes", "Holi wishes"]);

		// Removed content is exactly what someone auditing is looking for, so
		// the search must not quietly exclude it the way the feed does.
		const statuses = res.body.map((r: { status: string }) => r.status);
		expect(statuses).toContain("removed");
	});

	test("accepts a pasted content id", async () => {
		const id = await publish("Findable");
		const res = await api.get(`/v1/admin/content?q=${id}`, {
			token: admin.token,
		});
		expect(res.body).toHaveLength(1);
		expect(res.body[0].id).toBe(id);
	});

	test("reports how many open reports each item carries", async () => {
		const id = await publish("Flagged");
		const reporter = await auth.signIn();
		await api.post(`/v1/content/${id}/report`, {
			token: reporter.token,
			body: { reason: "spam" },
		});

		const res = await api.get("/v1/admin/content?q=Flagged", {
			token: admin.token,
		});
		expect(res.body[0].openReports).toBe(1);
	});

	test("filters by status and by designer", async () => {
		await publish("Published one");
		await draft("Draft one");

		const drafts = await api.get("/v1/admin/content?status=draft", {
			token: admin.token,
		});
		expect(drafts.body.map((r: { title: string }) => r.title)).toEqual([
			"Draft one",
		]);

		const mine = await api.get(
			`/v1/admin/content?designerId=${designer.userId}`,
			{ token: admin.token },
		);
		expect(mine.body.length).toBe(2);

		const someoneElse = await api.get(
			"/v1/admin/content?designerId=nobody",
			{ token: admin.token },
		);
		expect(someoneElse.body).toHaveLength(0);
	});
});

describe("the role change log", () => {
	test("records who granted what, to whom", async () => {
		const target = await auth.signIn({ email: "newdesigner@example.com" });

		await api.post("/v1/admin/roles/assign", {
			token: superAdmin.token,
			body: {
				email: "newdesigner@example.com",
				role: "designer",
				reason: "Joined the content team",
			},
		});

		const res = await api.get("/v1/admin/audit/roles", {
			token: superAdmin.token,
		});

		expect(res.status).toBe(200);
		const entry = res.body.items.find(
			(e: { targetId: string }) => e.targetId === target.userId,
		);
		expect(entry.actorId).toBe(superAdmin.userId);
		expect(entry.fromRole).toBe("user");
		expect(entry.toRole).toBe("designer");
		expect(entry.reason).toBe("Joined the content team");
		expect(entry.targetEmail).toBe("newdesigner@example.com");
	});

	test("records a grant applied through an invite, with no human actor", async () => {
		await api.post("/v1/admin/roles/assign", {
			token: superAdmin.token,
			body: { email: "future@example.com", role: "admin" },
		});

		// The grant lands when they first sign in, days later.
		const arrival = await auth.signIn({ email: "future@example.com" });
		expect(arrival.role).toBe("admin");

		const res = await api.get("/v1/admin/audit/roles", {
			token: superAdmin.token,
		});
		const entry = res.body.items.find(
			(e: { targetId: string }) => e.targetId === arrival.userId,
		);
		expect(entry.toRole).toBe("admin");
		expect(entry.actorId).toBeNull();
		expect(entry.reason).toContain("invite");
	});

	test("is closed to admins — only a super admin grants, and reads, roles", async () => {
		const res = await api.get("/v1/admin/audit/roles", { token: admin.token });
		expect(res.status).toBe(403);
	});

	test("pages without repeating or skipping", async () => {
		for (let i = 0; i < 5; i++) {
			const person = await auth.signIn({ email: `p${i}@example.com` });
			await api.post("/v1/admin/roles/assign", {
				token: superAdmin.token,
				body: { email: person.email, role: "designer" },
			});
		}

		const seen: string[] = [];
		let cursor: string | null = null;

		do {
			const page: { body: { items: { id: string }[]; nextCursor: string } } =
				await api.get(
					`/v1/admin/audit/roles?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
					{ token: superAdmin.token },
				);
			seen.push(...page.body.items.map((e) => e.id));
			cursor = page.body.nextCursor;
		} while (cursor);

		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.length).toBeGreaterThanOrEqual(5);
	});
});

describe("withdrawn invites", () => {
	test("stop granting but stay on the record", async () => {
		const created = await api.post("/v1/admin/roles/assign", {
			token: superAdmin.token,
			body: { email: "regret@example.com", role: "super_admin" },
		});

		await api.delete(`/v1/admin/roles/invites/${created.body.inviteId}`, {
			token: superAdmin.token,
		});

		// The whole point: signing in must not hand them the role.
		const arrival = await auth.signIn({ email: "regret@example.com" });
		expect(arrival.role).toBe("user");

		const outstanding = await api.get("/v1/admin/roles/invites", {
			token: superAdmin.token,
		});
		expect(outstanding.body).toHaveLength(0);

		const all = await api.get("/v1/admin/roles/invites?includeSettled=true", {
			token: superAdmin.token,
		});
		const revoked = all.body.find(
			(i: { id: string }) => i.id === created.body.inviteId,
		);
		expect(revoked.revokedAt).not.toBeNull();
		expect(revoked.revokedBy).toBe(superAdmin.userId);
	});

	test("free the address to be invited again", async () => {
		const first = await api.post("/v1/admin/roles/assign", {
			token: superAdmin.token,
			body: { email: "second-thoughts@example.com", role: "admin" },
		});
		await api.delete(`/v1/admin/roles/invites/${first.body.inviteId}`, {
			token: superAdmin.token,
		});

		const second = await api.post("/v1/admin/roles/assign", {
			token: superAdmin.token,
			body: { email: "second-thoughts@example.com", role: "designer" },
		});
		expect(second.status).toBe(200);
		expect(second.body.invited).toBe(true);
	});
});

describe("moderation activity", () => {
	test("lists recent decisions across all content", async () => {
		const a = await publish("First");
		const b = await publish("Second");
		await api.post(`/v1/admin/content/${b}/remove`, {
			token: admin.token,
			body: { reason: "off-brand" },
		});

		const res = await api.get("/v1/admin/audit/actions", {
			token: admin.token,
		});

		expect(res.status).toBe(200);
		const contentIds = res.body.items.map((e: { contentId: string }) => e.contentId);
		expect(contentIds).toContain(a);
		expect(contentIds).toContain(b);
		expect(res.body.items[0].action).toBe("remove");
		expect(res.body.items[0].actorName).toBeTruthy();
	});

	test("filters to one moderator's decisions", async () => {
		const other = await auth.signIn({ role: "admin" });
		const id = await publish("Reviewed by someone else");
		await api.post(`/v1/admin/content/${id}/remove`, {
			token: other.token,
			body: { reason: "theirs" },
		});

		const res = await api.get(
			`/v1/admin/audit/actions?actorId=${other.userId}`,
			{ token: superAdmin.token },
		);

		const actors = new Set(
			res.body.items.map((e: { actorId: string }) => e.actorId),
		);
		expect([...actors]).toEqual([other.userId]);
	});

	test("filters to one kind of action", async () => {
		await publish("Approved item");

		const res = await api.get("/v1/admin/audit/actions?action=approve", {
			token: admin.token,
		});
		const actions = new Set(
			res.body.items.map((e: { action: string }) => e.action),
		);
		expect([...actions]).toEqual(["approve"]);
	});
});

describe("the user directory", () => {
	test("finds someone by email, name or phone", async () => {
		const person = await auth.signIn({ email: "findme@example.com" });

		const byEmail = await api.get("/v1/admin/users?q=findme", {
			token: superAdmin.token,
		});
		expect(byEmail.body.map((u: { id: string }) => u.id)).toContain(
			person.userId,
		);

		const byPhone = await api.get(
			`/v1/admin/users?q=${encodeURIComponent(person.identity.phone as string)}`,
			{ token: superAdmin.token },
		);
		expect(byPhone.body.map((u: { id: string }) => u.id)).toContain(
			person.userId,
		);
	});

	test("filters by role", async () => {
		const res = await api.get("/v1/admin/users?role=designer", {
			token: superAdmin.token,
		});
		const roles = new Set(res.body.map((u: { role: string }) => u.role));
		expect([...roles]).toEqual(["designer"]);
	});

	test("shows when a person's role last changed", async () => {
		const person = await auth.signIn({ email: "promoted@example.com" });
		await api.post("/v1/admin/roles/assign", {
			token: superAdmin.token,
			body: { email: "promoted@example.com", role: "designer" },
		});

		const res = await api.get("/v1/admin/users?q=promoted", {
			token: superAdmin.token,
		});
		const found = res.body.find((u: { id: string }) => u.id === person.userId);
		expect(found.role).toBe("designer");
		expect(found.roleChangedAt).not.toBeNull();
	});

	test("is closed to designers", async () => {
		const res = await api.get("/v1/admin/users", { token: designer.token });
		expect(res.status).toBe(403);
	});
});

interface TimelineEntry {
	kind: string;
	at: string;
	actor: { id: string; name: string; email: string; role: string } | null;
	reason: string | null;
	note: string | null;
}
