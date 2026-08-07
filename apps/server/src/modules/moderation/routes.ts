import { REPORT_REASONS } from "@greetings/db/schema";
import { Elysia, t } from "elysia";
import { errorResponse, reportResponse } from "../../lib/responses";
import { authGuard, requireUser } from "../auth/session";
import { listOpenReports, resolveReport, submitReport } from "./reports";

/**
 * Reporting and moderation (spec §10).
 *
 * Anyone signed in may report; only admins see the queue or rule on it.
 */
export function moderationRoutes() {
	return new Elysia({ prefix: "/v1" })
		.use(authGuard)

		.post(
			"/content/:id/report",
			async ({ currentUser, params, body }) => {
				const user = requireUser(currentUser);

				return submitReport({
					contentId: params.id,
					reporterId: user.id,
					reason: body.reason,
					note: body.note,
				});
			},
			{
				requireRole: true,
				body: t.Object({
					reason: t.UnionEnum(REPORT_REASONS),
					note: t.Optional(t.String({ maxLength: 1000 })),
				}),
				response: {
					200: reportResponse,
					401: errorResponse,
					404: errorResponse,
					409: errorResponse,
					429: errorResponse,
				},
				detail: {
					tags: ["Feed"],
					summary: "Report content as inappropriate",
					description:
						"One open report per person per item. Content is hidden " +
						"automatically once enough people report it, pending an " +
						"admin decision.",
				},
			},
		)

		.get("/admin/reports", ({ query }) => listOpenReports(query.limit ?? 50), {
			requireRole: ["admin", "super_admin"],
			query: t.Object({
				limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
			}),
			detail: {
				tags: ["Admin"],
				summary: "Open reports grouped by content, most-reported first",
			},
		})

		.post(
			"/admin/reports/:id/resolve",
			async ({ currentUser, params, body }) => {
				const admin = requireUser(currentUser);

				return resolveReport({
					reportId: params.id,
					adminId: admin.id,
					action: body.action,
					note: body.note,
				});
			},
			{
				requireRole: ["admin", "super_admin"],
				body: t.Object({
					action: t.UnionEnum(["keep", "remove"]),
					note: t.Optional(t.String({ maxLength: 500 })),
				}),
				detail: {
					tags: ["Admin"],
					summary: "Rule on a reported item",
					description:
						"Resolves every open report on the same content, not just this " +
						"one — the decision is about the content. `keep` also lifts any " +
						"automatic hold.",
				},
			},
		);
}
