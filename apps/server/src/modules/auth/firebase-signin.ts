/**
 * Firebase ID token → Better Auth session (spec §11.1).
 *
 * Better Auth has no Firebase provider, so this is the one hand-written piece
 * of the auth system. It is kept deliberately small and free of HTTP concerns
 * so it can be tested directly.
 */

import { auth } from "@greetings/auth";
import { db } from "@greetings/db";
import {
	account,
	roleChangeLog,
	roleInvites,
	type UserRole,
	userProfiles,
	user as userTable,
} from "@greetings/db/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { AppError, isUniqueViolation } from "../../lib/errors";
import type { VerifiedIdentity } from "../../lib/token-verifier";

const FIREBASE_PROVIDER_ID = "firebase";

export interface SignInResult {
	token: string;
	user: {
		id: string;
		email: string;
		name: string;
		role: UserRole;
	};
	/** False until the user has chosen a region, which mobile needs to know. */
	onboarded: boolean;
	/** True when this sign-in created the account. */
	created: boolean;
}

/**
 * Finds or creates the user behind a verified identity, then issues a session.
 *
 * Runs the lookup and any writes in a transaction so two concurrent sign-ins
 * with the same token cannot create two users. Session creation happens after
 * the transaction commits, because it goes through Better Auth's own adapter.
 */
export async function signInWithVerifiedIdentity(
	identity: VerifiedIdentity,
): Promise<SignInResult> {
	// Two devices signing in at the same instant both find no account and both
	// try to create one. Whichever loses hits a unique constraint — on the
	// placeholder email, or now on the provider identity itself — and used to
	// surface as a 500 to a user who had done nothing wrong. Measured: three of
	// four concurrent first sign-ins failed that way.
	//
	// Losing that race is not an error, it is the answer arriving from somewhere
	// else. Retrying once re-runs the lookup, finds the row the winner just
	// committed, and returns the same user. Once, not in a loop: a second
	// collision would mean something other than this race, and a sign-in path
	// that retries indefinitely is a way to hide a real fault.
	const { userId, created } = await withUniqueRetry(() =>
		findOrCreateUser(identity),
	);

	const [row] = await db
		.select({
			id: userTable.id,
			email: userTable.email,
			name: userTable.name,
			role: userTable.role,
			onboardedAt: userProfiles.onboardedAt,
		})
		.from(userTable)
		.leftJoin(userProfiles, eq(userProfiles.userId, userTable.id))
		.where(eq(userTable.id, userId))
		.limit(1);

	if (!row) {
		throw new AppError("INTERNAL", "User vanished during sign-in");
	}

	const token = await createSessionToken(userId);

	return {
		token,
		user: { id: row.id, email: row.email, name: row.name, role: row.role },
		onboarded: row.onboardedAt !== null,
		created,
	};
}

/** Runs `work`, retrying once if it lost a race to create the same identity. */
async function withUniqueRetry<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (cause) {
		if (!isUniqueViolation(cause)) throw cause;
		return work();
	}
}

async function findOrCreateUser(
	identity: VerifiedIdentity,
): Promise<{ userId: string; created: boolean }> {
	return db.transaction(async (tx) => {
		// 1. Have we seen this Firebase account before?
		const [existingAccount] = await tx
			.select({ userId: account.userId })
			.from(account)
			.where(
				and(
					eq(account.providerId, FIREBASE_PROVIDER_ID),
					eq(account.accountId, identity.subject),
				),
			)
			.limit(1);

		if (existingAccount) {
			return { userId: existingAccount.userId, created: false };
		}

		// 2. Otherwise, does an account already exist for this email or phone?
		//    Linking here is what stops a user who signed in with Google on the
		//    web and later with the same phone on mobile ending up with two
		//    accounts and a lost role.
		const linkedUserId = await findLinkableUser(tx, identity);

		const now = new Date();
		const resolvedUserId = linkedUserId ?? crypto.randomUUID();

		if (!linkedUserId) {
			// `user.email` is unique, so writing it is a claim of identity. Only a
			// verified address earns that: an unverified one is attacker-supplied,
			// and claiming it would either collide with the real owner's account
			// (a hard 500) or let a later sign-in link to this one.
			//
			// A phone sign-in carries no email at all, so both cases fall back to
			// a stable placeholder derived from the Firebase subject rather than
			// an invented real-looking address.
			const email =
				identity.email && identity.emailVerified
					? identity.email
					: `${identity.subject}@firebase.placeholder`;

			await tx.insert(userTable).values({
				id: resolvedUserId,
				name: identity.name ?? identity.phone ?? "Greetings user",
				email,
				emailVerified: identity.emailVerified,
				image: identity.picture,
				role: "user",
				createdAt: now,
				updatedAt: now,
			});

			await tx.insert(userProfiles).values({
				userId: resolvedUserId,
				phone: identity.phone,
				displayName: identity.name,
				createdAt: now,
				updatedAt: now,
			});
		} else if (identity.phone) {
			// Record the phone on an existing profile so a later invite keyed to
			// that number can still be matched.
			await tx
				.insert(userProfiles)
				.values({
					userId: resolvedUserId,
					phone: identity.phone,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing();
		}

		await tx.insert(account).values({
			id: crypto.randomUUID(),
			accountId: identity.subject,
			providerId: FIREBASE_PROVIDER_ID,
			userId: resolvedUserId,
			createdAt: now,
			updatedAt: now,
		});

		await consumePendingInvite(tx, resolvedUserId, identity);

		return { userId: resolvedUserId, created: !linkedUserId };
	});
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function findLinkableUser(
	tx: Tx,
	identity: VerifiedIdentity,
): Promise<string | null> {
	// Only a verified email is safe to link on: an unverified address can be
	// claimed by anyone, which would hand them the matching account.
	if (identity.email && identity.emailVerified) {
		const [byEmail] = await tx
			.select({ id: userTable.id })
			.from(userTable)
			.where(eq(userTable.email, identity.email))
			.limit(1);
		if (byEmail) return byEmail.id;
	}

	if (identity.phone) {
		const [byPhone] = await tx
			.select({ userId: userProfiles.userId })
			.from(userProfiles)
			.where(eq(userProfiles.phone, identity.phone))
			.limit(1);
		if (byPhone) return byPhone.userId;
	}

	return null;
}

/**
 * Applies a role granted before this person had an account (spec §4.1).
 *
 * Matching on either identifier, because a super admin may have invited by
 * email while the person signs in with a phone number.
 */
async function consumePendingInvite(
	tx: Tx,
	userId: string,
	identity: VerifiedIdentity,
): Promise<void> {
	const identifiers = [
		identity.email && identity.emailVerified
			? eq(roleInvites.email, identity.email)
			: null,
		identity.phone ? eq(roleInvites.phone, identity.phone) : null,
	].filter((v) => v !== null);

	if (identifiers.length === 0) return;

	const [invite] = await tx
		.select({ id: roleInvites.id, role: roleInvites.role })
		.from(roleInvites)
		.where(
			and(
				isNull(roleInvites.consumedAt),
				// A withdrawn invite must not still grant on first sign-in. The
				// row survives for the audit trail, which is exactly why this
				// predicate has to be here as well as on the unique index.
				isNull(roleInvites.revokedAt),
				or(...identifiers),
			),
		)
		.limit(1);

	if (!invite) return;

	const [current] = await tx
		.select({ role: userTable.role })
		.from(userTable)
		.where(eq(userTable.id, userId))
		.limit(1);

	await tx
		.update(userTable)
		.set({ role: invite.role, updatedAt: new Date() })
		.where(eq(userTable.id, userId));

	await tx
		.update(roleInvites)
		.set({ consumedAt: new Date(), consumedByUserId: userId })
		.where(eq(roleInvites.id, invite.id));

	await tx.insert(roleChangeLog).values({
		id: crypto.randomUUID(),
		actorId: null,
		targetUserId: userId,
		fromRole: current?.role ?? "user",
		toRole: invite.role,
		reason: "Consumed role invite at first sign-in",
		createdAt: new Date(),
	});
}

/**
 * Issues a Better Auth session for a user we have already authenticated.
 *
 * Uses the internal adapter because every public sign-in route is tied to a
 * credential type Better Auth knows about, and Firebase is not one of them.
 */
async function createSessionToken(userId: string): Promise<string> {
	const ctx = await auth.$context;
	const session = await ctx.internalAdapter.createSession(userId, false);

	if (!session?.token) {
		throw new AppError("INTERNAL", "Failed to create session");
	}

	return session.token;
}
