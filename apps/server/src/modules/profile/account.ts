/**
 * Deleting your own account (DELETE /v1/me).
 *
 * Required by Google Play of any app that creates accounts, alongside a web
 * page for people who no longer have the app. App users only: panel accounts
 * (designers, admins) own published content and audit history, and are
 * removed by a super admin, never by themselves from a phone.
 *
 * What goes: the user row and, by foreign-key cascade, their sessions, Firebase
 * link (`account`), profile, languages, designs, reports and idempotency keys;
 * then their logo and design images in storage.
 *
 * What stays: their download events, with `user_id` set to null by the schema.
 * The downloads happened and designers are judged on those counts, so only the
 * link to the person is cut. The events keep region and language, which are
 * about the download, not about anyone identifiable.
 *
 * Firebase's own record of the identity (the phone number or email used to
 * sign in) is not ours to delete from here — the server has no Firebase admin
 * credentials. The app deletes the Firebase user itself where it can; either
 * way, signing in again afterwards creates a new, empty account.
 */

import { db } from "@greetings/db";
import { userDesigns, user as userTable } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { okResponse } from "../../lib/responses";
import { invalidateUser } from "../../lib/session-cache";
import type { ObjectStorage } from "../../lib/storage";
import { authGuard, requireUser } from "../auth/session";
import { designPrefix } from "../designs/routes";
import { avatarPrefix } from "./avatar";

export function accountRoutes(storage: () => ObjectStorage) {
	return new Elysia({ prefix: "/v1/me" }).use(authGuard).delete(
		"",
		async ({ currentUser }) => {
			const me = requireUser(currentUser);

			// Read before deleting: the design ids, and so their storage
			// prefixes, disappear with the rows.
			const designs = await db
				.select({ id: userDesigns.id })
				.from(userDesigns)
				.where(eq(userDesigns.userId, me.id));
			const prefixes = [
				avatarPrefix(me.id),
				...designs.map((design) => designPrefix(design.id)),
			];

			await db.delete(userTable).where(eq(userTable.id, me.id));

			// The rows are gone, but a bearer token resolved in the last few
			// seconds is still in memory and would keep working until it ages
			// out. A deleted account must stop at once.
			invalidateUser(me.id);

			await purgePrefixes(storage, prefixes, me.id);

			return { ok: true as const };
		},
		{
			requireRole: ["user"],
			response: { 200: okResponse },
			detail: {
				tags: ["Profile"],
				summary: "Delete my account",
				description:
					"Permanently deletes the signed-in app user's account, profile, " +
					"designs and uploaded images. Download history is kept for " +
					"designers' counts but no longer linked to the person. Panel " +
					"accounts get 403. Cannot be undone.",
			},
		},
	);
}

/**
 * Best effort, after the fact. The person asked to be deleted and their rows
 * already are; a storage hiccup must not turn that into an error and an
 * account that looks undeleted. Anything left is unreachable — no row points
 * at it and every key carries a random suffix — and is logged for cleanup.
 */
async function purgePrefixes(
	storage: () => ObjectStorage,
	prefixes: string[],
	userId: string,
): Promise<void> {
	let bucket: ObjectStorage;
	try {
		bucket = storage();
	} catch (cause) {
		console.warn(`Account ${userId} deleted; storage unavailable:`, cause);
		return;
	}

	for (const prefix of prefixes) {
		try {
			for (const key of await bucket.list(prefix)) {
				await bucket.delete(key);
			}
		} catch (cause) {
			console.warn(
				`Account ${userId} deleted; objects under ${prefix} remain:`,
				cause,
			);
		}
	}
}
