/**
 * Panel account management, super admin only (spec §11.2).
 *
 * Panel users are staff and their accounts are handed out, not registered. That
 * is why public sign-up is disabled and these routes exist instead: the only way
 * a designer or admin account comes into being is a super admin creating it.
 *
 * Every action here is recorded in `role_change_log`. Creating an account *is* a
 * grant of privilege, and a password reset is the one operation that lets one
 * person take over another's account — neither should be possible without a
 * trace of who did it.
 */

import { createPanelAccount, setPanelPassword } from "@greetings/auth/accounts";
import { db } from "@greetings/db";
import {
	roleChangeLog,
	USER_ROLES,
	user as userTable,
} from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { conflict, notFound } from "../../lib/errors";
import { invalidateUser } from "../../lib/session-cache";
import { authGuard, requireUser } from "../auth/session";

/**
 * Long enough that a hurried administrator cannot pick something guessable.
 *
 * Matches `minPasswordLength` in packages/auth: the two have to agree, or this
 * route accepts a password that sign-in would then reject.
 */
const MIN_PASSWORD_LENGTH = 12;

export function adminAccountRoutes() {
	return new Elysia({ prefix: "/v1/admin" })
		.use(authGuard)

		.post(
			"/accounts",
			async ({ currentUser, body }) => {
				const actor = requireUser(currentUser);

				const created = await createPanelAccount({
					email: body.email,
					name: body.name,
					password: body.password,
					role: body.role,
				});

				if (!created) {
					throw conflict(
						"An account already exists for that email. Use the role assignment or password reset instead.",
					);
				}

				// Creating a designer or admin is a grant of privilege, so it goes
				// in the same log as any other role change rather than a separate
				// one nobody thinks to read.
				await db.insert(roleChangeLog).values({
					id: crypto.randomUUID(),
					actorId: actor.id,
					targetUserId: created.userId,
					fromRole: "user",
					toRole: created.role,
					reason: body.reason ?? "Panel account created by super admin",
					createdAt: new Date(),
				});

				return {
					userId: created.userId,
					email: created.email,
					role: created.role,
				};
			},
			{
				requireRole: ["super_admin"],
				body: t.Object({
					email: t.String({ format: "email", maxLength: 200 }),
					name: t.String({ minLength: 1, maxLength: 80 }),
					password: t.String({
						minLength: MIN_PASSWORD_LENGTH,
						maxLength: 200,
						description: `At least ${MIN_PASSWORD_LENGTH} characters`,
					}),
					role: t.UnionEnum(USER_ROLES),
					reason: t.Optional(t.String({ maxLength: 500 })),
				}),
				detail: {
					tags: ["Admin"],
					summary: "Create a panel account with a password",
					description:
						"The only way a designer or admin account is created — public " +
						"sign-up is disabled. Tell the person their password out of " +
						"band; nothing here can email it to them.",
				},
			},
		)

		.post(
			"/accounts/:id/password",
			async ({ currentUser, params, body }) => {
				const actor = requireUser(currentUser);

				const [target] = await db
					.select({ id: userTable.id, role: userTable.role })
					.from(userTable)
					.where(eq(userTable.id, params.id))
					.limit(1);

				if (!target) throw notFound("No such user.");

				const changed = await setPanelPassword(target.id, body.password);
				if (!changed) {
					throw conflict(
						"That account has no password to reset. It signs in through another provider.",
					);
				}

				// setPanelPassword deletes the database sessions; this drops the
				// cached copies, so the reset takes effect on the next request
				// rather than whenever the cache happens to expire.
				invalidateUser(target.id);

				await db.insert(roleChangeLog).values({
					id: crypto.randomUUID(),
					actorId: actor.id,
					targetUserId: target.id,
					// The role is unchanged; the log entry is here because a password
					// reset is a takeover-capable action and belongs on the record.
					fromRole: target.role,
					toRole: target.role,
					reason: body.reason ?? "Password reset by super admin",
					createdAt: new Date(),
				});

				return { ok: true as const };
			},
			{
				requireRole: ["super_admin"],
				body: t.Object({
					password: t.String({
						minLength: MIN_PASSWORD_LENGTH,
						maxLength: 200,
					}),
					reason: t.Optional(t.String({ maxLength: 500 })),
				}),
				detail: {
					tags: ["Admin"],
					summary: "Set a new password for a panel account",
					description:
						"Stands in for a self-service reset, which is impossible without " +
						"an email transport. Signs the account out everywhere.",
				},
			},
		);
}
