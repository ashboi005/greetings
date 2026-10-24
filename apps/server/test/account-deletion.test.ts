/**
 * Deleting your own account (DELETE /v1/me).
 *
 * Google Play requires it of any app that creates accounts. What matters is
 * that it is complete — sessions, profile, designs and uploaded files all go —
 * without taking designers' numbers with it: a deleted reader's downloads still
 * happened, and designers are judged on those counts.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	account,
	content,
	downloadEvents,
	session,
	user,
	userDesigns,
	userProfiles,
} from "@greetings/db/schema";
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

/** A reader with a profile, a logo and a design with both its images. */
async function fullReader() {
	const reader = await auth.signIn();
	await api.put("/v1/me/profile", {
		token: reader.token,
		body: { regionCode: "IN-MH", languages: ["hi"], displayName: "Ramesh" },
	});

	const logo = await api.post("/v1/me/avatar/upload-url", {
		token: reader.token,
		body: { mimeType: "image/png", bytes: 1024 },
	});
	r2.putObject(logo.body.storageKey, { contentType: "image/png" });
	await api.post("/v1/me/avatar", {
		token: reader.token,
		body: { storageKey: logo.body.storageKey },
	});

	const design = await api.post("/v1/me/designs", {
		token: reader.token,
		body: { title: "Diwali", designJson: { version: 1 } },
	});
	const designId = design.body.id as string;
	for (const purpose of ["source", "preview"] as const) {
		const url = await api.post(`/v1/me/designs/${designId}/upload-url`, {
			token: reader.token,
			body: { purpose, mimeType: "image/jpeg", bytes: 2048 },
		});
		r2.putObject(url.body.storageKey);
		await api.post(`/v1/me/designs/${designId}/assets`, {
			token: reader.token,
			body: { purpose, storageKey: url.body.storageKey },
		});
	}

	return { ...reader, logoKey: logo.body.storageKey as string, designId };
}

/** Publishes one greeting through the real designer → admin path. */
async function publishedGreeting() {
	const designer = await auth.signIn({ role: "designer" });
	const admin = await auth.signIn({ role: "admin" });

	const created = await api.post("/v1/designer/content", {
		token: designer.token,
		body: { title: "Good Morning", primaryLanguage: "hi" },
	});
	const id = created.body.id as string;
	const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
		token: designer.token,
		body: { mimeType: "image/jpeg", bytes: 2048 },
	});
	r2.putObject(url.body.storageKey);
	await api.post(`/v1/designer/content/${id}/assets`, {
		token: designer.token,
		body: { storageKey: url.body.storageKey, width: 1080, height: 1920 },
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

describe("DELETE /v1/me", () => {
	test("removes the account, its sessions, profile and designs", async () => {
		const reader = await fullReader();

		const res = await api.delete("/v1/me", { token: reader.token });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });

		const userId = reader.userId;
		expect(await testDb.select().from(user).where(eq(user.id, userId))).toEqual(
			[],
		);
		expect(
			await testDb.select().from(session).where(eq(session.userId, userId)),
		).toEqual([]);
		expect(
			await testDb.select().from(account).where(eq(account.userId, userId)),
		).toEqual([]);
		expect(
			await testDb
				.select()
				.from(userProfiles)
				.where(eq(userProfiles.userId, userId)),
		).toEqual([]);
		expect(
			await testDb
				.select()
				.from(userDesigns)
				.where(eq(userDesigns.userId, userId)),
		).toEqual([]);
	});

	test("deletes the uploaded logo and design images from storage", async () => {
		const reader = await fullReader();
		const prefixes = [
			`avatars/${reader.userId}/`,
			`designs/${reader.designId}/`,
		];
		const before = (
			await Promise.all(prefixes.map((p) => r2.storage.list(p)))
		).flat();
		expect(before.length).toBe(3); // logo, design source, design preview

		await api.delete("/v1/me", { token: reader.token });

		const after = (
			await Promise.all(prefixes.map((p) => r2.storage.list(p)))
		).flat();
		expect(after).toEqual([]);
		expect(r2.has(reader.logoKey)).toBe(false);
	});

	test("the token stops working at once, even though sessions are cached", async () => {
		const reader = await auth.signIn();
		// Warm the session cache, as any normal request would.
		expect(
			(await api.get("/v1/me/profile", { token: reader.token })).status,
		).toBe(200);

		await api.delete("/v1/me", { token: reader.token });

		const after = await api.get("/v1/me/profile", { token: reader.token });
		expect(after.status).toBe(401);
		expect(after.body.error.code).toBe("UNAUTHENTICATED");
	});

	test("keeps designers' download counts, detached from the reader", async () => {
		const contentId = await publishedGreeting();
		const reader = await fullReader();

		const dl = await api.post(`/v1/content/${contentId}/download`, {
			token: reader.token,
			body: { source: "feed" },
		});
		expect(dl.status).toBe(200);

		await api.delete("/v1/me", { token: reader.token });

		const events = await testDb
			.select()
			.from(downloadEvents)
			.where(eq(downloadEvents.contentId, contentId));
		expect(events.length).toBe(1);
		expect(events[0]?.userId).toBeNull();
		// Attribution that is about the download, not the person, survives.
		expect(events[0]?.regionCode).toBe("IN-MH");

		const [row] = await testDb
			.select({ count: content.downloadCount })
			.from(content)
			.where(eq(content.id, contentId));
		expect(row?.count).toBe(1);
	});

	test("signing in again afterwards starts a brand-new account", async () => {
		const reader = await fullReader();
		await api.delete("/v1/me", { token: reader.token });

		const again = await auth.reSignIn(reader.identity);
		const profile = await api.get("/v1/me/profile", { token: again.token });

		expect(profile.status).toBe(200);
		expect(profile.body.onboarded).toBe(false);
		expect(profile.body.displayName).toBeNull();
		expect(profile.body.avatarKey).toBeNull();
	});

	test("panel accounts cannot delete themselves from the app", async () => {
		for (const role of ["designer", "admin", "super_admin"] as const) {
			const panel = await auth.signIn({ role });
			const res = await api.delete("/v1/me", { token: panel.token });
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe("FORBIDDEN");
			expect(
				await testDb.select().from(user).where(eq(user.id, panel.userId)),
			).toHaveLength(1);
		}
	});

	test("needs a session", async () => {
		const res = await api.delete("/v1/me");
		expect(res.status).toBe(401);
	});

	test("a storage outage does not block deletion", async () => {
		const reader = await fullReader();
		r2.breakDeletes();

		const res = await api.delete("/v1/me", { token: reader.token });

		// The person asked to be deleted; their data rows go regardless. Any
		// object left behind is unreachable — no row points at it, and its key
		// carries a random suffix — and the failure is logged for cleanup.
		expect(res.status).toBe(200);
		expect(
			await testDb.select().from(user).where(eq(user.id, reader.userId)),
		).toEqual([]);
	});
});
