/**
 * The content lifecycle (spec §5).
 *
 *   draft ──submit──▶ pending_review ──approve──▶ published ──remove──▶ removed
 *                           │                        ▲                     │
 *                           └──reject──▶ rejected ───┘ (resubmit)          └──restore──▶ published
 *
 * Every state change goes through `transition()`. Route handlers never write
 * `status` themselves — that is what keeps the rules in one readable place and
 * guarantees an audit row for each move.
 */

import { scoreOne } from "@greetings/db/feed-score";
import type { ContentStatus, ModerationAction } from "@greetings/db/schema";
import { content, moderationActions } from "@greetings/db/schema";
import { and, eq } from "drizzle-orm";
import { conflict, notFound } from "../../lib/errors";

/** Which states each action may be applied from, and where it lands. */
const TRANSITIONS: Record<
	ModerationAction,
	{ from: ContentStatus[]; to: ContentStatus }
> = {
	// Rejected content can be fixed and sent back, so `rejected` is a valid
	// starting point as well as `draft`.
	submit: { from: ["draft", "rejected"], to: "pending_review" },
	approve: { from: ["pending_review"], to: "published" },
	reject: { from: ["pending_review"], to: "rejected" },
	// Removal applies to anything already public, and to something awaiting
	// review that an admin judges should never go live.
	remove: { from: ["published", "pending_review"], to: "removed" },
	restore: { from: ["removed"], to: "published" },
	// A hold does not change status: it hides published content pending review.
	hold: { from: ["published"], to: "published" },
};

export interface TransitionInput {
	contentId: string;
	action: ModerationAction;
	/** Null for automatic system actions, such as the report threshold hold. */
	actorId: string | null;
	reason?: string;
	/** Restricts the change to one designer's own content. */
	requireDesignerId?: string;
}

export interface TransitionResult {
	id: string;
	status: ContentStatus;
	previousStatus: ContentStatus;
}

/**
 * Applies an action, or explains why it cannot apply.
 *
 * Runs inside the caller's transaction so the status change and its audit row
 * commit together — an unexplained state change is worse than none.
 */
export async function transition(
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle's transaction type is not nameable here
	tx: any,
	input: TransitionInput,
): Promise<TransitionResult> {
	const rule = TRANSITIONS[input.action];

	// Locked for the duration: two admins clicking approve at the same moment
	// would otherwise both read `pending_review` and both write an audit row.
	const [current] = await tx
		.select({
			id: content.id,
			status: content.status,
			designerId: content.designerId,
		})
		.from(content)
		.where(
			input.requireDesignerId
				? and(
						eq(content.id, input.contentId),
						eq(content.designerId, input.requireDesignerId),
					)
				: eq(content.id, input.contentId),
		)
		.limit(1)
		.for("update");

	if (!current) throw notFound("No such content.");

	const previousStatus = current.status as ContentStatus;

	if (!rule.from.includes(previousStatus)) {
		throw conflict(
			`Cannot ${input.action} content that is ${previousStatus}.`,
			{ status: previousStatus, allowedFrom: rule.from },
		);
	}

	const now = new Date();
	const patch: Record<string, unknown> = {
		status: rule.to,
		updatedAt: now,
	};

	switch (input.action) {
		case "submit":
			patch.submittedAt = now;
			// Clear the previous verdict so a resubmission is not presented to
			// the reviewer carrying its old rejection.
			patch.rejectionReason = null;
			patch.reviewedAt = null;
			patch.reviewedBy = null;
			break;
		case "approve":
			patch.reviewedAt = now;
			patch.reviewedBy = input.actorId;
			patch.publishedAt = now;
			patch.rejectionReason = null;
			break;
		case "reject":
			patch.reviewedAt = now;
			patch.reviewedBy = input.actorId;
			patch.rejectionReason = input.reason ?? null;
			break;
		case "remove":
			patch.removedAt = now;
			patch.reviewedAt = now;
			patch.reviewedBy = input.actorId;
			break;
		case "restore":
			patch.removedAt = null;
			// A restore resolves whatever hid the item, so clear the hold too.
			patch.visibilityHold = false;
			patch.reviewedAt = now;
			patch.reviewedBy = input.actorId;
			break;
		case "hold":
			patch.visibilityHold = true;
			break;
	}

	await tx.update(content).set(patch).where(eq(content.id, input.contentId));

	// Anything that makes an item visible needs a ranking score before the
	// transaction commits, or it goes live scored zero and sits at the bottom of
	// every feed until the nightly refresh notices it.
	if (rule.to === "published") {
		await scoreOne(tx, input.contentId);
	}

	await tx.insert(moderationActions).values({
		id: crypto.randomUUID(),
		actorId: input.actorId,
		contentId: input.contentId,
		action: input.action,
		reason: input.reason,
		createdAt: now,
	});

	return { id: current.id, status: rule.to, previousStatus };
}

/** Which actions are legal from a given state — used to describe the queue. */
export function availableActions(status: ContentStatus): ModerationAction[] {
	return (Object.keys(TRANSITIONS) as ModerationAction[]).filter((action) =>
		TRANSITIONS[action].from.includes(status),
	);
}
