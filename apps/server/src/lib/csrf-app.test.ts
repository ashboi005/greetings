import { expect, test } from "bun:test";
import { createApp } from "../app";

test("the composed application blocks a cross-site form before authentication", async () => {
	const app = createApp();
	const response = await app.handle(
		new Request("http://localhost/v1/admin/roles/assign", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				cookie: "better-auth.session_token=ambient-browser-credential",
				origin: "https://attacker.test",
			},
			body: "email=attacker%40example.com&role=super_admin",
		}),
	);

	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		error: {
			code: "FORBIDDEN",
			message: "Cross-site cookie-authenticated request refused.",
		},
	});
});

test("the composed application blocks a cross-site sign-out", async () => {
	const app = createApp();
	const response = await app.handle(
		new Request("http://localhost/api/auth/sign-out", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: "better-auth.session_token=ambient-browser-credential",
				origin: "https://attacker.test",
			},
			body: "{}",
		}),
	);

	// Better Auth does not check the request origin itself, so exempting its
	// namespace left an attacker page able to log an administrator out.
	expect(response.status).toBe(403);
});

test("a safe cross-site read is still allowed through", async () => {
	const app = createApp();
	const response = await app.handle(
		new Request("http://localhost/health", {
			headers: {
				cookie: "better-auth.session_token=ambient-browser-credential",
				origin: "https://attacker.test",
			},
		}),
	);

	// The guard is about side effects, not about reading. CORS already stops
	// the attacker seeing this response.
	expect(response.status).toBe(200);
});
