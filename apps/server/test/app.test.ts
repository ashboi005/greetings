import { beforeAll, describe, expect, test } from "bun:test";
import { user } from "@greetings/db/schema/auth";
import { createApp } from "../src/app";
import { AppError, notFound } from "../src/lib/errors";
import { testDb, truncateAll } from "./db";

// Routes appended after createApp() still sit behind its onError handler, which
// is what lets these exercise the real error pipeline rather than a stand-in.
const app = createApp()
	.get("/__test/app-error", () => {
		throw notFound("No such content");
	})
	.get("/__test/app-error-details", () => {
		throw new AppError("CONFLICT", "Content is not in draft", {
			status: "published",
		});
	})
	.get("/__test/unexpected", () => {
		throw new Error("connection postgres://user:hunter2@db.internal failed");
	});

const get = (path: string) =>
	app.handle(new Request(`http://localhost${path}`));

describe("health", () => {
	test("GET /health reports liveness without touching dependencies", async () => {
		const res = await get("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: "ok",
			service: "greetings-server",
		});
	});

	test("GET /health/ready reports readiness when the database is reachable", async () => {
		const res = await get("/health/ready");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ready", database: "up" });
	});
});

describe("error envelope", () => {
	test("an AppError maps to its status and the documented shape", async () => {
		const res = await get("/__test/app-error");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			error: { code: "NOT_FOUND", message: "No such content" },
		});
	});

	test("details survive when supplied", async () => {
		const res = await get("/__test/app-error-details");
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: {
				code: "CONFLICT",
				message: "Content is not in draft",
				details: { status: "published" },
			},
		});
	});

	test("an unexpected error becomes a generic 500 that leaks nothing", async () => {
		const res = await get("/__test/unexpected");
		expect(res.status).toBe(500);

		const body = await res.text();
		expect(JSON.parse(body)).toEqual({
			error: { code: "INTERNAL", message: "Internal server error" },
		});
		expect(body).not.toContain("hunter2");
		expect(body).not.toContain("db.internal");
	});

	test("an unknown route returns the envelope rather than Elysia's default body", async () => {
		const res = await get("/no/such/route");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			error: { code: "NOT_FOUND", message: "Not found" },
		});
	});
});

describe("openapi document", () => {
	test("serves the reference UI at /docs", async () => {
		const res = await get("/docs");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});

	test("documents the health routes and omits the Better Auth catch-all", async () => {
		const res = await get("/docs/json");
		expect(res.status).toBe(200);

		const doc = (await res.json()) as {
			info: { title: string };
			paths: Record<string, unknown>;
		};
		expect(doc.info.title).toBe("Greetings API");
		expect(Object.keys(doc.paths)).toContain("/health");
		expect(
			Object.keys(doc.paths).filter((p) => p.startsWith("/api/auth")),
		).toEqual([]);
	});
});

describe("test harness", () => {
	beforeAll(async () => {
		await truncateAll();
	});

	test("truncateAll clears application tables", async () => {
		await testDb.insert(user).values({
			id: "harness-check",
			name: "Harness",
			email: "harness@example.com",
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		expect(await testDb.select().from(user)).toHaveLength(1);

		await truncateAll();
		expect(await testDb.select().from(user)).toHaveLength(0);
	});

	test("the suite is pointed at the test database, never dev", () => {
		expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
		expect(process.env.DATABASE_URL).toMatch(/_test$/);
	});
});
