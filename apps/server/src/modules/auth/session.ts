/**
 * Session resolution and role enforcement (spec §11.3).
 *
 * Every non-public endpoint carries an explicit role requirement. There is no
 * default-allow path: a route either declares `requireRole` or is public by
 * deliberate choice.
 */

import { auth } from "@greetings/auth";
import { db } from "@greetings/db";
import { type UserRole, user as userTable } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { forbidden, unauthenticated } from "../../lib/errors";

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
 * The role is read from the database rather than taken from the session
 * payload: a session issued before a role change would otherwise keep its old
 * privileges until it expired. Revocation has to be immediate.
 */
export async function resolveCurrentUser(
	headers: Headers,
): Promise<CurrentUser | null> {
	const session = await auth.api.getSession({ headers });
	if (!session?.user?.id) return null;

	const [row] = await db
		.select({
			id: userTable.id,
			email: userTable.email,
			name: userTable.name,
			role: userTable.role,
		})
		.from(userTable)
		.where(eq(userTable.id, session.user.id))
		.limit(1);

	return row ?? null;
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
		currentUser: await resolveCurrentUser(request.headers),
	}))
	.macro({
		requireRole(allowed: UserRole[] | true) {
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

/** Roles permitted to use the web panels at all (spec §1.1). */
export const WEB_ROLES: UserRole[] = ["designer", "admin", "super_admin"];
