/**
 * Session resolution and role enforcement (spec §11.3).
 *
 * Every non-public endpoint carries an explicit role requirement. There is no
 * default-allow path: a route either declares `requireRole` or is public by
 * deliberate choice.
 */

import { auth } from "@greetings/auth";
import { USER_ROLES, type UserRole } from "@greetings/db/schema";
import { Elysia } from "elysia";
import { forbidden, unauthenticated } from "../../lib/errors";
import {
	bearerToken,
	readCachedSession,
	writeCachedSession,
} from "../../lib/session-cache";

export interface CurrentUser {
	id: string;
	email: string;
	name: string;
	role: UserRole;
}

/**
 * Resolves the caller from the request, or null when unauthenticated.
 *
 * Better Auth reads either the session cookie (web) or the bearer token
 * (mobile), so both front doors converge here.
 *
 * The role comes from the session payload, which already carries it as a
 * Better Auth additional field — no second query. With `session.cookieCache`
 * enabled (packages/auth) a web request resolves entirely from the signed
 * cookie and touches no database at all.
 *
 * The cost is that a role change is not visible to sessions issued before it.
 * `revokeUserSessions` closes that gap: every role change deletes the target's
 * sessions, so the next request has to re-authenticate and picks up the new
 * role. Staleness is therefore bounded by the cookie cache TTL, not by the
 * session lifetime.
 */
type BetterAuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * Resolves the Better Auth session at most once per request.
 *
 * Each `getSession` is two queries (the session row, then the user row), and
 * several things want the session on a single request: the authorisation
 * guard, mounted by every route module, and the request logger. Without this
 * they each pay for their own lookup. Keyed on the Request object, so entries
 * are collected with it.
 */
const perRequest = new WeakMap<Request, Promise<BetterAuthSession>>();

export function getSessionOnce(request: Request): Promise<BetterAuthSession> {
	const cached = perRequest.get(request);
	if (cached) return cached;

	const pending = auth.api.getSession({ headers: request.headers });
	perRequest.set(request, pending);
	return pending;
}

/**
 * The caller, resolved from a short-lived cache where possible.
 *
 * Only the *authorisation* answer is cached — who this is and what role they
 * hold — not the Better Auth session object, which other code may want in full.
 * That keeps the cached value small and makes it obvious what staleness is
 * being accepted: see lib/session-cache.ts.
 *
 * Cookie-borne sessions skip the cache entirely. Better Auth already serves
 * those from a signed cookie without touching the database, so caching them
 * again would add staleness and save nothing.
 */
export async function resolveCurrentUserOnce(
	request: Request,
): Promise<CurrentUser | null> {
	const token = bearerToken(request.headers);
	if (!token) return toCurrentUser(await getSessionOnce(request));

	const hit = readCachedSession(token);
	if (hit !== undefined) {
		return hit
			? { id: hit.userId, email: hit.email, name: hit.name, role: hit.role }
			: null;
	}

	const session = await getSessionOnce(request);
	const user = toCurrentUser(session);

	writeCachedSession(
		token,
		user && session
			? {
					userId: user.id,
					email: user.email,
					name: user.name,
					role: user.role,
					expiresAt: new Date(session.session.expiresAt).getTime(),
				}
			: null,
	);

	return user;
}

export async function resolveCurrentUser(
	headers: Headers,
): Promise<CurrentUser | null> {
	return toCurrentUser(await auth.api.getSession({ headers }));
}

function toCurrentUser(session: BetterAuthSession): CurrentUser | null {
	if (!session?.user?.id) return null;

	const { id, email, name, role } = session.user;

	return {
		id,
		email,
		name,
		// Defensive: the column is an enum and the field is `input: false`, so
		// an unknown value should be impossible. Failing closed to the least
		// privileged role beats trusting an unrecognised string.
		role: isUserRole(role) ? role : "user",
	};
}

function isUserRole(value: unknown): value is UserRole {
	return (
		typeof value === "string" &&
		(USER_ROLES as readonly string[]).includes(value)
	);
}

/**
 * Elysia plugin exposing `requireRole` as a route-level guard.
 *
 * Usage:
 *   .get("/designer/thing", handler, { requireRole: ["designer"] })
 *
 * Passing an empty array means "any signed-in user", which is different from
 * omitting the guard entirely (public).
 */
export const authGuard = new Elysia({ name: "auth-guard" })
	.derive({ as: "global" }, async ({ request }) => ({
		currentUser: await resolveCurrentUserOnce(request),
	}))
	.macro({
		requireRole(allowed: readonly UserRole[] | true) {
			return {
				beforeHandle({ currentUser }: { currentUser: CurrentUser | null }) {
					if (!currentUser) {
						throw unauthenticated();
					}
					// `true` means any authenticated user.
					if (allowed === true) return;
					if (!allowed.includes(currentUser.role)) {
						throw forbidden(
							`This endpoint requires one of: ${allowed.join(", ")}.`,
						);
					}
				},
			};
		},
	});

/**
 * Narrows `currentUser` to non-null inside a handler.
 *
 * `requireRole` has already rejected anonymous callers, so this never fires in
 * practice — but it means a route that forgets its guard returns 401 rather
 * than dereferencing null, and it keeps handlers free of `!` assertions.
 */
export function requireUser(currentUser: CurrentUser | null): CurrentUser {
	if (!currentUser) throw unauthenticated();
	return currentUser;
}

/**
 * Roles permitted to use the web panels at all (spec §1.1).
 *
 * Equivalently: the roles that may hold a Better Auth password credential.
 * `user` is deliberately absent — app users authenticate through Firebase and
 * have no password to sign in with, and creating one for them would open a
 * second door into an account the panels reject anyway.
 *
 * A `const` tuple rather than `UserRole[]` so it can also be handed to
 * `t.UnionEnum` as a request schema, which needs the literal members.
 */
export const WEB_ROLES = ["designer", "admin", "super_admin"] as const;
