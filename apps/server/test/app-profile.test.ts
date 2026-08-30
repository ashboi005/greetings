/**
 * What the mobile app needs from a profile (spec §16).
 *
 * Three things that did not exist before: the fields printed on a shared
 * graphic, the logo upload behind them, and the user's own download history.
 * The interesting cases are the boundaries — a logo key belonging to someone
 * else, an object that was never actually uploaded, and history paging.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { content, downloadEvents, userProfiles } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { recordDownload } from "../src/modules/downloads/service";
import { testDb, truncateAll } from "./db";
import { fakeObjectStorage, fakeTokenVerifier } from "./fakes";
import { authHelper, client, seedReference } from "./helpers";

const CDN = "https://cdn.greetings.test";

const firebase = fakeTokenVerifier();
const r2 = fakeObjectStorage();
const app = createApp({
	tokenVerifier: firebase.verifier,
	objectStorage: r2.storage,
	publicBaseUrl: CDN,
});
const api = client(app);
const auth = authHelper(api, firebase);

beforeEach(async () => {
	await truncateAll();
	await seedReference();
});

/** Completes onboarding, which every profile edit builds on. */
async function onboard(token: string, over: Record<string, unknown> = {}) {
	return api.put("/v1/me/profile", {
		token,
		body: { regionCode: "IN-MH", languages: ["hi"], ...over },
	});
}

async function publish(designerId: string, title = "Good morning") {
	const id = crypto.randomUUID();
	await testDb.insert(content).values({
		id,
		designerId,
		title,
		status: "published",
		primaryLanguage: "hi",
		primaryAssetKey: `content/${id}/pic.webp`,
		publishedAt: new Date(),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return id;
}

describe("the fields printed on a shared graphic", () => {
	test("round-trip through onboarding", async () => {
		const reader = await auth.signIn();

		const saved = await onboard(reader.token, {
			displayName: "Ashwath",
			designation: "Property Consultant",
			contactPhone: "+91 98765 43210",
		});
		expect(saved.status).toBe(200);

		const me = await api.get("/v1/me/profile", { token: reader.token });
		expect(me.body.displayName).toBe("Ashwath");
		expect(me.body.designation).toBe("Property Consultant");
		expect(me.body.contactPhone).toBe("+91 98765 43210");
		expect(me.body.onboarded).toBe(true);
	});

	test("contactPhone is not the identity phone, and two users may share one", async () => {
		const a = await auth.signIn();
		const b = await auth.signIn();

		// The office landline, on two people's business cards. `phone` is UNIQUE;
		// this column deliberately is not, which is the whole reason it exists.
		expect(
			(await onboard(a.token, { contactPhone: "+91 22 1234 5678" })).status,
		).toBe(200);
		expect(
			(await onboard(b.token, { contactPhone: "+91 22 1234 5678" })).status,
		).toBe(200);

		const meA = await api.get("/v1/me/profile", { token: a.token });
		const meB = await api.get("/v1/me/profile", { token: b.token });
		expect(meA.body.contactPhone).toBe("+91 22 1234 5678");
		expect(meB.body.contactPhone).toBe("+91 22 1234 5678");
		// The verified sign-in numbers stay distinct.
		expect(meA.body.phone).not.toBe(meB.body.phone);
	});

	test("PUT replaces: an omitted field is cleared, not preserved", async () => {
		const reader = await auth.signIn();
		await onboard(reader.token, { designation: "Consultant" });

		// Documented behaviour — the profile editor must submit the whole form.
		await onboard(reader.token, { displayName: "Ashwath" });

		const me = await api.get("/v1/me/profile", { token: reader.token });
		expect(me.body.designation).toBeNull();
		expect(me.body.displayName).toBe("Ashwath");
	});
});

describe("the logo", () => {
	test("sign, upload, confirm, then it appears on the profile", async () => {
		const reader = await auth.signIn();
		await onboard(reader.token);

		const signed = await api.post("/v1/me/avatar/upload-url", {
			token: reader.token,
			body: { mimeType: "image/png", bytes: 2048 },
		});
		expect(signed.status).toBe(200);
		expect(signed.body.storageKey).toStartWith(`avatars/${reader.userId}/`);

		r2.putObject(signed.body.storageKey, { contentType: "image/png" });

		const confirmed = await api.post("/v1/me/avatar", {
			token: reader.token,
			body: { storageKey: signed.body.storageKey },
		});
		expect(confirmed.status).toBe(200);
		expect(confirmed.body.avatarUrl).toBe(`${CDN}/${signed.body.storageKey}`);

		const me = await api.get("/v1/me/profile", { token: reader.token });
		expect(me.body.avatarKey).toBe(signed.body.storageKey);
		expect(me.body.avatarUrl).toBe(`${CDN}/${signed.body.storageKey}`);
	});

	test("a key belonging to another user is refused", async () => {
		const a = await auth.signIn();
		const b = await auth.signIn();

		const signed = await api.post("/v1/me/avatar/upload-url", {
			token: a.token,
			body: { mimeType: "image/png", bytes: 2048 },
		});
		r2.putObject(signed.body.storageKey, { contentType: "image/png" });

		// b tries to claim a's object. Without the prefix check this succeeds and
		// b's profile silently shows a's logo.
		const stolen = await api.post("/v1/me/avatar", {
			token: b.token,
			body: { storageKey: signed.body.storageKey },
		});
		expect(stolen.status).toBe(400);

		const [row] = await testDb
			.select({ avatarKey: userProfiles.avatarKey })
			.from(userProfiles)
			.where(eq(userProfiles.userId, b.userId));
		expect(row?.avatarKey ?? null).toBeNull();
	});

	test("confirming a key that was never uploaded is refused", async () => {
		const reader = await auth.signIn();
		const signed = await api.post("/v1/me/avatar/upload-url", {
			token: reader.token,
			body: { mimeType: "image/png", bytes: 2048 },
		});

		// Signed but never PUT. The server checks the store rather than believing
		// the request.
		const res = await api.post("/v1/me/avatar", {
			token: reader.token,
			body: { storageKey: signed.body.storageKey },
		});
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("No uploaded object");
	});

	test("rejects a non-image and an oversized file before signing", async () => {
		const reader = await auth.signIn();

		expect(
			(
				await api.post("/v1/me/avatar/upload-url", {
					token: reader.token,
					body: { mimeType: "application/pdf", bytes: 100 },
				})
			).status,
		).toBe(400);

		expect(
			(
				await api.post("/v1/me/avatar/upload-url", {
					token: reader.token,
					body: { mimeType: "image/png", bytes: 6 * 1024 * 1024 },
				})
			).status,
		).toBe(400);
	});

	test("replacing a logo uses a new key, so no CDN cache serves the old one", async () => {
		const reader = await auth.signIn();

		const first = await api.post("/v1/me/avatar/upload-url", {
			token: reader.token,
			body: { mimeType: "image/png", bytes: 1024 },
		});
		const second = await api.post("/v1/me/avatar/upload-url", {
			token: reader.token,
			body: { mimeType: "image/png", bytes: 1024 },
		});
		expect(second.body.storageKey).not.toBe(first.body.storageKey);
	});

	test("can be removed", async () => {
		const reader = await auth.signIn();
		await onboard(reader.token);

		const signed = await api.post("/v1/me/avatar/upload-url", {
			token: reader.token,
			body: { mimeType: "image/png", bytes: 1024 },
		});
		r2.putObject(signed.body.storageKey, { contentType: "image/png" });
		await api.post("/v1/me/avatar", {
			token: reader.token,
			body: { storageKey: signed.body.storageKey },
		});

		expect(
			(await api.delete("/v1/me/avatar", { token: reader.token })).status,
		).toBe(200);

		const me = await api.get("/v1/me/profile", { token: reader.token });
		expect(me.body.avatarUrl).toBeNull();
	});
});

describe("download history", () => {
	test("one entry per image, newest first, with a count", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		await onboard(reader.token);

		const older = await publish(designer.userId, "Older");
		const newer = await publish(designer.userId, "Newer");

		// Downloaded twice — history should show it once, saying "2".
		for (const key of ["a", "b"]) {
			await recordDownload({
				contentId: older,
				userId: reader.userId,
				source: "feed",
				idempotencyKey: `older-${key}`,
				storage: r2.storage,
				publicBaseUrl: CDN,
			});
		}
		await recordDownload({
			contentId: newer,
			userId: reader.userId,
			source: "feed",
			idempotencyKey: "newer-a",
			storage: r2.storage,
			publicBaseUrl: CDN,
		});

		const res = await api.get("/v1/me/downloads", { token: reader.token });
		expect(res.status).toBe(200);

		const items = res.body.items as {
			title: string;
			timesDownloaded: number;
			imageUrl: string;
		}[];
		expect(items).toHaveLength(2);
		expect(items[0]?.title).toBe("Newer");
		expect(items[1]?.title).toBe("Older");
		expect(items[1]?.timesDownloaded).toBe(2);
		expect(items[0]?.imageUrl).toStartWith(CDN);
	});

	test("shows only the caller's own downloads", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const a = await auth.signIn();
		const b = await auth.signIn();
		const id = await publish(designer.userId);

		await recordDownload({
			contentId: id,
			userId: a.userId,
			source: "detail",
			storage: r2.storage,
		});

		expect(
			(await api.get("/v1/me/downloads", { token: a.token })).body.items,
		).toHaveLength(1);
		expect(
			(await api.get("/v1/me/downloads", { token: b.token })).body.items,
		).toHaveLength(0);
	});

	test("pages without repeating or skipping", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();

		for (let i = 0; i < 5; i++) {
			const id = await publish(designer.userId, `Item ${i}`);
			await recordDownload({
				contentId: id,
				userId: reader.userId,
				source: "feed",
				idempotencyKey: `k-${i}`,
				storage: r2.storage,
			});
		}

		const seen: string[] = [];
		let cursor: string | null = null;

		for (let page = 0; page < 5; page++) {
			const url: string = cursor
				? `/v1/me/downloads?limit=2&cursor=${encodeURIComponent(cursor)}`
				: "/v1/me/downloads?limit=2";
			const res = await api.get(url, { token: reader.token });
			for (const item of res.body.items as { id: string }[]) seen.push(item.id);
			cursor = res.body.nextCursor as string | null;
			if (!cursor) break;
		}

		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);
	});

	test("requires a session", async () => {
		expect((await api.get("/v1/me/downloads")).status).toBe(401);
	});
});

describe("the customized flag", () => {
	test("records whether the image was personalised", async () => {
		const designer = await auth.signIn({ role: "designer" });
		const reader = await auth.signIn();
		const id = await publish(designer.userId);

		await api.post(`/v1/content/${id}/download`, {
			token: reader.token,
			body: { source: "feed", customized: true },
		});

		const [event] = await testDb
			.select({ customized: downloadEvents.customized })
			.from(downloadEvents);
		expect(event?.customized).toBe(true);
	});
});
