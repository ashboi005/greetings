import { Elysia } from "elysia";
import { assertSafeCookieMutation } from "./csrf";

/** Applies the cookie-origin check to every route composed after this plugin. */
export function csrfProtection(origins: readonly string[]) {
	const trustedOrigins = new Set(
		origins.map((origin) => new URL(origin).origin),
	);

	return new Elysia({ name: "csrf-protection" }).onBeforeHandle(
		{ as: "global" },
		({ request }) => assertSafeCookieMutation(request, trustedOrigins),
	);
}
