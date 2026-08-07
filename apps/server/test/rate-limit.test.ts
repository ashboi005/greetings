import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../src/lib/errors";
import {
	clientIp,
	consume,
	createMemoryStore,
	defaultStore,
} from "../src/lib/rate-limit";

describe("the limiter", () => {
	test("allows requests up to the limit and refuses the next", () => {
		const store = createMemoryStore();
		const options = { limit: 3, windowSeconds: 60, store };

		for (let i = 0; i < 3; i++) {
			expect(() => consume("k", options)).not.toThrow();
		}
		expect(() => consume("k", options)).toThrow(AppError);
	});

	test("refuses with 429 and says how long to wait", () => {
		const store = createMemoryStore();
		const options = { limit: 1, windowSeconds: 60, store };

		consume("k", options);
		try {
			consume("k", options);
			throw new Error("should have thrown");
		} catch (err) {
			const appError = err as AppError;
			expect(appError.code).toBe("RATE_LIMITED");
			// A client developer needs to tell a bug from a deliberate throttle.
			expect(appError.message).toContain("1 per 60 seconds");
			expect(
				(appError.details as { retryAfterSeconds: number }).retryAfterSeconds,
			).toBeGreaterThan(0);
		}
	});

	test("counts each key separately", () => {
		const store = createMemoryStore();
		const options = { limit: 1, windowSeconds: 60, store };

		consume("user-a", options);
		// One user exhausting their quota must not affect anyone else.
		expect(() => consume("user-b", options)).not.toThrow();
	});

	test("the window expires", async () => {
		const store = createMemoryStore();
		const options = { limit: 1, windowSeconds: 1, store };

		consume("k", options);
		expect(() => consume("k", options)).toThrow();

		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(() => consume("k", options)).not.toThrow();
	});
});

describe("clientIp", () => {
	const withHeaders = (headers: Record<string, string>) =>
		new Request("http://localhost/", { headers });

	test("prefers the first x-forwarded-for entry", () => {
		expect(
			clientIp(withHeaders({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })),
		).toBe("203.0.113.7");
	});

	test("falls back to Cloudflare's header", () => {
		expect(clientIp(withHeaders({ "cf-connecting-ip": "203.0.113.9" }))).toBe(
			"203.0.113.9",
		);
	});

	test("returns the fallback when nothing identifies the client", () => {
		expect(clientIp(withHeaders({}))).toBe("unknown");
	});
});

describe("endpoint limits", () => {
	// These exercise the real routes, which use the process-wide store. Other
	// test files sign users in through the same limiter, so this must leave the
	// store as it found it — and use an address range the auth helper never
	// generates. Without both, exhausting a quota here fails unrelated files.
	beforeEach(() => {
		defaultStore.clear();
	});
	afterEach(() => {
		defaultStore.clear();
	});

	test("sign-in is throttled per address, but generously", async () => {
		const { createApp } = await import("../src/app");
		const { fakeTokenVerifier } = await import("./fakes");
		const { fakeObjectStorage } = await import("./fakes");

		const firebase = fakeTokenVerifier();
		const app = createApp({
			tokenVerifier: firebase.verifier,
			objectStorage: fakeObjectStorage().storage,
		});

		const attempt = () =>
			app
				.handle(
					new Request("http://localhost/v1/auth/firebase", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-forwarded-for": "203.0.113.4",
						},
						body: JSON.stringify({ idToken: "unregistered" }),
					}),
				)
				.then(async (res) => {
					await res.text();
					return res.status;
				});

		// 600/minute: high enough that a carrier-NAT'd network of real users is
		// never locked out, low enough to stop one client burning CPU on token
		// verification indefinitely. Unregistered tokens 401 until it trips.
		const statuses: number[] = [];
		for (let i = 0; i < 602; i++) statuses.push(await attempt());

		expect(statuses.slice(0, 600).every((s) => s === 401)).toBe(true);
		expect(statuses.at(-1)).toBe(429);
	});

	test("a different address has its own quota", async () => {
		const { createApp } = await import("../src/app");
		const { fakeObjectStorage, fakeTokenVerifier } = await import("./fakes");

		const app = createApp({
			tokenVerifier: fakeTokenVerifier().verifier,
			objectStorage: fakeObjectStorage().storage,
		});

		const attempt = (ip: string) =>
			app
				.handle(
					new Request("http://localhost/v1/auth/firebase", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-forwarded-for": ip,
						},
						body: JSON.stringify({ idToken: "unregistered" }),
					}),
				)
				.then(async (res) => {
					await res.text();
					return res.status;
				});

		// One network exhausting its quota must not lock out another.
		for (let i = 0; i < 601; i++) await attempt("203.0.113.10");
		expect(await attempt("203.0.113.10")).toBe(429);
		expect(await attempt("203.0.113.11")).toBe(401);
	});
});
