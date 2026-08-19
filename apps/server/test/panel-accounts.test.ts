/**
 * Password sign-in for the panels (spec §11.2).
 *
 * The security of this rests on one thing: accounts exist only because a super
 * admin created them. So the tests that matter are the ones proving there is no
 * other route to one.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createPanelAccount } from "@greetings/auth/accounts";
import { account, user as userTable } from "@greetings/db/schema";
import { seedSuperAdmin } from "@greetings/db/seed/index";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { testDb, truncateAll } from "./db";
import { fakeObjectStorage, fakeTokenVerifier } from "./fakes";
import { authHelper, client, seedReference } from "./helpers";

const firebase = fakeTokenVerifier();
const app = createApp({
	tokenVerifier: firebase.verifier,
	objectStorage: fakeObjectStorage().storage,
});
const api = client(app);
const auth = authHelper(api, firebase);

const STRONG = "correct-horse-battery-staple";

/** What `bun run jobs create-admin` does, minus the logging. */
function bootstrapAccount() {
	return createPanelAccount({
		email: "boss@example.com",
		name: "Super admin",
		password: STRONG,
		role: "super_admin",
	});
}

/** Signs in with a password the way the panel does, returning the cookie. */
async function signIn(email: string, password: string) {
	const res = await app.handle(
		new Request("http://localhost/api/auth/sign-in/email", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3001",
			},
			body: JSON.stringify({ email, password }),
		}),
	);
	const setCookie = res.headers.get("set-cookie");
	return {
		status: res.status,
		cookie: setCookie?.split(";")[0] ?? null,
	};
}

/** Calls the API with a browser-style cookie session. */
function withCookie(path: string, cookie: string) {
	return (
		app
			.handle(
				new Request(`http://localhost${path}`, {
					headers: { cookie, origin: "http://localhost:3001" },
				}),
			)
			// biome-ignore lint/suspicious/noExplicitAny: test ergonomics, as elsewhere
			.then(async (res) => ({
				status: res.status,
				// biome-ignore lint/suspicious/noExplicitAny: test ergonomics, as elsewhere
				body: (await res.json()) as any,
			}))
	);
}

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	await seedReference();
});

describe("public sign-up", () => {
	test("is refused, so nobody can mint their own panel account", async () => {
		const res = await app.handle(
			new Request("http://localhost/api/auth/sign-up/email", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3001",
				},
				body: JSON.stringify({
					email: "intruder@example.com",
					password: STRONG,
					name: "Intruder",
				}),
			}),
		);

		expect(res.status).toBeGreaterThanOrEqual(400);

		const rows = await testDb
			.select()
			.from(userTable)
			.where(eq(userTable.email, "intruder@example.com"));
		expect(rows).toHaveLength(0);
	});
});

describe("bootstrapping the first super admin", () => {
	test("creates the account when given a password", async () => {
		const created = await bootstrapAccount();
		expect(created).not.toBeNull();

		const signedIn = await signIn("boss@example.com", STRONG);
		expect(signedIn.status).toBe(200);
		expect(signedIn.cookie).toBeTruthy();

		const me = await withCookie("/v1/auth/me", signedIn.cookie as string);
		expect((me.body as { role: string }).role).toBe("super_admin");
	});

	test("promote-only seeding says what to run when there is no account", async () => {
		const result = await seedSuperAdmin("nobody@example.com");
		expect(result.promoted).toBe(false);
		expect(result.reason).toContain("create-admin");
	});

	test("still promotes an existing account rather than duplicating it", async () => {
		const existing = await auth.signIn({ email: "already@example.com" });

		const result = await seedSuperAdmin("already@example.com");
		expect(result.promoted).toBe(true);

		const rows = await testDb
			.select()
			.from(userTable)
			.where(eq(userTable.email, "already@example.com"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(existing.userId);
	});

	test("creating the same account twice is refused, not duplicated", async () => {
		expect(await bootstrapAccount()).not.toBeNull();
		// createPanelAccount reports the clash rather than clobbering the row.
		expect(await bootstrapAccount()).toBeNull();
	});
});

describe("a super admin creating panel accounts", () => {
	async function bootstrap() {
		await bootstrapAccount();
		const signedIn = await signIn("boss@example.com", STRONG);
		return signedIn.cookie as string;
	}

	const post = (path: string, cookie: string, body: unknown) =>
		app
			.handle(
				new Request(`http://localhost${path}`, {
					method: "POST",
					headers: {
						cookie,
						origin: "http://localhost:3001",
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			)
			// biome-ignore lint/suspicious/noExplicitAny: test ergonomics, as elsewhere
			.then(async (res) => ({
				status: res.status,
				body: (await res.json()) as any,
			}));

	test("creates a designer who can then sign in", async () => {
		const cookie = await bootstrap();

		const created = await post("/v1/admin/accounts", cookie, {
			email: "designer@example.com",
			name: "Priya",
			password: STRONG,
			role: "designer",
		});
		expect(created.status).toBe(200);
		expect(created.body.role).toBe("designer");

		const theirSession = await signIn("designer@example.com", STRONG);
		expect(theirSession.status).toBe(200);

		const own = await withCookie(
			"/v1/designer/content",
			theirSession.cookie as string,
		);
		expect(own.status).toBe(200);
	});

	test("refuses a duplicate email instead of clobbering the account", async () => {
		const cookie = await bootstrap();
		const body = {
			email: "designer@example.com",
			name: "Priya",
			password: STRONG,
			role: "designer" as const,
		};

		expect((await post("/v1/admin/accounts", cookie, body)).status).toBe(200);
		expect((await post("/v1/admin/accounts", cookie, body)).status).toBe(409);
	});

	test("refuses a short password, matching what sign-in would accept", async () => {
		const cookie = await bootstrap();
		const res = await post("/v1/admin/accounts", cookie, {
			email: "weak@example.com",
			name: "Weak",
			password: "short",
			role: "designer",
		});
		// A password this route accepted but sign-in rejected would create an
		// account nobody could use.
		expect(res.status).toBe(422);
	});

	test("records the grant in the role change log", async () => {
		const cookie = await bootstrap();
		await post("/v1/admin/accounts", cookie, {
			email: "designer@example.com",
			name: "Priya",
			password: STRONG,
			role: "designer",
			reason: "Joined the content team",
		});

		const audit = await withCookie("/v1/admin/audit/roles", cookie);
		const entry = audit.body.items.find(
			(e: { targetEmail: string }) => e.targetEmail === "designer@example.com",
		);
		expect(entry.toRole).toBe("designer");
		expect(entry.reason).toBe("Joined the content team");
	});

	test("is closed to admins — only a super admin hands out accounts", async () => {
		const admin = await auth.signIn({ role: "admin" });
		const res = await api.post("/v1/admin/accounts", {
			token: admin.token,
			body: {
				email: "x@example.com",
				name: "X",
				password: STRONG,
				role: "designer",
			},
		});
		expect(res.status).toBe(403);
	});
});

describe("password resets", () => {
	async function bootstrapWithDesigner() {
		await bootstrapAccount();
		const cookie = (await signIn("boss@example.com", STRONG)).cookie as string;

		const created = await app
			.handle(
				new Request("http://localhost/v1/admin/accounts", {
					method: "POST",
					headers: {
						cookie,
						origin: "http://localhost:3001",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						email: "designer@example.com",
						name: "Priya",
						password: STRONG,
						role: "designer",
					}),
				}),
			)
			// biome-ignore lint/suspicious/noExplicitAny: test ergonomics, as elsewhere
			.then((r) => r.json() as any);

		return { cookie, designerId: created.userId as string };
	}

	test("the old password stops working and the new one works", async () => {
		const { cookie, designerId } = await bootstrapWithDesigner();
		const replacement = "a-totally-different-passphrase";

		const reset = await app.handle(
			new Request(`http://localhost/v1/admin/accounts/${designerId}/password`, {
				method: "POST",
				headers: {
					cookie,
					origin: "http://localhost:3001",
					"content-type": "application/json",
				},
				body: JSON.stringify({ password: replacement }),
			}),
		);
		expect(reset.status).toBe(200);

		expect((await signIn("designer@example.com", STRONG)).status).toBe(401);
		expect((await signIn("designer@example.com", replacement)).status).toBe(
			200,
		);
	});

	test("signs the account out everywhere", async () => {
		const { cookie, designerId } = await bootstrapWithDesigner();
		const theirs = (await signIn("designer@example.com", STRONG))
			.cookie as string;
		expect((await withCookie("/v1/auth/me", theirs)).status).toBe(200);

		await app.handle(
			new Request(`http://localhost/v1/admin/accounts/${designerId}/password`, {
				method: "POST",
				headers: {
					cookie,
					origin: "http://localhost:3001",
					"content-type": "application/json",
				},
				body: JSON.stringify({ password: "another-long-passphrase" }),
			}),
		);

		// A password is changed so the old one stops working. A session that
		// outlived it would keep the door open for as long as it lasted.
		expect((await withCookie("/v1/auth/me", theirs)).status).toBe(401);
	});

	test("says so when the account has no password to reset", async () => {
		await bootstrapAccount();
		const cookie = (await signIn("boss@example.com", STRONG)).cookie as string;

		// A mobile user signed in through Firebase: no credential row exists.
		const mobile = await auth.signIn({ email: "mobile@example.com" });

		const res = await app.handle(
			new Request(
				`http://localhost/v1/admin/accounts/${mobile.userId}/password`,
				{
					method: "POST",
					headers: {
						cookie,
						origin: "http://localhost:3001",
						"content-type": "application/json",
					},
					body: JSON.stringify({ password: "a-long-enough-passphrase" }),
				},
			),
		);
		expect(res.status).toBe(409);
	});
});

describe("what a created account looks like in the database", () => {
	test("one user row and one credential account, password hashed", async () => {
		await bootstrapAccount();

		const [person] = await testDb
			.select()
			.from(userTable)
			.where(eq(userTable.email, "boss@example.com"));
		const credentials = await testDb
			.select()
			.from(account)
			.where(
				and(
					eq(account.userId, person?.id ?? ""),
					eq(account.providerId, "credential"),
				),
			);

		expect(credentials).toHaveLength(1);
		expect(credentials[0]?.password).toBeTruthy();
		// Never the plaintext, however convenient that would be to assert.
		expect(credentials[0]?.password).not.toContain(STRONG);
	});
});
