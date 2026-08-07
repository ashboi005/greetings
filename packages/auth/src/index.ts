import { expo } from "@better-auth/expo";
import { createDb } from "@greetings/db";
import * as schema from "@greetings/db/schema";
import { env } from "@greetings/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";

/**
 * Authentication configuration (spec §11).
 *
 * Two front doors, one session model:
 *   - Mobile users sign in through Firebase; apps/server exchanges the Firebase
 *     ID token for a session here (Better Auth has no Firebase provider).
 *   - Designers, admins and super admins sign in on the web with Google.
 *
 * Email and password is deliberately off. The product has no password flow, and
 * leaving it enabled would expose a second, weaker route into privileged
 * accounts.
 */
export function createAuth() {
	const db = createDb();

	const googleConfigured = Boolean(
		env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
	);

	return betterAuth({
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: schema,
		}),
		trustedOrigins: [
			env.CORS_ORIGIN,
			"greetings://",
			"exp://",
			"http://localhost:8081",
		],
		emailAndPassword: {
			enabled: false,
		},
		socialProviders: googleConfigured
			? {
					google: {
						clientId: env.GOOGLE_CLIENT_ID as string,
						clientSecret: env.GOOGLE_CLIENT_SECRET as string,
					},
				}
			: {},
		session: {
			// Better Auth's session token is an opaque database key, not a JWT, so
			// every getSession() would otherwise be a query. The cookie cache
			// stores the session and user — including `role` — in a short-lived
			// signed cookie, encoded as a JWT, letting a web request authorise
			// without touching the database.
			//
			// The trade: a role change is invisible to a cached cookie until it
			// expires. Role changes revoke the target's sessions, so this five
			// minutes is the entire window, not the session lifetime.
			//
			// Note this is a cookie, so it applies to the web panels. Mobile
			// clients send a bearer token and no cookie jar, so they still
			// resolve through the database.
			cookieCache: {
				enabled: true,
				maxAge: 5 * 60,
				strategy: "jwt",
			},
		},
		user: {
			additionalFields: {
				role: {
					type: "string",
					required: false,
					defaultValue: "user",
					// The security boundary of the whole role system. Without
					// this, a sign-up payload could name its own role.
					input: false,
				},
			},
		},
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		advanced: {
			defaultCookieAttributes: {
				sameSite: "none",
				secure: true,
				httpOnly: true,
			},
		},
		// bearer(): mobile clients hold a token rather than a cookie jar, and the
		// Firebase exchange hands one back directly.
		plugins: [expo(), bearer()],
	});
}

export const auth = createAuth();

export type Auth = typeof auth;
