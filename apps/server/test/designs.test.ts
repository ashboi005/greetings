/**
 * My Designs (spec §16).
 *
 * The risk in a private-per-user resource is never the happy path — it is
 * whether "private" holds. Most of what follows is one user reaching for
 * another's design, by every route that takes an id.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { userDesigns } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { MAX_DESIGN_JSON_BYTES } from "../src/modules/designs/routes";
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

const SCENE = {
	version: 1,
	elements: [{ type: "text", value: "Happy Diwali", x: 0.1, y: 0.8 }],
};

beforeEach(async () => {
	await truncateAll();
	await seedReference();
});

async function createDesign(token: string, title = "My poster") {
	const res = await api.post("/v1/me/designs", {
		token,
		body: { title, designJson: SCENE },
	});
	return res;
}

describe("creating and editing", () => {
	test("a design round-trips, scene graph intact", async () => {
		const user = await auth.signIn();

		const created = await createDesign(user.token);
		expect(created.status).toBe(200);
		expect(created.body.title).toBe("My poster");
		// Stored verbatim: the server never interprets this.
		expect(created.body.designJson).toEqual(SCENE);
		expect(created.body.previewUrl).toBeNull();

		const fetched = await api.get(`/v1/me/designs/${created.body.id}`, {
			token: user.token,
		});
		expect(fetched.body.designJson).toEqual(SCENE);
	});

	test("editing saves the new scene and leaves the title alone", async () => {
		const user = await auth.signIn();
		const created = await createDesign(user.token);

		const next = { version: 1, elements: [{ type: "text", value: "Edited" }] };
		const patched = await api.patch(`/v1/me/designs/${created.body.id}`, {
			token: user.token,
			body: { designJson: next },
		});

		expect(patched.status).toBe(200);
		expect(patched.body.designJson).toEqual(next);
		// A PATCH, unlike the profile PUT: an omitted field is untouched.
		expect(patched.body.title).toBe("My poster");
	});

	test("a PATCH with nothing to change is refused", async () => {
		const user = await auth.signIn();
		const created = await createDesign(user.token);

		const res = await api.patch(`/v1/me/designs/${created.body.id}`, {
			token: user.token,
			body: {},
		});
		expect(res.status).toBe(400);
	});

	test("an oversized scene graph is refused rather than stored", async () => {
		const user = await auth.signIn();

		const huge = {
			blob: "x".repeat(MAX_DESIGN_JSON_BYTES + 1024),
		};
		const res = await api.post("/v1/me/designs", {
			token: user.token,
			body: { title: "Too big", designJson: huge },
		});

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("limit is");
		expect(await testDb.select().from(userDesigns)).toHaveLength(0);
	});

	test("the gallery lists newest-edited first and omits scene graphs", async () => {
		const user = await auth.signIn();
		await createDesign(user.token, "First");
		const second = await createDesign(user.token, "Second");

		// Touch the first one so it becomes the most recently edited.
		const first = await api.get("/v1/me/designs", { token: user.token });
		const oldest = (first.body.items as { id: string }[]).at(-1);
		await api.patch(`/v1/me/designs/${oldest?.id}`, {
			token: user.token,
			body: { title: "First, edited" },
		});

		const list = await api.get("/v1/me/designs", { token: user.token });
		const items = list.body.items as { title: string; designJson?: unknown }[];
		expect(items[0]?.title).toBe("First, edited");
		expect(items[1]?.title).toBe("Second");
		// Summaries only — a gallery of fifty must not be fifty scene graphs.
		expect(items[0]).not.toHaveProperty("designJson");
		expect(second.status).toBe(200);
	});

	test("pages without repeating or skipping", async () => {
		const user = await auth.signIn();
		for (let i = 0; i < 5; i++) await createDesign(user.token, `D${i}`);

		const seen: string[] = [];
		let cursor: string | null = null;

		for (let page = 0; page < 5; page++) {
			const url: string = cursor
				? `/v1/me/designs?limit=2&cursor=${encodeURIComponent(cursor)}`
				: "/v1/me/designs?limit=2";
			const res = await api.get(url, { token: user.token });
			for (const item of res.body.items as { id: string }[]) seen.push(item.id);
			cursor = res.body.nextCursor as string | null;
			if (!cursor) break;
		}

		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);
	});
});

describe("privacy", () => {
	test("another user's design is a 404 on every route that takes an id", async () => {
		const owner = await auth.signIn();
		const stranger = await auth.signIn();
		const created = await createDesign(owner.token);
		const id = created.body.id as string;

		// 404 rather than 403 throughout: confirming the id exists would leak
		// something a stranger has no business knowing.
		expect(
			(await api.get(`/v1/me/designs/${id}`, { token: stranger.token })).status,
		).toBe(404);
		expect(
			(
				await api.patch(`/v1/me/designs/${id}`, {
					token: stranger.token,
					body: { title: "Mine now" },
				})
			).status,
		).toBe(404);
		expect(
			(
				await api.post(`/v1/me/designs/${id}/upload-url`, {
					token: stranger.token,
					body: { purpose: "source", mimeType: "image/png", bytes: 1024 },
				})
			).status,
		).toBe(404);
		expect(
			(
				await api.post(`/v1/me/designs/${id}/assets`, {
					token: stranger.token,
					body: { purpose: "source", storageKey: `designs/${id}/x.png` },
				})
			).status,
		).toBe(404);

		// And nothing was changed by any of it.
		const [row] = await testDb
			.select()
			.from(userDesigns)
			.where(eq(userDesigns.id, id));
		expect(row?.title).toBe("My poster");
	});

	test("the gallery shows only the caller's own", async () => {
		const a = await auth.signIn();
		const b = await auth.signIn();
		await createDesign(a.token, "A's");

		expect(
			(await api.get("/v1/me/designs", { token: b.token })).body.items,
		).toHaveLength(0);
		expect(
			(await api.get("/v1/me/designs", { token: a.token })).body.items,
		).toHaveLength(1);
	});

	test("requires a session", async () => {
		expect((await api.get("/v1/me/designs")).status).toBe(401);
		expect(
			(await api.post("/v1/me/designs", { body: { designJson: {} } })).status,
		).toBe(401);
	});
});

describe("images", () => {
	test("source and preview attach independently", async () => {
		const user = await auth.signIn();
		const created = await createDesign(user.token);
		const id = created.body.id as string;

		for (const purpose of ["source", "preview"] as const) {
			const signed = await api.post(`/v1/me/designs/${id}/upload-url`, {
				token: user.token,
				body: { purpose, mimeType: "image/png", bytes: 4096 },
			});
			expect(signed.body.storageKey).toStartWith(`designs/${id}/`);
			r2.putObject(signed.body.storageKey, { contentType: "image/png" });

			const confirmed = await api.post(`/v1/me/designs/${id}/assets`, {
				token: user.token,
				body: { purpose, storageKey: signed.body.storageKey },
			});
			expect(confirmed.status).toBe(200);
		}

		const fetched = await api.get(`/v1/me/designs/${id}`, {
			token: user.token,
		});
		expect(fetched.body.sourceImageUrl).toStartWith(`${CDN}/designs/${id}/`);
		expect(fetched.body.previewUrl).toStartWith(`${CDN}/designs/${id}/`);
		expect(fetched.body.sourceImageUrl).not.toBe(fetched.body.previewUrl);
	});

	test("a key from another design is refused", async () => {
		const user = await auth.signIn();
		const a = await createDesign(user.token, "A");
		const b = await createDesign(user.token, "B");

		const signed = await api.post(`/v1/me/designs/${a.body.id}/upload-url`, {
			token: user.token,
			body: { purpose: "source", mimeType: "image/png", bytes: 1024 },
		});
		r2.putObject(signed.body.storageKey, { contentType: "image/png" });

		// Same owner, wrong design. The prefix check is per design, not per user.
		const res = await api.post(`/v1/me/designs/${b.body.id}/assets`, {
			token: user.token,
			body: { purpose: "source", storageKey: signed.body.storageKey },
		});
		expect(res.status).toBe(400);
	});

	test("confirming an object that was never uploaded is refused", async () => {
		const user = await auth.signIn();
		const created = await createDesign(user.token);
		const id = created.body.id as string;

		const signed = await api.post(`/v1/me/designs/${id}/upload-url`, {
			token: user.token,
			body: { purpose: "preview", mimeType: "image/png", bytes: 1024 },
		});

		const res = await api.post(`/v1/me/designs/${id}/assets`, {
			token: user.token,
			body: { purpose: "preview", storageKey: signed.body.storageKey },
		});
		expect(res.status).toBe(400);
	});

	test("replacing the preview points the gallery at the new render", async () => {
		const user = await auth.signIn();
		const created = await createDesign(user.token);
		const id = created.body.id as string;

		const keys: string[] = [];
		for (let i = 0; i < 2; i++) {
			const signed = await api.post(`/v1/me/designs/${id}/upload-url`, {
				token: user.token,
				body: { purpose: "preview", mimeType: "image/png", bytes: 1024 },
			});
			r2.putObject(signed.body.storageKey, { contentType: "image/png" });
			await api.post(`/v1/me/designs/${id}/assets`, {
				token: user.token,
				body: { purpose: "preview", storageKey: signed.body.storageKey },
			});
			keys.push(signed.body.storageKey);
		}

		expect(keys[0]).not.toBe(keys[1]);
		const list = await api.get("/v1/me/designs", { token: user.token });
		expect((list.body.items as { previewUrl: string }[])[0]?.previewUrl).toBe(
			`${CDN}/${keys[1]}`,
		);
	});
});

describe("designs are not content", () => {
	test("a design never appears in the public feed", async () => {
		const user = await auth.signIn();
		await createDesign(user.token, "Private poster");

		const feed = await api.get("/v1/feed", { token: user.token });
		const titles = (feed.body.items as { title: string }[]).map((i) => i.title);
		expect(titles).not.toContain("Private poster");

		const search = await api.get("/v1/search?q=Private", { token: user.token });
		expect(search.body.items).toHaveLength(0);
	});
});
