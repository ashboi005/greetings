/**
 * Response schemas for the mobile-facing API (spec §12).
 *
 * Declared as Elysia `response` schemas rather than free-text documentation,
 * so they are validated at runtime: the published contract cannot drift from
 * what the server actually returns, and a shape change fails a test rather
 * than surprising the mobile developer in production.
 *
 * Only the endpoints the React Native app consumes are covered. The designer
 * and admin panels are Phase 2, written in this repository against these same
 * TypeScript types, so a hand-maintained schema would add drift risk without
 * adding safety.
 */

import { t } from "elysia";

export const errorResponse = t.Object({
	error: t.Object({
		code: t.String({ description: "Stable machine-readable code" }),
		message: t.String(),
		details: t.Optional(t.Unknown()),
	}),
});

export const sessionResponse = t.Object({
	token: t.String({ description: "Send as `Authorization: Bearer <token>`" }),
	user: t.Object({
		id: t.String(),
		email: t.String(),
		name: t.String(),
		role: t.String({ enum: ["user", "designer", "admin", "super_admin"] }),
	}),
	onboarded: t.Boolean({
		description: "False until the user has chosen a region",
	}),
	created: t.Boolean({
		description: "True when this sign-in created the account",
	}),
});

export const currentUserResponse = t.Object({
	id: t.Optional(t.String()),
	email: t.Optional(t.String()),
	name: t.Optional(t.String()),
	role: t.Optional(t.String()),
});

export const regionListResponse = t.Array(
	t.Object({ code: t.String(), name: t.String() }),
);

export const languageListResponse = t.Array(
	t.Object({ code: t.String(), name: t.String(), nativeName: t.String() }),
);

export const tagListResponse = t.Array(
	t.Object({
		id: t.String(),
		slug: t.String(),
		label: t.String(),
		category: t.String(),
	}),
);

export const profileResponse = t.Object({
	displayName: t.Union([t.String(), t.Null()]),
	phone: t.Union([t.String(), t.Null()]),
	regionCode: t.Union([t.String(), t.Null()]),
	languages: t.Array(t.String()),
	onboarded: t.Boolean(),
});

/** One tile in the feed or a search result. */
export const feedItem = t.Object({
	id: t.String(),
	title: t.String(),
	description: t.Union([t.String(), t.Null()]),
	primaryLanguage: t.String(),
	regionCode: t.Union([t.String(), t.Null()]),
	downloadCount: t.Number(),
	publishedAt: t.Union([t.Date(), t.String()]),
	designer: t.Object({ id: t.String(), name: t.String() }),
	storageKey: t.Union([t.String(), t.Null()], {
		description:
			"Object key. Useful for cache keys and logging; prefer imageUrl for display.",
	}),
	imageUrl: t.Union([t.String(), t.Null()], {
		description:
			"Full-size image on the CDN, for display. For a thumbnail, insert a " +
			"Cloudflare transform segment after the origin — " +
			"`https://cdn.example.com/cdn-cgi/image/width=400,format=auto/<path>` — " +
			"rather than appending a query string, which is ignored. Never render " +
			"the full-size original in a list. Null when this deployment has no " +
			"CDN configured. Saving an image still goes through " +
			"POST /v1/content/{id}/download, which is what counts it.",
	}),
});

export const feedResponse = t.Object({
	items: t.Array(feedItem),
	nextCursor: t.Union([t.String(), t.Null()], {
		description: "Pass back as `cursor` for the next page; null when finished",
	}),
});

export const searchResponse = t.Object({
	items: t.Array(t.Composite([feedItem, t.Object({ rank: t.Number() })])),
	nextCursor: t.Union([t.String(), t.Null()]),
});

export const downloadResponse = t.Object({
	url: t.String({
		description:
			"Where to fetch the image. A CDN URL when one is configured, otherwise " +
			"a signed URL that expires.",
	}),
	expiresInSeconds: t.Union([t.Number(), t.Null()], {
		description:
			"Seconds the URL stays valid, or null when it does not expire (CDN). " +
			"Null means the URL is safe to cache and reuse.",
	}),
	recorded: t.Boolean({
		description: "False when an Idempotency-Key replay returned a stored URL",
	}),
});

export const reportResponse = t.Object({
	id: t.String(),
	status: t.String(),
	heldForReview: t.Boolean({
		description: "True when this report hid the content pending review",
	}),
});

export const okResponse = t.Object({ ok: t.Boolean() });
