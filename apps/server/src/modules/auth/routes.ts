import { env } from "@greetings/env/server";
import { Elysia, t } from "elysia";
import { clientIp, consume, consumeGlobal } from "../../lib/rate-limit";
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
/**
 * Sign-ins the whole process will verify per minute, from everyone combined.
 *
 * Sized never to bind in normal operation — a hundred a second is far past what
 * this product will see — so that when it does bind, something is wrong and
 * refusing quickly is the right answer.
 */
export const FIREBASE_VERIFY_GLOBAL_LIMIT = 6000;

/** Sign-ins one address may make per minute. */
export const FIREBASE_VERIFY_ADDRESS_LIMIT = 600;

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
			async ({ body, request, server }) => {
				// Two ceilings, because neither is sufficient alone.
				//
				// The global one first: verification costs a signature check, and
				// an attacker rotating x-forwarded-for defeats any per-address
				// limit. This caps the total, so evading the address limit buys
				// nothing. Sized so it never binds in normal traffic — 6000/minute
				// is a hundred sign-ins a second, far past what this product will
				// see, and past it callers are refused in microseconds rather than
				// the server queueing crypto until it falls over.
				consumeGlobal("firebase-verify", {
					limit: FIREBASE_VERIFY_GLOBAL_LIMIT,
					windowSeconds: 60,
				});

				// Then per address, to stop one bad client crowding out everyone
				// else before the global ceiling is anywhere near. Deliberately
				// generous: Indian mobile carriers use carrier-grade NAT, so one
				// address fronts thousands of genuine users, and a tight limit
				// locks out a network rather than an abuser. Not a credential
				// guard either way — Google has already authenticated the token.
				consume(
					`auth:firebase:${clientIp(request, {
						socketAddress: server?.requestIP(request)?.address,
					})}`,
					{ limit: FIREBASE_VERIFY_ADDRESS_LIMIT, windowSeconds: 60 },
				);

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
