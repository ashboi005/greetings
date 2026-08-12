/**
 * User reporting and the automatic hold (spec §10).
 *
 * Reports are the platform's only signal from the people actually looking at
 * the content. The threshold hold exists because an admin cannot be watching
 * continuously: without it, content the community has flagged keeps spreading
 * until someone logs in.
 */

import { db } from "@greetings/db";
import { content, type ReportReason, reports } from "@greetings/db/schema";
import { and, count, eq, gte, sql } from "drizzle-orm";
import {
	conflict,
	isUniqueViolation,
	notFound,
	tooManyRequests,
} from "../../lib/errors";
import { transition } from "../content/lifecycle";

/**
 * Open reports needed before content is hidden pending review.
 *
 * Low enough to react quickly, high enough that a small group cannot silence a
 * designer on their own — a removal still requires an admin.
 */
export const REPORT_HOLD_THRESHOLD = 5;

/** Per-user reporting limits, to keep the queue usable. */
export const REPORT_RATE_LIMIT = 20;
export const REPORT_RATE_WINDOW_MINUTES = 60;

export interface SubmitReportResult {
	id: string;
	status: "open";
	/** True when this report pushed the item over the threshold. */
	heldForReview: boolean;
}

export async function submitReport(input: {
	contentId: string;
	reporterId: string;
	reason: ReportReason;
	note?: string;
}): Promise<SubmitReportResult> {
	const [item] = await db
		.select({ id: content.id, status: content.status })
		.from(content)
		.where(eq(content.id, input.contentId))
		.limit(1);

	if (!item) throw notFound("No such content.");

	// Only live content can be reported. Anything already removed is the
	// outcome the reporter wanted, and a draft was never visible to them.
	if (item.status !== "published") {
		throw conflict("This content is not available to report.", {
			status: item.status,
		});
	}

	await assertWithinRateLimit(input.reporterId);

	const id = crypto.randomUUID();

	try {
		await db.insert(reports).values({
			id,
			contentId: input.contentId,
			reporterId: input.reporterId,
			reason: input.reason,
			note: input.note,
			status: "open",
		});
	} catch (cause) {
		if (isUniqueViolation(cause)) {
			throw conflict("You have already reported this content.");
		}
		throw cause;
	}

	const heldForReview = await applyThresholdHold(input.contentId);

	return { id, status: "open", heldForReview };
}

/**
 * Hides content once enough people have flagged it.
 *
 * Counted and applied inside one transaction that locks the content row, so
 * concurrent reports cannot each observe four and leave the item visible.
 * `transition` refuses a hold on anything not published, which also makes a
 * second hold a no-op rather than a duplicate audit row.
 */
async function applyThresholdHold(contentId: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select({
				id: content.id,
				status: content.status,
				visibilityHold: content.visibilityHold,
			})
			.from(content)
			.where(eq(content.id, contentId))
			.limit(1)
			.for("update");

		if (!locked || locked.visibilityHold || locked.status !== "published") {
			return false;
		}

		const [openRow] = await tx
			.select({ open: count() })
			.from(reports)
			.where(and(eq(reports.contentId, contentId), eq(reports.status, "open")));

		const open = openRow?.open ?? 0;
		if (open < REPORT_HOLD_THRESHOLD) return false;

		await transition(tx, {
			contentId,
			action: "hold",
			// No human decided this; the audit row records the system acting.
			actorId: null,
			reason: `Automatically held after ${open} reports`,
		});

		return true;
	});
}

async function assertWithinRateLimit(reporterId: string): Promise<void> {
	const since = new Date(Date.now() - REPORT_RATE_WINDOW_MINUTES * 60 * 1000);

	const [recentRow] = await db
		.select({ recent: count() })
		.from(reports)
		.where(
			and(eq(reports.reporterId, reporterId), gte(reports.createdAt, since)),
		);

	if ((recentRow?.recent ?? 0) >= REPORT_RATE_LIMIT) {
		throw tooManyRequests(
			`Too many reports. You may submit ${REPORT_RATE_LIMIT} per ${REPORT_RATE_WINDOW_MINUTES} minutes.`,
		);
	}
}

/**
 * Resolves every open report on a piece of content.
 *
 * Keyed by report id because that is what an admin clicks, but the decision is
 * about the content: resolving one report and leaving four open would send the
 * same item straight back to the top of the queue.
 */
export async function resolveReport(input: {
	reportId: string;
	adminId: string;
	action: "keep" | "remove";
	note?: string;
}): Promise<{ contentId: string; resolved: number; contentStatus: string }> {
	return db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({ contentId: reports.contentId, status: reports.status })
			.from(reports)
			.where(eq(reports.id, input.reportId))
			.limit(1);

		if (!candidate) throw notFound("No such report.");

		// The decision applies to the content, not just the clicked report. Lock
		// that shared row first so requests naming different open reports cannot
		// reach opposing verdicts. Every resolver takes locks in this same order,
		// which also avoids a report-row/content-row deadlock.
		await tx
			.select({ id: content.id })
			.from(content)
			.where(eq(content.id, candidate.contentId))
			.limit(1)
			.for("update");

		const [report] = await tx
			.select({ contentId: reports.contentId, status: reports.status })
			.from(reports)
			.where(eq(reports.id, input.reportId))
			.limit(1)
			.for("update");

		if (!report) throw notFound("No such report.");
		if (report.status !== "open") {
			throw conflict("This report has already been resolved.", {
				status: report.status,
			});
		}

		const resolved = await tx
			.update(reports)
			.set({
				status: input.action === "keep" ? "resolved_kept" : "resolved_removed",
				resolvedAt: new Date(),
				resolvedBy: input.adminId,
				resolutionNote: input.note,
			})
			.where(
				and(
					eq(reports.contentId, report.contentId),
					eq(reports.status, "open"),
				),
			)
			.returning({ id: reports.id });

		let contentStatus = "published";

		if (input.action === "remove") {
			const result = await transition(tx, {
				contentId: report.contentId,
				action: "remove",
				actorId: input.adminId,
				reason: input.note ?? "Removed after report review",
			});
			contentStatus = result.status;
		} else {
			// Keeping it means lifting any automatic hold, otherwise the content
			// stays invisible despite the admin having cleared it.
			await tx
				.update(content)
				.set({ visibilityHold: false, updatedAt: new Date() })
				.where(eq(content.id, report.contentId));
		}

		return {
			contentId: report.contentId,
			resolved: resolved.length,
			contentStatus,
		};
	});
}

/** Open reports grouped by content, worst first (spec §10). */
export async function listOpenReports(limit: number) {
	return (
		db
			.select({
				contentId: reports.contentId,
				reportCount: count(reports.id),
				// The id an admin resolves; any open report on the item will do,
				// since resolution applies to all of them.
				latestReportId: sql<string>`(array_agg(${reports.id} ORDER BY ${reports.createdAt} DESC))[1]`,
				firstReportedAt: sql<Date>`min(${reports.createdAt})`,
				reasons: sql<string[]>`array_agg(DISTINCT ${reports.reason}::text)`,
				title: content.title,
				designerId: content.designerId,
				contentStatus: content.status,
				visibilityHold: content.visibilityHold,
			})
			.from(reports)
			.innerJoin(content, eq(content.id, reports.contentId))
			.where(eq(reports.status, "open"))
			.groupBy(
				reports.contentId,
				content.title,
				content.designerId,
				content.status,
				content.visibilityHold,
			)
			// Most-reported first: that is where the harm is concentrated.
			.orderBy(
				sql`count(${reports.id}) DESC`,
				sql`min(${reports.createdAt}) ASC`,
			)
			.limit(limit)
	);
}
