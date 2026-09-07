/**
 * Creating and re-crediting panel accounts (spec §11.2).
 *
 * Panel users are staff, created by a super admin rather than by signing up. So
 * account creation is a server-side operation, not a public route — and it has
 * to write the same rows Better Auth's own sign-up would, or a created account
 * would not be able to sign in.
 *
 * Two rows make a password account: the `user`, and an `account` row with
 * provider `credential` holding the hash. Better Auth looks the credential up by
 * that provider id, so it is a convention this has to match exactly rather than
 * a name of our choosing.
 *
 * Only panel roles belong here. An app user is authenticated by Firebase and
 * has no password credential at all, which is what keeps the two front doors
 * separate; giving one a `credential` row would let the same person in through
 * the panels as well. Callers enforce that — `WEB_ROLES` in the admin route's
 * schema — because the role type this takes is shared with the whole system and
 * narrowing it here would not be worth a package-crossing type.
 *
 * There is no email transport in this system, which is why `setPassword` exists.
 * A designer who forgets their password cannot be sent a reset link, so a super
 * admin sets a new one and tells them. That is a deliberate trade for not owning
 * an email pipeline; if one is ever added, a self-service reset becomes the
 * better answer and this stays as the administrative override.
 */

import { db } from "@greetings/db";
import type { UserRole } from "@greetings/db/schema";
import { account, session, user as userTable } from "@greetings/db/schema";
import { and, eq } from "drizzle-orm";
import { auth } from "./index";

/** Better Auth's provider id for password credentials. Not ours to rename. */
const CREDENTIAL_PROVIDER = "credential";

export interface CreatedAccount {
	userId: string;
	email: string;
	role: UserRole;
}

async function hashPassword(plain: string): Promise<string> {
	// Better Auth's own hasher, so a password set here verifies on sign-in
	// through exactly the same path as one it set itself.
	const ctx = await auth.$context;
	return ctx.password.hash(plain);
}

/**
 * Creates a panel account, or returns null if the email is already taken.
 *
 * Null rather than throwing: "that address already has an account" is an
 * ordinary answer for a form, not an exceptional condition, and the caller has
 * better context for how to say it.
 */
export async function createPanelAccount(input: {
	email: string;
	name: string;
	password: string;
	role: UserRole;
}): Promise<CreatedAccount | null> {
	const email = input.email.trim().toLowerCase();
	const hash = await hashPassword(input.password);
	const now = new Date();
	const userId = crypto.randomUUID();

	const [existing] = await db
		.select({ id: userTable.id })
		.from(userTable)
		.where(eq(userTable.email, email))
		.limit(1);

	if (existing) return null;

	await db.transaction(async (tx) => {
		await tx.insert(userTable).values({
			id: userId,
			name: input.name.trim(),
			email,
			// True because a super admin vouched for the address by typing it.
			// There is no link to send and nothing else to base it on.
			emailVerified: true,
			role: input.role,
			createdAt: now,
			updatedAt: now,
		});

		await tx.insert(account).values({
			id: crypto.randomUUID(),
			accountId: userId,
			providerId: CREDENTIAL_PROVIDER,
			userId,
			password: hash,
			createdAt: now,
			updatedAt: now,
		});
	});

	return { userId, email, role: input.role };
}

/**
 * Replaces someone's password and signs them out everywhere.
 *
 * Revoking sessions is the point as much as the new hash: a password is changed
 * because the old one should stop working, and a live session that outlived it
 * would keep the door open for as long as it lasted.
 */
export async function setPanelPassword(
	userId: string,
	password: string,
): Promise<boolean> {
	const hash = await hashPassword(password);

	return db.transaction(async (tx) => {
		const updated = await tx
			.update(account)
			.set({ password: hash, updatedAt: new Date() })
			.where(
				and(
					eq(account.userId, userId),
					eq(account.providerId, CREDENTIAL_PROVIDER),
				),
			)
			.returning({ id: account.id });

		if (updated.length === 0) return false;

		await tx.delete(session).where(eq(session.userId, userId));
		return true;
	});
}

/** Whether this user can sign in with a password at all. */
export async function hasPasswordCredential(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: account.id })
		.from(account)
		.where(
			and(
				eq(account.userId, userId),
				eq(account.providerId, CREDENTIAL_PROVIDER),
			),
		)
		.limit(1);

	return Boolean(row);
}
