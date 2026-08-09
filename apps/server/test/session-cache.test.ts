/**
 * The session cache (spec §12.6).
 *
 * This trades a bounded amount of staleness for roughly half the database round
 * trips in the whole API, so the bound is the thing worth testing: what it
 * caches, what it refuses to cache, and every path that must invalidate it.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import {
	bearerToken,
	cacheSize,
	invalidateAll,
	invalidateUser,
	readCachedSession,
	SESSION_CACHE_MAX,
	SESSION_CACHE_TTL_MS,
	writeCachedSession,
} from "../src/lib/session-cache";
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

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	r2.reset();
	invalidateAll();
	await seedReference();
});

const session = (
	overrides: Partial<Parameters<typeof writeCachedSession>[1]> = {},
) => ({
	userId: "u1",
	email: "a@example.com",
	name: "A",
	role: "user" as const,
	expiresAt: Date.now() + 3_600_000,
	...overrides,
});

describe("the cache itself", () => {
	test("returns undefined for a key it has never seen", () => {
		expect(readCachedSession("nope")).toBeUndefined();
	});

	test("returns the value inside the TTL and forgets it after", () => {
		const now = Date.now();
		writeCachedSession("t", session(), now);

		expect(
			readCachedSession("t", now + SESSION_CACHE_TTL_MS - 1),
		).not.toBeNull();
		// Undefined, not null: a miss and a cached negative are different answers.
		expect(
			readCachedSession("t", now + SESSION_CACHE_TTL_MS + 1),
		).toBeUndefined();
	});

	test("never outlives the session's own expiry", () => {
		const now = Date.now();
		// A session with one second left, cached for thirty.
		writeCachedSession("t", session({ expiresAt: now + 1000 }), now);

		expect(readCachedSession("t", now + 500)).not.toBeNull();
		// The cache may shorten a lifetime. It must never extend one.
		expect(readCachedSession("t", now + 1500)).toBeUndefined();
	});

	test("caches a negative answer, briefly", () => {
		const now = Date.now();
		writeCachedSession("bad", null, now);

		// Null, not undefined: "we asked, and this token is not valid".
		expect(readCachedSession("bad", now + 500)).toBeNull();
		expect(readCachedSession("bad", now + 5_000)).toBeUndefined();
	});

	test("is bounded, so attacker-supplied tokens cannot exhaust memory", () => {
		for (let i = 0; i < SESSION_CACHE_MAX + 200; i++) {
			writeCachedSession(`tok-${i}`, session({ userId: `u${i}` }));
		}
		expect(cacheSize()).toBeLessThanOrEqual(SESSION_CACHE_MAX);
	});

	test("forgets one user without disturbing others", () => {
		writeCachedSession("a", session({ userId: "u1" }));
		writeCachedSession("b", session({ userId: "u2" }));

		invalidateUser("u1");

		expect(readCachedSession("a")).toBeUndefined();
		expect(readCachedSession("b")).not.toBeUndefined();
	});
});

describe("what counts as a bearer token", () => {
	const headers = (value?: string) =>
		new Headers(value ? { authorization: value } : {});

	test("reads one", () => {
		expect(bearerToken(headers("Bearer abc"))).toBe("abc");
	});

	test("ignores anything else", () => {
		expect(bearerToken(headers())).toBeNull();
		expect(bearerToken(headers("Basic abc"))).toBeNull();
		expect(bearerToken(headers("Bearer "))).toBeNull();
		// Not a bearer scheme, so not ours to cache.
		expect(bearerToken(headers("bearer abc"))).toBeNull();
	});
});

describe("through the API", () => {
	test("a second request does not re-resolve the session", async () => {
		const user = await auth.signIn();

		await api.get("/v1/auth/me", { token: user.token });
		const size = cacheSize();
		await api.get("/v1/auth/me", { token: user.token });

		// Same entry reused rather than a second one written.
		expect(cacheSize()).toBe(size);
		expect(readCachedSession(user.token)).not.toBeUndefined();
	});

	test("still answers correctly from the cache", async () => {
		const user = await auth.signIn({ role: "designer" });

		const first = await api.get("/v1/auth/me", { token: user.token });
		const second = await api.get("/v1/auth/me", { token: user.token });

		expect(second.status).toBe(200);
		expect(second.body).toEqual(first.body);
		expect(second.body.role).toBe("designer");
	});

	test("a role change takes effect immediately, not after the TTL", async () => {
		const superAdmin = await auth.signIn({ role: "super_admin" });
		const target = await auth.signIn({ email: "demote@example.com" });

		await api.post("/v1/admin/roles/assign", {
			token: superAdmin.token,
			body: { email: "demote@example.com", role: "designer" },
		});
		const promoted = await auth.reSignIn(target.identity);

		// Warm the cache at the elevated role.
		expect(
			(await api.get("/v1/designer/content", { token: promoted.token })).status,
		).toBe(200);

		await api.post("/v1/admin/roles/assign", {
			token: superAdmin.token,
			body: { email: "demote@example.com", role: "user" },
		});

		// The window this closes is the entire point: a demotion that took
		// thirty seconds to bite is a demotion that did not work.
		const after = await api.get("/v1/designer/content", {
			token: promoted.token,
		});
		expect(after.status).toBe(401);
	});

	test("signing out takes effect immediately", async () => {
		const user = await auth.signIn();
		expect((await api.get("/v1/auth/me", { token: user.token })).status).toBe(
			200,
		);

		const signedOut = await app.handle(
			new Request("http://localhost/api/auth/sign-out", {
				method: "POST",
				headers: {
					authorization: `Bearer ${user.token}`,
					"content-type": "application/json",
				},
				body: "{}",
			}),
		);
		await signedOut.text();

		// A cached entry outliving a sign-out would mean "log me out" did not.
		const after = await api.get("/v1/auth/me", { token: user.token });
		expect(after.status).toBe(401);
	});

	test("one user's cached session is never served to another", async () => {
		const a = await auth.signIn();
		const b = await auth.signIn();

		const first = await api.get("/v1/auth/me", { token: a.token });
		const second = await api.get("/v1/auth/me", { token: b.token });

		expect(first.body.id).toBe(a.userId);
		expect(second.body.id).toBe(b.userId);
		expect(first.body.id).not.toBe(second.body.id);
	});

	test("a made-up token is still refused", async () => {
		const res = await api.get("/v1/auth/me", { token: "not-a-real-token" });
		expect(res.status).toBe(401);
		// And again, now that the negative is cached.
		expect(
			(await api.get("/v1/auth/me", { token: "not-a-real-token" })).status,
		).toBe(401);
	});
});
