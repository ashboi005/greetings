import { beforeEach, describe, expect, test } from "bun:test";
import { userProfiles } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { testDb, truncateAll } from "./db";
import { fakeTokenVerifier } from "./fakes";
import { authHelper, client, seedReference } from "./helpers";

const firebase = fakeTokenVerifier();
const app = createApp({ tokenVerifier: firebase.verifier });
const api = client(app);

const auth = authHelper(api, firebase);

let seq = 0;

/** A plain signed-in user; most profile tests need nothing more. */
async function signIn(overrides: Record<string, unknown> = {}) {
	const session = await auth.signIn(overrides);
	return { token: session.token, user: { id: session.userId } };
}

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	await seedReference();
});

describe("reference data", () => {
	test("GET /v1/regions lists Indian states and union territories", async () => {
		const res = await api.get("/v1/regions");
		expect(res.status).toBe(200);

		const codes = (res.body as { code: string }[]).map((r) => r.code);
		expect(codes).toContain("IN-MH");
		expect(codes).toContain("IN-TN");
		expect(codes.length).toBeGreaterThanOrEqual(36);
	});

	test("GET /v1/languages includes native names", async () => {
		const res = await api.get("/v1/languages");
		const hindi = (res.body as { code: string; nativeName: string }[]).find(
			(l) => l.code === "hi",
		);
		expect(hindi?.nativeName).toBe("हिन्दी");
	});
});

describe("onboarding", () => {
	test("a new user starts un-onboarded", async () => {
		const session = await signIn();
		const res = await api.get("/v1/me/profile", { token: session.token });

		expect(res.body.onboarded).toBe(false);
		expect(res.body.regionCode).toBeNull();
		expect(res.body.languages).toEqual([]);
	});

	test("PUT /v1/me/profile records region and languages", async () => {
		const session = await signIn();

		const put = await api.put("/v1/me/profile", {
			token: session.token,
			body: {
				displayName: "Asha",
				regionCode: "IN-MH",
				languages: ["mr", "hi"],
			},
		});
		expect(put.status).toBe(200);

		const res = await api.get("/v1/me/profile", { token: session.token });
		expect(res.body.onboarded).toBe(true);
		expect(res.body.regionCode).toBe("IN-MH");
		expect(res.body.displayName).toBe("Asha");
		expect([...res.body.languages].sort()).toEqual(["hi", "mr"]);
	});

	test("editing replaces the language set rather than accumulating", async () => {
		const session = await signIn();

		await api.put("/v1/me/profile", {
			token: session.token,
			body: { regionCode: "IN-MH", languages: ["mr", "hi", "en"] },
		});
		await api.put("/v1/me/profile", {
			token: session.token,
			body: { regionCode: "IN-KA", languages: ["kn"] },
		});

		const res = await api.get("/v1/me/profile", { token: session.token });
		expect(res.body.languages).toEqual(["kn"]);
		expect(res.body.regionCode).toBe("IN-KA");
	});

	test("the first onboarding timestamp survives later edits", async () => {
		const session = await signIn();

		await api.put("/v1/me/profile", {
			token: session.token,
			body: { regionCode: "IN-MH", languages: ["mr"] },
		});
		const [first] = await testDb
			.select({ onboardedAt: userProfiles.onboardedAt })
			.from(userProfiles)
			.where(eq(userProfiles.userId, session.user.id));

		await api.put("/v1/me/profile", {
			token: session.token,
			body: { regionCode: "IN-KA", languages: ["kn"] },
		});
		const [second] = await testDb
			.select({ onboardedAt: userProfiles.onboardedAt })
			.from(userProfiles)
			.where(eq(userProfiles.userId, session.user.id));

		expect(second?.onboardedAt).toEqual(first?.onboardedAt as Date);
	});

	test("rejects an unknown region", async () => {
		const session = await signIn();
		const res = await api.put("/v1/me/profile", {
			token: session.token,
			body: { regionCode: "IN-ZZ", languages: ["hi"] },
		});

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});

	test("rejects unknown languages and names them", async () => {
		const session = await signIn();
		const res = await api.put("/v1/me/profile", {
			token: session.token,
			body: { regionCode: "IN-MH", languages: ["hi", "elvish"] },
		});

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("elvish");
	});

	test("rejects an empty language list", async () => {
		const session = await signIn();
		const res = await api.put("/v1/me/profile", {
			token: session.token,
			body: { regionCode: "IN-MH", languages: [] },
		});
		expect(res.status).toBe(422);
	});

	test("one user's profile edit cannot touch another's", async () => {
		const asha = await signIn();
		const brij = await signIn();

		await api.put("/v1/me/profile", {
			token: asha.token,
			body: { regionCode: "IN-MH", languages: ["mr"] },
		});
		await api.put("/v1/me/profile", {
			token: brij.token,
			body: { regionCode: "IN-WB", languages: ["bn"] },
		});

		const ashaProfile = await api.get("/v1/me/profile", { token: asha.token });
		expect(ashaProfile.body.regionCode).toBe("IN-MH");
	});
});

describe("role assignment", () => {
	/** Returns a super-admin session together with the email it was created under. */
	async function superAdmin() {
		const email = `boss${++seq}@example.com`;
		const session = await auth.signIn({
			role: "super_admin",
			email,
			emailVerified: true,
		});
		return { ...session, email, user: { id: session.userId } };
	}

	test("applies to an existing account and invalidates its old sessions", async () => {
		const boss = await superAdmin();
		const target = await auth.signIn({
			email: "target@example.com",
			emailVerified: true,
		});

		const res = await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body: { email: "target@example.com", role: "designer" },
		});

		expect(res.status).toBe(200);
		expect(res.body.applied).toBe(true);

		// Authorisation reads the role from the session, so the change would be
		// invisible to a session issued before it. Revoking the target's
		// sessions is what makes the grant — and equally a demotion — take
		// effect rather than waiting out the session lifetime.
		const stale = await api.get("/v1/auth/me", { token: target.token });
		expect(stale.status).toBe(401);

		const fresh = await auth.reSignIn(target.identity);
		expect(fresh.user.role).toBe("designer");
	});

	test("a demoted admin loses access as soon as they re-authenticate", async () => {
		const boss = await superAdmin();
		const rogue = await auth.signIn({
			role: "admin",
			email: "rogue@example.com",
			emailVerified: true,
		});

		// Confirm the starting privilege is real.
		const before = await api.get("/v1/auth/me", { token: rogue.token });
		expect(before.body.role).toBe("admin");

		await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body: { email: "rogue@example.com", role: "user" },
		});

		expect((await api.get("/v1/auth/me", { token: rogue.token })).status).toBe(
			401,
		);

		const fresh = await auth.reSignIn(rogue.identity);
		expect(fresh.user.role).toBe("user");
	});

	test("stores an invite when the target has no account yet", async () => {
		const boss = await superAdmin();

		const res = await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body: { email: "future@example.com", role: "admin" },
		});
		expect(res.body.invited).toBe(true);

		const list = await api.get("/v1/admin/roles/invites", {
			token: boss.token,
		});
		expect((list.body as { email: string }[])[0]?.email).toBe(
			"future@example.com",
		);
	});

	test("refuses a second outstanding invite for the same identifier", async () => {
		const boss = await superAdmin();
		const body = { email: "dupe@example.com", role: "designer" as const };

		await api.post("/v1/admin/roles/assign", { token: boss.token, body });
		const second = await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body,
		});

		expect(second.status).toBe(409);
		expect(second.body.error.code).toBe("CONFLICT");
	});

	test("a super admin cannot change their own role", async () => {
		const boss = await superAdmin();

		const res = await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body: { email: boss.email, role: "user" },
		});

		expect(res.status).toBe(409);
		const me = await api.get("/v1/auth/me", { token: boss.token });
		expect(me.body.role).toBe("super_admin");
	});

	test("requires an email or a phone", async () => {
		const boss = await superAdmin();
		const res = await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body: { role: "designer" },
		});
		expect(res.status).toBe(400);
	});

	test("an invite can be revoked before it is consumed", async () => {
		const boss = await superAdmin();

		const created = await api.post("/v1/admin/roles/assign", {
			token: boss.token,
			body: { email: "revokeme@example.com", role: "designer" },
		});

		const del = await api.delete(
			`/v1/admin/roles/invites/${created.body.inviteId}`,
			{ token: boss.token },
		);
		expect(del.status).toBe(200);

		const list = await api.get("/v1/admin/roles/invites", {
			token: boss.token,
		});
		expect(list.body).toEqual([]);
	});
});
