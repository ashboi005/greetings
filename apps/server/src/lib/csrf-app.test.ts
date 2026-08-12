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
