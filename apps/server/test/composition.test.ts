/**
 * Guards the composed shape used in production.
 *
 * app.test.ts drives `createApp()` directly, which misses anything that only
 * breaks once the app is mounted inside an outer instance. A 404 on an
 * unmatched route is handled by the *outermost* Elysia instance, so that path
 * escaped the envelope until the error handler was mounted at both levels.
 *
 * This mirrors index.ts's topology without importing it — index.ts pulls in
 * `evlog/elysia`, whose module-scope AsyncLocalStorage breaks Bun's test
 * runner, and it also calls .listen().
 */

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createApp } from "../src/app";
import { errorHandler } from "../src/lib/error-plugin";

const composed = new Elysia().use(errorHandler).use(createApp());

const get = (path: string) =>
	composed.handle(new Request(`http://localhost${path}`));

describe("composed application", () => {
	test("serves routes from the mounted app", async () => {
		const res = await get("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: "ok",
			service: "greetings-server",
		});
	});

	test("an unmatched route still returns the envelope, not Elysia's default body", async () => {
		const res = await get("/no/such/route");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			error: { code: "NOT_FOUND", message: "Not found" },
		});
	});

	test("the docs endpoint survives mounting", async () => {
		const res = await get("/docs");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});
});
