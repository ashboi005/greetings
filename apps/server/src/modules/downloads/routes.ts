import { DOWNLOAD_SOURCES } from "@greetings/db/schema";
import { Elysia, t } from "elysia";
import { consume } from "../../lib/rate-limit";
import { downloadResponse, errorResponse } from "../../lib/responses";
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
export function downloadRoutes(
	storage: () => ObjectStorage,
	options: { publicBaseUrl?: string } = {},
) {
	return new Elysia({ prefix: "/v1" }).use(authGuard).post(
		"/content/:id/download",
		async ({ currentUser, params, body, headers }) => {
			const user = requireUser(currentUser);

			// Keyed on user, not IP: households and mobile carriers share
			// addresses heavily in this market, and throttling by IP would
			// punish ordinary users. Generous, because saving a batch of images
			// in one sitting is exactly what the product is for.
			consume(`download:${user.id}`, { limit: 120, windowSeconds: 60 });

			return recordDownload({
				contentId: params.id,
				userId: user.id,
				source: body?.source ?? "detail",
				customized: body?.customized ?? false,
				idempotencyKey: headers["idempotency-key"],
				storage: storage(),
				publicBaseUrl: options.publicBaseUrl,
			});
		},
		{
			requireRole: true,
			body: t.Optional(
				t.Object({
					source: optionalEnum(DOWNLOAD_SOURCES, {
						description: "Where the user tapped download; defaults to detail",
					}),
					customized: t.Optional(
						t.Boolean({
							description:
								"True when the user personalised the image before sharing. " +
								"The overlay is composed on the device, so this flag is the " +
								"only signal that the feature is being used.",
						}),
					),
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
			response: {
				200: downloadResponse,
				401: errorResponse,
				404: errorResponse,
				409: errorResponse,
				429: errorResponse,
			},
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
