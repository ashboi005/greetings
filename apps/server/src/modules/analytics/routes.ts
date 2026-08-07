import { Elysia, t } from "elysia";
import { badRequest } from "../../lib/errors";
import { authGuard, requireUser } from "../auth/session";
import {
	type AnalyticsScope,
	byContent,
	byDesigner,
	byRegion,
	platformOverview,
	summary,
	timeseries,
} from "./queries";

/**
 * Analytics endpoints (spec §9).
 *
 * Designer routes force `designerId` to the caller's own id. It is never a
 * parameter, so no request shape exists that would let one designer read
 * another's numbers.
 */

const MAX_RANGE_DAYS = 366;

const dateRangeQuery = t.Object({
	from: t.Optional(
		t.String({ description: "YYYY-MM-DD, inclusive; defaults to 30 days ago" }),
	),
	to: t.Optional(
		t.String({ description: "YYYY-MM-DD, inclusive; defaults to today" }),
	),
	limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
});

function resolveScope(
	designerId: string | null,
	query: { from?: string; to?: string },
): AnalyticsScope {
	const today = new Date().toISOString().slice(0, 10);
	const to = query.to ?? today;
	const from =
		query.from ??
		new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

	assertIsoDate(from, "from");
	assertIsoDate(to, "to");

	if (from > to) throw badRequest("`from` must not be after `to`.");

	const spanDays =
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
		86_400_000;
	if (spanDays > MAX_RANGE_DAYS) {
		throw badRequest(`Range must not exceed ${MAX_RANGE_DAYS} days.`);
	}

	return { designerId, from, to, today };
}

function assertIsoDate(value: string, field: string) {
	// Checked here rather than in the schema so the message names the field
	// and the client is not left guessing which date was malformed.
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
		throw badRequest(`\`${field}\` must be a date in YYYY-MM-DD form.`);
	}
}

export function analyticsRoutes() {
	return (
		new Elysia({ prefix: "/v1" })
			.use(authGuard)

			// --- Designer: own numbers only ---
			.get(
				"/designer/analytics/summary",
				({ currentUser, query }) =>
					summary(resolveScope(requireUser(currentUser).id, query)),
				{
					requireRole: ["designer"],
					query: dateRangeQuery,
					detail: {
						tags: ["Designer"],
						summary: "Own totals for a date range",
					},
				},
			)
			.get(
				"/designer/analytics/by-content",
				({ currentUser, query }) =>
					byContent(
						resolveScope(requireUser(currentUser).id, query),
						query.limit ?? 50,
					),
				{
					requireRole: ["designer"],
					query: dateRangeQuery,
					detail: { tags: ["Designer"], summary: "Own downloads per post" },
				},
			)
			.get(
				"/designer/analytics/by-region",
				({ currentUser, query }) =>
					byRegion(resolveScope(requireUser(currentUser).id, query)),
				{
					requireRole: ["designer"],
					query: dateRangeQuery,
					detail: { tags: ["Designer"], summary: "Own downloads by region" },
				},
			)
			.get(
				"/designer/analytics/timeseries",
				({ currentUser, query }) =>
					timeseries(resolveScope(requireUser(currentUser).id, query)),
				{
					requireRole: ["designer"],
					query: dateRangeQuery,
					detail: { tags: ["Designer"], summary: "Own downloads per day" },
				},
			)

			// --- Super admin: platform-wide ---
			.get(
				"/admin/analytics/overview",
				({ query }) => platformOverview(resolveScope(null, query)),
				{
					requireRole: ["super_admin"],
					query: dateRangeQuery,
					detail: { tags: ["Admin"], summary: "Platform totals" },
				},
			)
			.get(
				"/admin/analytics/by-designer",
				({ query }) => byDesigner(resolveScope(null, query), query.limit ?? 50),
				{
					requireRole: ["super_admin"],
					query: dateRangeQuery,
					detail: { tags: ["Admin"], summary: "Performance per designer" },
				},
			)
			.get(
				"/admin/analytics/by-content",
				({ query }) => byContent(resolveScope(null, query), query.limit ?? 50),
				{
					requireRole: ["super_admin"],
					query: dateRangeQuery,
					detail: {
						tags: ["Admin"],
						summary: "Downloads per post, platform-wide",
					},
				},
			)
			.get(
				"/admin/analytics/by-region",
				({ query }) => byRegion(resolveScope(null, query)),
				{
					requireRole: ["super_admin"],
					query: dateRangeQuery,
					detail: {
						tags: ["Admin"],
						summary: "Downloads by region, platform-wide",
					},
				},
			)
			.get(
				"/admin/analytics/timeseries",
				({ query }) => timeseries(resolveScope(null, query)),
				{
					requireRole: ["super_admin"],
					query: dateRangeQuery,
					detail: {
						tags: ["Admin"],
						summary: "Downloads per day, platform-wide",
					},
				},
			)
	);
}
