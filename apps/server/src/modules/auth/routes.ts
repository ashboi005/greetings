import { env } from "@greetings/env/server";
import { Elysia, t } from "elysia";
import { clientIp, consume } from "../../lib/rate-limit";
import {
	currentUserResponse,
	errorResponse,
	sessionResponse,
} from "../../lib/responses";
import type { TokenVerifier } from "../../lib/token-verifier";
import { requireTokenVerifier } from "../../lib/token-verifier";
import { signInWithVerifiedIdentity } from "./firebase-signin";
import { authGuard } from "./session";

/**
 * Authentication routes (spec §11).
 *
 * The verifier is injected so tests can supply a fake; production resolves the
 * real Firebase one lazily, on first use, so an unconfigured server still boots.
 */
export function authRoutes(verifierOverride?: TokenVerifier) {
	let verifier: TokenVerifier | undefined;
	const getVerifier = () => {
		verifier ??= requireTokenVerifier(
			env.FIREBASE_PROJECT_ID,
			verifierOverride,
		);
		return verifier;
	};

	return new Elysia({ prefix: "/v1/auth" })
		.use(authGuard)
		.post(
			"/firebase",
			async ({ body, request }) => {
				// Keyed on IP because there is no user yet, and deliberately
				// generous. Indian mobile carriers use carrier-grade NAT, so a
				// single address can front thousands of genuine users — a tight
				// per-IP limit locks out a whole network rather than an abuser.
				// This is a backstop against resource exhaustion (each attempt
				// costs a JWKS fetch and a signature check), not a credential
				// guard: Google has already authenticated the token.
				consume(`auth:firebase:${clientIp(request)}`, {
					limit: 600,
					windowSeconds: 60,
				});

				const identity = await getVerifier().verify(body.idToken);
				return signInWithVerifiedIdentity(identity);
			},
			{
				body: t.Object({
					idToken: t.String({
						minLength: 1,
						description: "Firebase ID token obtained by the mobile client",
					}),
				}),
				response: {
					200: sessionResponse,
					401: errorResponse,
					429: errorResponse,
				},
				detail: {
					tags: ["Auth"],
					summary: "Exchange a Firebase ID token for a session",
					description:
						"Mobile sign-in. The client completes Firebase phone or Google " +
						"sign-in, then posts the resulting ID token here. Returns a session " +
						"token to send as `Authorization: Bearer <token>` on later requests.",
				},
			},
		)
		.get(
			"/me",
			({ currentUser }) => ({
				id: currentUser?.id,
				email: currentUser?.email,
				name: currentUser?.name,
				role: currentUser?.role,
			}),
			{
				requireRole: true,
				response: { 200: currentUserResponse, 401: errorResponse },
				detail: {
					tags: ["Auth"],
					summary: "The signed-in user and their role",
				},
			},
		);
}
