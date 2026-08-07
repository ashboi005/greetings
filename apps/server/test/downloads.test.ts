import { beforeEach, describe, expect, test } from "bun:test";
import {
	content,
	downloadEvents,
	downloadIdempotency,
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

let designerId: string;
let designerToken: string;
let adminToken: string;

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	r2.reset();
	await seedReference();

	const designer = await auth.signIn({ role: "designer" });
	designerId = designer.userId;
	designerToken = designer.token;
	adminToken = (await auth.signIn({ role: "admin" })).token;
});

async function publish(title = "Good Morning", language = "hi") {
	const created = await api.post("/v1/designer/content", {
		token: designerToken,
		body: { title, primaryLanguage: language },
	});
	const id = created.body.id as string;

	const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
		token: designerToken,
		body: { mimeType: "image/jpeg", bytes: 2048 },
	});
	r2.putObject(url.body.storageKey);
	await api.post(`/v1/designer/content/${id}/assets`, {
		token: designerToken,
		body: { storageKey: url.body.storageKey, width: 1080, height: 1920 },
	});
	await api.put(`/v1/designer/content/${id}/tags`, {
		token: designerToken,
		body: { tagIds: ["tag_good-morning"] },
	});
	await api.post(`/v1/designer/content/${id}/submit`, { token: designerToken });
	await api.post(`/v1/admin/content/${id}/approve`, { token: adminToken });

	return id;
}

async function reader(region = "IN-MH", languages = ["hi"]) {
	const session = await auth.signIn();
	await api.put("/v1/me/profile", {
		token: session.token,
		body: { regionCode: region, languages },
	});
	return session;
}

const download = (
	id: string,
	token: string,
	options: { key?: string; source?: string } = {},
) =>
	app
		.handle(
			new Request(`http://localhost/v1/content/${id}/download`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					...(options.key ? { "idempotency-key": options.key } : {}),
				},
				body: JSON.stringify(options.source ? { source: options.source } : {}),
			}),
		)
		.then(async (res) => ({
			status: res.status,
			body: JSON.parse((await res.text()) || "null"),
		}));

describe("recording a download", () => {
	test("returns a signed URL and records the event", async () => {
		const id = await publish();
		const user = await reader();

		const res = await download(id, user.token);

		expect(res.status).toBe(200);
		expect(res.body.url).toContain("method=GET");
		expect(res.body.expiresInSeconds).toBe(300);
		expect(res.body.recorded).toBe(true);

		const events = await testDb
			.select()
			.from(downloadEvents)
			.where(eq(downloadEvents.contentId, id));
		expect(events).toHaveLength(1);
	});

	test("attributes the download to the designer and the user's region", async () => {
		const id = await publish();
		const user = await reader("IN-TN", ["ta"]);

		await download(id, user.token, { source: "feed" });

		const [event] = await testDb
			.select()
			.from(downloadEvents)
			.where(eq(downloadEvents.contentId, id));

		expect(event?.designerId).toBe(designerId);
		expect(event?.userId).toBe(user.userId);
		// Denormalised at event time, so analytics stay correct if the user moves.
		expect(event?.regionCode).toBe("IN-TN");
		// The language of the content downloaded, not the user's preferences.
		expect(event?.languageCode).toBe("hi");
		expect(event?.source).toBe("feed");
	});

	test("increments the denormalised counter", async () => {
		const id = await publish();
		const a = await reader();
		const b = await reader();

		await download(id, a.token);
		await download(id, b.token);
		await download(id, a.token);

		const [row] = await testDb
			.select({ count: content.downloadCount })
			.from(content)
			.where(eq(content.id, id));
		expect(row?.count).toBe(3);
	});

	test("the counter matches the event count under concurrent downloads", async () => {
		const id = await publish();
		const users = await Promise.all(Array.from({ length: 10 }, () => reader()));

		// A read-modify-write counter would lose increments here.
		await Promise.all(users.map((u) => download(id, u.token)));

		const [row] = await testDb
			.select({ count: content.downloadCount })
			.from(content)
			.where(eq(content.id, id));
		const events = await testDb
			.select()
			.from(downloadEvents)
			.where(eq(downloadEvents.contentId, id));

		expect(events).toHaveLength(10);
		expect(row?.count).toBe(10);
	});

	test("records a region of null for a user who has not onboarded", async () => {
		const id = await publish();
		const session = await auth.signIn();

		const res = await download(id, session.token);
		expect(res.status).toBe(200);

		const [event] = await testDb
			.select()
			.from(downloadEvents)
			.where(eq(downloadEvents.contentId, id));
		expect(event?.regionCode).toBeNull();
	});

	test("defaults the source to detail", async () => {
		const id = await publish();
		const user = await reader();
		await download(id, user.token);

		const [event] = await testDb
			.select()
			.from(downloadEvents)
			.where(eq(downloadEvents.contentId, id));
		expect(event?.source).toBe("detail");
	});
});

describe("availability", () => {
	test("refuses content that is not published", async () => {
		const created = await api.post("/v1/designer/content", {
			token: designerToken,
			body: { title: "A draft", primaryLanguage: "hi" },
		});
		const user = await reader();

		const res = await download(created.body.id, user.token);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("CONFLICT");
	});

	test("refuses content that has been removed", async () => {
		const id = await publish();
		await api.post(`/v1/admin/content/${id}/remove`, {
			token: adminToken,
			body: { reason: "Copyright" },
		});
		const user = await reader();

		const res = await download(id, user.token);
		expect(res.status).toBe(409);
		expect(await countEvents(id)).toBe(0);
	});

	test("refuses content under a visibility hold", async () => {
		const id = await publish();
		await testDb
			.update(content)
			.set({ visibilityHold: true })
			.where(eq(content.id, id));
		const user = await reader();

		const res = await download(id, user.token);
		expect(res.status).toBe(409);
	});

	test("404s for content that does not exist", async () => {
		const user = await reader();
		const res = await download("no-such-id", user.token);
		expect(res.status).toBe(404);
	});

	test("requires authentication", async () => {
		const id = await publish();
		const res = await app.handle(
			new Request(`http://localhost/v1/content/${id}/download`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(401);
		await res.text();
	});
});

describe("idempotency", () => {
	test("a retry with the same key returns the same URL and counts once", async () => {
		const id = await publish();
		const user = await reader();

		const first = await download(id, user.token, { key: "retry-1" });
		const second = await download(id, user.token, { key: "retry-1" });

		expect(first.body.recorded).toBe(true);
		expect(second.body.recorded).toBe(false);
		expect(second.body.url).toBe(first.body.url);

		expect(await countEvents(id)).toBe(1);
		expect(await counterFor(id)).toBe(1);
	});

	test("different keys from the same user each count", async () => {
		const id = await publish();
		const user = await reader();

		await download(id, user.token, { key: "a" });
		await download(id, user.token, { key: "b" });

		expect(await countEvents(id)).toBe(2);
	});

	test("the same key from different users does not collide", async () => {
		const id = await publish();
		const a = await reader();
		const b = await reader();

		// Clients pick their own keys, so collisions across users are expected.
		const first = await download(id, a.token, { key: "shared-key" });
		const second = await download(id, b.token, { key: "shared-key" });

		expect(first.body.recorded).toBe(true);
		expect(second.body.recorded).toBe(true);
		expect(await countEvents(id)).toBe(2);
	});

	test("concurrent retries of one key record exactly one download", async () => {
		const id = await publish();
		const user = await reader();

		// The real failure mode: a flaky connection fires the same request
		// several times before any response arrives.
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				download(id, user.token, { key: "concurrent" }),
			),
		);

		expect(results.every((r) => r.status === 200)).toBe(true);
		expect(results.filter((r) => r.body.recorded)).toHaveLength(1);
		expect(await countEvents(id)).toBe(1);
		expect(await counterFor(id)).toBe(1);
	});

	test("a key reused after the window counts as a new download", async () => {
		const id = await publish();
		const user = await reader();

		await download(id, user.token, { key: "aged" });

		// Age the stored claim past the replay window. A retry is a retry for a
		// minute; the same key an hour later is a genuine second download, and
		// refusing to count it would undercount the designer.
		await testDb
			.update(downloadIdempotency)
			.set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) })
			.where(eq(downloadIdempotency.userId, user.userId));

		const second = await download(id, user.token, { key: "aged" });

		expect(second.body.recorded).toBe(true);
		expect(await countEvents(id)).toBe(2);
		expect(await counterFor(id)).toBe(2);
	});

	test("without a key, every request counts", async () => {
		const id = await publish();
		const user = await reader();

		await download(id, user.token);
		await download(id, user.token);

		expect(await countEvents(id)).toBe(2);
	});
});

async function countEvents(contentId: string) {
	const rows = await testDb
		.select()
		.from(downloadEvents)
		.where(eq(downloadEvents.contentId, contentId));
	return rows.length;
}

async function counterFor(contentId: string) {
	const [row] = await testDb
		.select({ count: content.downloadCount })
		.from(content)
		.where(eq(content.id, contentId));
	return row?.count;
}
