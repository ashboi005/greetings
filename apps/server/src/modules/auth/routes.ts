import { env } from "@greetings/env/server";
import { Elysia, t } from "elysia";
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
			async ({ body }) => {
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
				detail: {
					tags: ["Auth"],
					summary: "The signed-in user and their role",
				},
			},
		);
}
