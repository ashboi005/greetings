/**
 * Shared helpers for the integration suite.
 */

import type { UserRole } from "@greetings/db/schema";
import {
	languages,
	regions,
	tags,
	user as userTable,
} from "@greetings/db/schema";
import { LANGUAGE_SEED, REGION_SEED } from "@greetings/db/seed/reference";
import { TAG_SEED } from "@greetings/db/seed/tags";
import { eq } from "drizzle-orm";
import { testDb } from "./db";

/** Reference data every test that touches profiles or content needs present. */
export async function seedReference(): Promise<void> {
	await testDb
		.insert(regions)
		.values([...REGION_SEED])
		.onConflictDoNothing();
	await testDb
		.insert(languages)
		.values([...LANGUAGE_SEED])
		.onConflictDoNothing();
	await testDb
		.insert(tags)
		.values(
			TAG_SEED.map((tag) => ({
				// Same id scheme as the real seed, so tests can name a tag
				// directly (`tag_diwali`) instead of looking it up.
				id: `tag_${tag.slug}`,
				slug: tag.slug,
				label: tag.label,
				category: tag.category,
			})),
		)
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

/**
 * Signs users in at a chosen role.
 *
 * Roles are carried in the session payload, so forcing a role in the database
 * does not change a session already issued. Arranging a privileged caller
 * therefore means: sign in, set the role, then sign in again with the same
 * Firebase subject to pick up a session that carries it. Encapsulated here so
 * every test does it the same way.
 */
export function authHelper(
	api: ReturnType<typeof client>,
	firebase: {
		register(token: string, identity?: Record<string, unknown>): string;
	},
) {
	let seq = 0;

	return {
		async signIn(
			options: {
				role?: UserRole;
				email?: string;
				emailVerified?: boolean;
				phone?: string;
			} = {},
		) {
			const n = ++seq;
			const identity = {
				subject: `uid-${n}`,
				phone: options.phone ?? `+9198765${String(n).padStart(5, "0")}`,
				email: options.email,
				emailVerified: options.emailVerified ?? Boolean(options.email),
			};

			firebase.register(`tok-${n}a`, identity);
			// A distinct address per user, as real clients have. Sign-in is
			// rate-limited per IP, and funnelling the whole suite through one
			// address would make tests fail for reasons no user would hit.
			let res = await api.post("/v1/auth/firebase", {
				body: { idToken: `tok-${n}a` },
				ip: `198.51.100.${n % 250}`,
			});

			const userId = res.body.user.id as string;

			if (options.role && options.role !== "user") {
				await setRole(userId, options.role);
				// Same subject, so this resolves to the same user — but the new
				// session carries the updated role.
				firebase.register(`tok-${n}b`, identity);
				res = await api.post("/v1/auth/firebase", {
					body: { idToken: `tok-${n}b` },
					ip: `198.51.100.${n % 250}`,
				});
			}

			return {
				token: res.body.token as string,
				userId,
				email: res.body.user.email as string,
				role: res.body.user.role as UserRole,
				identity,
			};
		},

		/** Re-issues a session for an existing subject, picking up role changes. */
		async reSignIn(identity: Record<string, unknown>) {
			const token = `re-${++seq}`;
			firebase.register(token, identity);
			const res = await api.post("/v1/auth/firebase", {
				body: { idToken: token },
				ip: `198.51.100.${seq % 250}`,
			});
			return res.body as { token: string; user: { role: UserRole } };
		},
	};
}

/** Issues requests against a mounted app with optional auth. */
export function client(app: { handle(req: Request): Promise<Response> }) {
	const call = async (
		method: string,
		path: string,
		options: { token?: string; body?: unknown; ip?: string } = {},
	) => {
		const headers: Record<string, string> = {};
		if (options.token) Object.assign(headers, bearer(options.token));
		if (options.ip) headers["x-forwarded-for"] = options.ip;
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

	type Options = { token?: string; body?: unknown; ip?: string };

	return {
		get: (path: string, opts?: Options) => call("GET", path, opts),
		post: (path: string, opts?: Options) => call("POST", path, opts),
		put: (path: string, opts?: Options) => call("PUT", path, opts),
		delete: (path: string, opts?: Options) => call("DELETE", path, opts),
	};
}
