import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { roleInvites, user as userTable } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { testDb, truncateAll } from "./db";
import { fakeTokenVerifier } from "./fakes";
import { client, seedReference, setRole } from "./helpers";

const firebase = fakeTokenVerifier();
const app = createApp({ tokenVerifier: firebase.verifier });
const api = client(app);

/** Signs a fresh user in and returns their session token and id. */
async function signIn(
	token: string,
	identity: Parameters<typeof firebase.register>[1] = {},
) {
	firebase.register(token, identity);
	const res = await api.post("/v1/auth/firebase", { body: { idToken: token } });
	expect(res.status).toBe(200);
	return res.body as {
		token: string;
		user: { id: string; role: string; email: string };
		onboarded: boolean;
		created: boolean;
	};
}

/**
 * Signs in as a super admin.
 *
 * Two sign-ins: the role is carried in the session payload, so promoting the
 * user in the database only takes effect on a session issued afterwards.
 */
async function signInAsSuperAdmin(
	base: string,
	identity: Parameters<typeof firebase.register>[1] = {},
) {
	const first = await signIn(`${base}-1`, identity);
	await setRole(first.user.id, "super_admin");

	firebase.register(`${base}-2`, {
		...identity,
		subject: `firebase-uid-${base}-1`,
	});
	const res = await api.post("/v1/auth/firebase", {
		body: { idToken: `${base}-2` },
	});
	expect(res.body.user.role).toBe("super_admin");

	return res.body as { token: string; user: { id: string; role: string } };
}

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	await seedReference();
});

describe("POST /v1/auth/firebase", () => {
	test("creates a user and returns a usable session", async () => {
		const result = await signIn("tok-1", {
			phone: "+919876500001",
			name: "Asha",
		});

		expect(result.created).toBe(true);
		expect(result.onboarded).toBe(false);
		expect(result.user.role).toBe("user");
		expect(result.token).toBeTruthy();

		// The returned token must actually authenticate.
		const me = await api.get("/v1/auth/me", { token: result.token });
		expect(me.status).toBe(200);
		expect(me.body.id).toBe(result.user.id);
	});

	test("returns the same user on a second sign-in with the same subject", async () => {
		const first = await signIn("tok-a", { phone: "+919876500002" });

		firebase.register("tok-b", {
			subject: "firebase-uid-tok-a",
			phone: "+919876500002",
		});
		const second = await api.post("/v1/auth/firebase", {
			body: { idToken: "tok-b" },
		});

		expect(second.status).toBe(200);
		expect(second.body.user.id).toBe(first.user.id);
		expect(second.body.created).toBe(false);

		const all = await testDb.select().from(userTable);
		expect(all).toHaveLength(1);
	});

	test("links to an existing account by verified email rather than duplicating", async () => {
		const first = await signIn("tok-email-1", {
			email: "designer@example.com",
			emailVerified: true,
		});

		// A different Firebase subject, same verified email.
		firebase.register("tok-email-2", {
			subject: "different-uid",
			email: "designer@example.com",
			emailVerified: true,
		});
		const second = await api.post("/v1/auth/firebase", {
			body: { idToken: "tok-email-2" },
		});

		expect(second.body.user.id).toBe(first.user.id);
		expect(await testDb.select().from(userTable)).toHaveLength(1);
	});

	test("refuses to link on an unverified email", async () => {
		await signIn("tok-v", { email: "shared@example.com", emailVerified: true });

		firebase.register("tok-unverified", {
			subject: "attacker-uid",
			email: "shared@example.com",
			emailVerified: false,
		});
		const second = await api.post("/v1/auth/firebase", {
			body: { idToken: "tok-unverified" },
		});

		// A separate account, not a takeover of the verified one — and the
		// unverified address is not claimed on the new user, since user.email is
		// unique and writing it would assert an identity we have not proven.
		expect(second.status).toBe(200);

		const users = await testDb.select().from(userTable);
		expect(users).toHaveLength(2);

		const emails = users.map((u) => u.email).sort();
		expect(emails).toEqual([
			"attacker-uid@firebase.placeholder",
			"shared@example.com",
		]);
	});

	test("rejects an unknown token with 401 and the error envelope", async () => {
		const res = await api.post("/v1/auth/firebase", {
			body: { idToken: "never-registered" },
		});
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("UNAUTHENTICATED");
	});

	test("rejects a malformed body with 422", async () => {
		const res = await api.post("/v1/auth/firebase", { body: { idToken: "" } });
		expect(res.status).toBe(422);
	});

	test("never lets a client choose its own role", async () => {
		firebase.register("tok-role", { phone: "+919876500009" });
		const res = await api.post("/v1/auth/firebase", {
			body: { idToken: "tok-role", role: "super_admin" },
		});

		expect(res.status).toBe(200);
		expect(res.body.user.role).toBe("user");

		const [row] = await testDb
			.select({ role: userTable.role })
			.from(userTable)
			.where(eq(userTable.id, res.body.user.id));
		expect(row?.role).toBe("user");
	});
});

describe("GET /v1/auth/me", () => {
	test("requires authentication", async () => {
		const res = await api.get("/v1/auth/me");
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe("UNAUTHENTICATED");
	});

	test("rejects a garbage bearer token", async () => {
		const res = await api.get("/v1/auth/me", { token: "not-a-real-token" });
		expect(res.status).toBe(401);
	});

	test("a bearer session sees the current role, because session lookup joins the user row", async () => {
		const session = await signIn("tok-role-change", { phone: "+919876500010" });

		// Written straight to the database, bypassing the API and its session
		// revocation — the harshest case for a session-carried role.
		await setRole(session.user.id, "admin");

		const me = await api.get("/v1/auth/me", { token: session.token });

		// Bearer tokens resolve through a session lookup that joins `user`, so
		// the role is read fresh without a second query of our own. The cookie
		// cache, which can serve a stale role for up to its TTL, applies only to
		// cookie-bearing web requests — mobile sends no cookie jar.
		expect(me.body.role).toBe("admin");
	});
});

describe("role invites", () => {
	beforeAll(async () => {
		await truncateAll();
	});

	test("a pending invite is applied at first sign-in", async () => {
		// Arrange: a super admin who can issue the invite.
		const boss = await signInAsSuperAdmin("tok-boss", {
			email: "boss@example.com",
			emailVerified: true,
		});

		const invite = await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body: { email: "newdesigner@example.com", role: "designer" },
		});
		expect(invite.status).toBe(200);
		expect(invite.body.invited).toBe(true);

		// Act: that person signs in for the first time.
		const designer = await signIn("tok-designer", {
			email: "newdesigner@example.com",
			emailVerified: true,
		});

		expect(designer.user.role).toBe("designer");

		const [row] = await testDb
			.select({ consumedAt: roleInvites.consumedAt })
			.from(roleInvites)
			.where(eq(roleInvites.email, "newdesigner@example.com"));
		expect(row?.consumedAt).not.toBeNull();
	});

	test("an invite by phone is applied to a phone sign-in", async () => {
		const boss = await signInAsSuperAdmin("tok-boss-2", {
			email: "boss2@example.com",
			emailVerified: true,
		});

		await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body: { phone: "+919876511111", role: "admin" },
		});

		const invited = await signIn("tok-phone-invite", {
			phone: "+919876511111",
		});
		expect(invited.user.role).toBe("admin");
	});

	test("an invite is consumed once, not re-applied after a later demotion", async () => {
		const boss = await signInAsSuperAdmin("tok-boss-3", {
			email: "boss3@example.com",
			emailVerified: true,
		});

		await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body: { email: "once@example.com", role: "designer" },
		});

		const first = await signIn("tok-once-1", {
			email: "once@example.com",
			emailVerified: true,
		});
		expect(first.user.role).toBe("designer");

		// Demote, then sign in again with the same identity.
		await setRole(first.user.id, "user");
		firebase.register("tok-once-2", {
			subject: "firebase-uid-tok-once-1",
			email: "once@example.com",
			emailVerified: true,
		});
		const second = await api.post("/v1/auth/firebase", {
			body: { idToken: "tok-once-2" },
		});

		expect(second.body.user.role).toBe("user");
	});
});
