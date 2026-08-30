/**
 * The user's logo or profile image (spec §16).
 *
 * This is the mark that gets burned into a shared graphic, so it belongs to the
 * user's *profile*, not to `user.image`. That field holds whatever Google or
 * Firebase returned and is rewritten on every sign-in, so storing a logo there
 * would mean a re-login silently erasing it.
 *
 * Same three steps as every other upload here: sign, PUT to R2, confirm against
 * what actually landed.
 */

import { db } from "@greetings/db";
import { userProfiles } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { notFound } from "../../lib/errors";
import { okResponse } from "../../lib/responses";
import type { ObjectStorage } from "../../lib/storage";
import { publicImageUrl } from "../../lib/storage";
import {
	ALLOWED_IMAGE_MIME,
	assertKeyBelongsTo,
	assertUploadedObject,
	presignImageUpload,
} from "../../lib/uploads";
import { authGuard, requireUser } from "../auth/session";

/**
 * Half the designer limit. A logo is a small mark rendered a few hundred pixels
 * wide, and every megabyte here is one a user on a slow connection uploads and
 * then downloads again on every device they sign in from.
 */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Keys are namespaced per user, which is what makes the confirm step safe. */
const prefixFor = (userId: string) => `avatars/${userId}/`;

export function avatarRoutes(
	storage: () => ObjectStorage,
	options: { publicBaseUrl?: string } = {},
) {
	return new Elysia({ prefix: "/v1/me/avatar" })
		.use(authGuard)

		.post(
			"/upload-url",
			({ currentUser, body }) => {
				const user = requireUser(currentUser);
				return presignImageUpload({
					storage: storage(),
					prefix: prefixFor(user.id),
					mimeType: body.mimeType,
					bytes: body.bytes,
					maxBytes: MAX_AVATAR_BYTES,
				});
			},
			{
				requireRole: true,
				body: t.Object({
					mimeType: t.String({
						description: ALLOWED_IMAGE_MIME.join(", "),
					}),
					bytes: t.Integer({ minimum: 1 }),
				}),
				response: {
					200: t.Object({
						storageKey: t.String(),
						uploadUrl: t.String(),
						expiresInSeconds: t.Number(),
					}),
				},
				detail: {
					tags: ["Profile"],
					summary: "Sign a URL for uploading a logo",
					description:
						"PUT the file to `uploadUrl` with the same content-type, then " +
						"POST /v1/me/avatar with the returned storageKey.",
				},
			},
		)

		.post(
			"",
			async ({ currentUser, body }) => {
				const user = requireUser(currentUser);

				assertKeyBelongsTo(body.storageKey, prefixFor(user.id));
				await assertUploadedObject({
					storage: storage(),
					storageKey: body.storageKey,
					maxBytes: MAX_AVATAR_BYTES,
				});

				// A profile row exists for anyone who has onboarded. Someone who
				// uploads a logo before finishing onboarding should not be refused,
				// so this inserts rather than assuming.
				const now = new Date();
				await db
					.insert(userProfiles)
					.values({
						userId: user.id,
						avatarKey: body.storageKey,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: userProfiles.userId,
						set: { avatarKey: body.storageKey, updatedAt: now },
					});

				return {
					avatarKey: body.storageKey,
					avatarUrl: publicImageUrl(body.storageKey, options.publicBaseUrl),
				};
			},
			{
				requireRole: true,
				body: t.Object({ storageKey: t.String({ maxLength: 300 }) }),
				response: {
					200: t.Object({
						avatarKey: t.String(),
						avatarUrl: t.Union([t.String(), t.Null()]),
					}),
				},
				detail: {
					tags: ["Profile"],
					summary: "Confirm an uploaded logo",
					description:
						"Replaces any previous logo. The old object is left in storage; " +
						"it is small and orphan cleanup is a job, not a request path.",
				},
			},
		)

		.delete(
			"",
			async ({ currentUser }) => {
				const user = requireUser(currentUser);

				const [row] = await db
					.select({ avatarKey: userProfiles.avatarKey })
					.from(userProfiles)
					.where(eq(userProfiles.userId, user.id))
					.limit(1);

				if (!row?.avatarKey) throw notFound("No logo to remove.");

				await db
					.update(userProfiles)
					.set({ avatarKey: null, updatedAt: new Date() })
					.where(eq(userProfiles.userId, user.id));

				return { ok: true as const };
			},
			{
				requireRole: true,
				response: { 200: okResponse },
				detail: { tags: ["Profile"], summary: "Remove the logo" },
			},
		);
}
