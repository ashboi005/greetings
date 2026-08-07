import { DOWNLOAD_SOURCES } from "@greetings/db/schema";
import { Elysia, t } from "elysia";
import { optionalEnum } from "../../lib/schema";
import type { ObjectStorage } from "../../lib/storage";
import { authGuard, requireUser } from "../auth/session";
import { recordDownload } from "./service";

/**
 * The download endpoint (spec §8).
 *
 * A POST, not a GET: it has a side effect, and browsers and proxies are free
 * to prefetch or cache a GET, which would inflate the counts designers are
 * measured on.
 */
export function downloadRoutes(storage: () => ObjectStorage) {
	return new Elysia({ prefix: "/v1" }).use(authGuard).post(
		"/content/:id/download",
		async ({ currentUser, params, body, headers }) => {
			const user = requireUser(currentUser);

			return recordDownload({
				contentId: params.id,
				userId: user.id,
				source: body?.source ?? "detail",
				idempotencyKey: headers["idempotency-key"],
				storage: storage(),
			});
		},
		{
			requireRole: true,
			body: t.Optional(
				t.Object({
					source: optionalEnum(DOWNLOAD_SOURCES, {
						description: "Where the user tapped download; defaults to detail",
					}),
				}),
			),
			headers: t.Object(
				{
					"idempotency-key": t.Optional(
						t.String({
							maxLength: 200,
							description:
								"Send a unique value per download attempt. Retrying with the " +
								"same value returns the same URL without counting twice.",
						}),
					),
				},
				// Elysia validates headers strictly otherwise, and every request
				// carries plenty this route does not care about.
				{ additionalProperties: true },
			),
			detail: {
				tags: ["Feed"],
				summary: "Record a download and get a signed image URL",
				description:
					"The only way to obtain image bytes. Returns a URL valid for five " +
					"minutes. Objects are not publicly readable, so every download is " +
					"counted.",
			},
		},
	);
}
