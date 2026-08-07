/**
 * Shared helpers for the integration suite.
 */

import type { UserRole } from "@greetings/db/schema";
import { languages, regions, user as userTable } from "@greetings/db/schema";
import { LANGUAGE_SEED, REGION_SEED } from "@greetings/db/seed/reference";
import { eq } from "drizzle-orm";
import { testDb } from "./db";

/** Reference data every test that touches profiles needs present. */
export async function seedReference(): Promise<void> {
	await testDb
		.insert(regions)
		.values([...REGION_SEED])
		.onConflictDoNothing();
	await testDb
		.insert(languages)
		.values([...LANGUAGE_SEED])
		.onConflictDoNothing();
}

/** Forces a user's role, bypassing the API — for arranging test preconditions. */
export async function setRole(userId: string, role: UserRole): Promise<void> {
	await testDb
		.update(userTable)
		.set({ role, updatedAt: new Date() })
		.where(eq(userTable.id, userId));
}

export function bearer(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

/**
 * Response bodies are asserted structurally, and each endpoint returns a
 * different shape. A permissive type keeps assertions readable instead of
 * demanding a cast on every line of every test.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate test ergonomics
export type TestBody = any;

export interface TestResponse {
	status: number;
	body: TestBody;
	raw: string;
}

/** Issues requests against a mounted app with optional auth. */
export function client(app: { handle(req: Request): Promise<Response> }) {
	const call = async (
		method: string,
		path: string,
		options: { token?: string; body?: unknown } = {},
	) => {
		const headers: Record<string, string> = {};
		if (options.token) Object.assign(headers, bearer(options.token));
		if (options.body !== undefined)
			headers["content-type"] = "application/json";

		const res = await app.handle(
			new Request(`http://localhost${path}`, {
				method,
				headers,
				body:
					options.body === undefined ? undefined : JSON.stringify(options.body),
			}),
		);

		// Every endpoint returns JSON; reading it here keeps assertions terse and
		// avoids leaving response bodies unconsumed.
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = text;
		}

		return { status: res.status, body: json as TestBody, raw: text };
	};

	return {
		get: (path: string, opts?: { token?: string }) => call("GET", path, opts),
		post: (path: string, opts?: { token?: string; body?: unknown }) =>
			call("POST", path, opts),
		put: (path: string, opts?: { token?: string; body?: unknown }) =>
			call("PUT", path, opts),
		delete: (path: string, opts?: { token?: string }) =>
			call("DELETE", path, opts),
	};
}
