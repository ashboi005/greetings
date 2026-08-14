import { describe, expect, test } from "bun:test";
import { assertSafeCookieMutation } from "./csrf";

const trustedOrigins = new Set([
	"https://app.greetings.test",
	"https://api.greetings.test",
]);

function request(
	method: string,
	headers: Record<string, string> = {},
): Request {
	return new Request("https://api.greetings.test/v1/admin/roles/assign", {
		method,
		headers,
	});
}

describe("cookie mutation CSRF protection", () => {
	test("rejects a cross-site mutation carrying an authenticated cookie", () => {
		expect(() =>
			assertSafeCookieMutation(
				request("POST", {
					cookie: "better-auth.session_token=secret",
					origin: "https://attacker.test",
				}),
				trustedOrigins,
			),
		).toThrow(
			expect.objectContaining({
				code: "FORBIDDEN",
			}),
		);
	});

	test("rejects a cookie mutation when the browser supplies no origin", () => {
		expect(() =>
			assertSafeCookieMutation(
				request("DELETE", { cookie: "better-auth.session_token=secret" }),
				trustedOrigins,
			),
		).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
	});

	test("allows trusted cookie mutations and non-cookie API clients", () => {
		for (const candidate of [
			request("PATCH", {
				cookie: "better-auth.session_token=secret",
				origin: "https://app.greetings.test",
			}),
			request("POST", { authorization: "Bearer mobile-token" }),
			request("GET", {
				cookie: "better-auth.session_token=secret",
				origin: "https://attacker.test",
			}),
		]) {
			expect(() =>
				assertSafeCookieMutation(candidate, trustedOrigins),
			).not.toThrow();
		}
	});
});
