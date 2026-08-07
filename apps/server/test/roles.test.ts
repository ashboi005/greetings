/**
 * Role enforcement across every guarded endpoint (spec §13).
 *
 * The spec calls this non-negotiable: each endpoint is exercised against each
 * wrong role, not just the happy path. Authorisation bugs do not announce
 * themselves — an endpoint that forgets its guard behaves perfectly for the
 * user who is supposed to reach it.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { UserRole } from "@greetings/db/schema";
import { createApp } from "../src/app";
import { truncateAll } from "./db";
import { fakeTokenVerifier } from "./fakes";
import {
	authHelper,
	client,
	seedReference,
	type TestResponse,
} from "./helpers";

const firebase = fakeTokenVerifier();
const app = createApp({ tokenVerifier: firebase.verifier });
const api = client(app);

const ALL_ROLES: UserRole[] = ["user", "designer", "admin", "super_admin"];

const auth = authHelper(api, firebase);

/** Signs in a user carrying `role`, returning their session token. */
async function sessionFor(role: UserRole): Promise<string> {
	const session = await auth.signIn({ role });
	expect(session.role).toBe(role);
	return session.token;
}

interface GuardedEndpoint {
	name: string;
	allowed: UserRole[];
	call: (token?: string) => Promise<TestResponse>;
}

const ENDPOINTS: GuardedEndpoint[] = [
	{
		name: "GET /v1/auth/me",
		allowed: ALL_ROLES,
		call: (token) => api.get("/v1/auth/me", { token }),
	},
	{
		name: "GET /v1/me/profile",
		allowed: ALL_ROLES,
		call: (token) => api.get("/v1/me/profile", { token }),
	},
	{
		name: "PUT /v1/me/profile",
		allowed: ALL_ROLES,
		call: (token) =>
			api.put("/v1/me/profile", {
				token,
				body: { regionCode: "IN-MH", languages: ["mr"] },
			}),
	},
	{
		name: "POST /v1/admin/roles/assign",
		allowed: ["super_admin"],
		call: (token) =>
			api.post("/v1/admin/roles/assign", {
				token,
				body: { email: "someone@example.com", role: "designer" },
			}),
	},
	{
		name: "GET /v1/admin/roles/invites",
		allowed: ["super_admin"],
		call: (token) => api.get("/v1/admin/roles/invites", { token }),
	},
	{
		name: "DELETE /v1/admin/roles/invites/:id",
		allowed: ["super_admin"],
		call: (token) =>
			api.delete("/v1/admin/roles/invites/does-not-exist", { token }),
	},
];

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	await seedReference();
});

describe("authentication is required", () => {
	for (const endpoint of ENDPOINTS) {
		test(`${endpoint.name} rejects an anonymous caller with 401`, async () => {
			const res = await endpoint.call(undefined);
			expect(res.status).toBe(401);
			expect(res.body.error.code).toBe("UNAUTHENTICATED");
		});
	}
});

describe("role matrix", () => {
	for (const endpoint of ENDPOINTS) {
		for (const role of ALL_ROLES) {
			const permitted = endpoint.allowed.includes(role);

			test(`${endpoint.name} ${permitted ? "allows" : "forbids"} ${role}`, async () => {
				const token = await sessionFor(role);
				const res = await endpoint.call(token);

				if (permitted) {
					// The guard must not be what rejects this call. The handler may
					// still 404 or 409 on its own terms.
					expect(res.status).not.toBe(401);
					expect(res.status).not.toBe(403);
				} else {
					expect(res.status).toBe(403);
					expect(res.body.error.code).toBe("FORBIDDEN");
				}
			});
		}
	}
});
