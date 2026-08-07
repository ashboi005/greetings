import { db } from "@greetings/db";
import {
	roleChangeLog,
	roleInvites,
	session,
	USER_ROLES,
	type UserRole,
	userProfiles,
	user as userTable,
} from "@greetings/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";
import {
	badRequest,
	conflict,
	isUniqueViolation,
	notFound,
} from "../../lib/errors";
import { authGuard, requireUser } from "../auth/session";

/**
 * Role assignment, super admin only (spec §2.4).
 *
 * A grant is applied immediately when the person already has an account, and
 * parked as an invite otherwise — a super admin should not have to wait for
 * someone to sign up before granting them access.
 */
export function adminRoleRoutes() {
	return new Elysia({ prefix: "/v1/admin" })
		.use(authGuard)
		.post(
			"/roles/assign",
			async ({ currentUser, body }) => {
				const actor = requireUser(currentUser);

				if (!body.email && !body.phone) {
					throw badRequest("Provide an email or a phone number.");
				}

				const target = await findUserByIdentifier(body.email, body.phone);

				if (!target) {
					const invite = await createInvite(actor.id, body);
					return {
						applied: false as const,
						invited: true as const,
						inviteId: invite.id,
						role: body.role,
					};
				}

				if (target.id === actor.id) {
					// Without this a super admin could demote themselves and leave
					// the platform with no one able to restore the role.
					throw conflict("You cannot change your own role.");
				}

				if (target.role === body.role) {
					return {
						applied: false as const,
						invited: false as const,
						userId: target.id,
						role: body.role,
						unchanged: true as const,
					};
				}

				await applyRoleChange(actor.id, target, body.role, body.reason);

				return {
					applied: true as const,
					invited: false as const,
					userId: target.id,
					role: body.role,
				};
			},
			{
				requireRole: ["super_admin"],
				body: t.Object({
					email: t.Optional(t.String({ format: "email" })),
					phone: t.Optional(t.String({ minLength: 4, maxLength: 20 })),
					role: t.UnionEnum(USER_ROLES),
					reason: t.Optional(t.String({ maxLength: 500 })),
				}),
				detail: {
					tags: ["Admin"],
					summary: "Grant a role by email or phone",
					description:
						"Applies immediately if the person has an account, otherwise " +
						"stores an invite consumed at their first sign-in.",
				},
			},
		)
		.get(
			"/roles/invites",
			() =>
				db
					.select({
						id: roleInvites.id,
						email: roleInvites.email,
						phone: roleInvites.phone,
						role: roleInvites.role,
						createdAt: roleInvites.createdAt,
					})
					.from(roleInvites)
					.where(isNull(roleInvites.consumedAt))
					.orderBy(desc(roleInvites.createdAt)),
			{
				requireRole: ["super_admin"],
				detail: { tags: ["Admin"], summary: "Outstanding role invites" },
			},
		)
		.delete(
			"/roles/invites/:id",
			async ({ params }) => {
				const [deleted] = await db
					.delete(roleInvites)
					.where(
						and(eq(roleInvites.id, params.id), isNull(roleInvites.consumedAt)),
					)
					.returning({ id: roleInvites.id });

				if (!deleted) throw notFound("No outstanding invite with that id.");
				return { ok: true as const };
			},
			{
				requireRole: ["super_admin"],
				detail: { tags: ["Admin"], summary: "Revoke an outstanding invite" },
			},
		);
}

async function findUserByIdentifier(email?: string, phone?: string) {
	if (email) {
		const [row] = await db
			.select({ id: userTable.id, role: userTable.role })
			.from(userTable)
			.where(eq(userTable.email, email))
			.limit(1);
		if (row) return row;
	}

	if (phone) {
		const [row] = await db
			.select({ id: userTable.id, role: userTable.role })
			.from(userTable)
			.innerJoin(userProfiles, eq(userProfiles.userId, userTable.id))
			.where(eq(userProfiles.phone, phone))
			.limit(1);
		if (row) return row;
	}

	return null;
}

async function createInvite(
	actorId: string,
	body: { email?: string; phone?: string; role: UserRole },
) {
	const id = crypto.randomUUID();

	try {
		await db.insert(roleInvites).values({
			id,
			email: body.email,
			phone: body.phone,
			role: body.role,
			invitedBy: actorId,
			createdAt: new Date(),
		});
	} catch (cause) {
		// The partial unique index rejects a second outstanding invite for the
		// same identifier.
		if (isUniqueViolation(cause)) {
			throw conflict(
				"An unconsumed invite already exists for that identifier.",
			);
		}
		throw cause;
	}

	return { id };
}

async function applyRoleChange(
	actorId: string,
	target: { id: string; role: UserRole },
	role: UserRole,
	reason?: string,
) {
	await db.transaction(async (tx) => {
		await tx
			.update(userTable)
			.set({ role, updatedAt: new Date() })
			.where(eq(userTable.id, target.id));

		await tx.insert(roleChangeLog).values({
			id: crypto.randomUUID(),
			actorId,
			targetUserId: target.id,
			fromRole: target.role,
			toRole: role,
			reason,
			createdAt: new Date(),
		});

		// Authorisation reads the role from the session payload, so sessions
		// issued before this change still carry the old role. Deleting them
		// forces the next request to re-authenticate against the new role —
		// without this, a demotion would not take effect until the session
		// expired, which is the whole point of demoting someone.
		await tx.delete(session).where(eq(session.userId, target.id));
	});
}
