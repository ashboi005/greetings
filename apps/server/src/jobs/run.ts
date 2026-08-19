/**
 * Job entrypoint (spec §12.5).
 *
 *   bun run jobs schedule             # long-lived: runs `nightly` every day
 *   bun run jobs nightly              # everything a nightly run should do, once
 *   bun run jobs rollup               # recompute yesterday
 *   bun run jobs rollup 2026-08-01    # recompute one date
 *   bun run jobs rollup 2026-08-01 2026-08-07
 *   bun run jobs scores               # recompute feed ranking scores
 *   bun run jobs create-admin         # the first super admin, with a password
 *   bun run jobs cleanup              # orphan drafts and expired keys
 *
 * `schedule` is the one a deployment runs; the rest are the same work available
 * by hand, for backfills and for the moment something has gone wrong at 3am and
 * a person needs to do one step rather than all of them.
 *
 * Every job is idempotent, so a retry after a failure is always safe.
 */

import { createPanelAccount } from "@greetings/auth/accounts";
import { db } from "@greetings/db";
import { refreshFeedScores } from "@greetings/db/feed-score";
import { roleChangeLog, user as userTable } from "@greetings/db/schema";
import { seedSuperAdmin } from "@greetings/db/seed/index";
import { env } from "@greetings/env/server";
import { eq } from "drizzle-orm";
import { requireObjectStorage } from "../lib/storage";
import {
	cleanupOrphanDrafts,
	purgeExpiredIdempotencyKeys,
} from "./cleanup-orphan-drafts";
import { previousDay, rollupDay, rollupRange } from "./rollup-daily-stats";
import { pruneJobRuns, runLocked, runSchedule } from "./schedule";

const [command, ...args] = process.argv.slice(2);

/** Storage, or null when this deployment has no R2 credentials. */
function optionalStorage() {
	try {
		return requireObjectStorage({
			accountId: env.R2_ACCOUNT_ID,
			accessKeyId: env.R2_ACCESS_KEY_ID,
			secretAccessKey: env.R2_SECRET_ACCESS_KEY,
			bucket: env.R2_BUCKET,
		});
	} catch {
		return null;
	}
}

/**
 * Creates the first panel account, or promotes an existing one.
 *
 * Public sign-up is disabled and only a super admin can create panel accounts,
 * which leaves the first one with nobody to create it. This is the way in.
 *
 * It lives here rather than in the database seed because creating a password
 * account needs Better Auth's hasher — and packages/auth already depends on
 * packages/db, so the seed reaching back into auth would be a cycle. apps/server
 * depends on both, so this is where the two can meet.
 */
async function runCreateAdmin(): Promise<void> {
	const email = env.SUPER_ADMIN_EMAIL;
	if (!email) {
		console.error("SUPER_ADMIN_EMAIL is not set.");
		process.exit(1);
	}

	const [existing] = await db
		.select({ id: userTable.id, role: userTable.role })
		.from(userTable)
		.where(eq(userTable.email, email.trim().toLowerCase()))
		.limit(1);

	if (existing) {
		// Already here — promote rather than refuse, so this command is safe to
		// re-run and does the obvious thing for an account made another way.
		const result = await seedSuperAdmin(email);
		console.log(
			result.promoted
				? `Promoted ${email} to super_admin.`
				: `Unchanged: ${result.reason}`,
		);
		return;
	}

	if (!env.SUPER_ADMIN_PASSWORD) {
		console.error(
			`No account for ${email}. Set SUPER_ADMIN_PASSWORD (12+ characters) to create one.`,
		);
		process.exit(1);
	}

	const created = await createPanelAccount({
		email,
		name: "Super admin",
		password: env.SUPER_ADMIN_PASSWORD,
		role: "super_admin",
	});

	if (!created) {
		console.error("That email was taken while this ran. Re-run to promote it.");
		process.exit(1);
	}

	await db.insert(roleChangeLog).values({
		id: crypto.randomUUID(),
		actorId: null,
		targetUserId: created.userId,
		fromRole: "user",
		toRole: "super_admin",
		reason: "Bootstrap super admin (create-admin job)",
		createdAt: new Date(),
	});

	console.log(
		`Created ${email} as super_admin. Sign in, change the password from the ` +
			"panel, then remove SUPER_ADMIN_PASSWORD from the environment.",
	);
}

async function runScores(): Promise<string> {
	const { rows } = await refreshFeedScores();
	const line = `rescored ${rows} published items`;
	console.log(`Refreshed feed ranking scores for ${rows} published items`);
	return line;
}

async function runRollup(): Promise<string> {
	if (args.length === 2 && args[0] && args[1]) {
		const results = await rollupRange(args[0], args[1]);
		console.log(`Rolled up ${results.length} days: ${args[0]} to ${args[1]}`);
		return `rolled up ${results.length} days`;
	}

	const date = args[0] ?? previousDay();
	const result = await rollupDay(date);
	console.log(`Rolled up ${date}: ${result.rows} rows written`);
	return `rolled up ${date} (${result.rows} rows)`;
}

async function runCleanup(): Promise<string> {
	const keys = await purgeExpiredIdempotencyKeys();
	console.log(`Purged ${keys.purged} expired idempotency records`);

	const runs = await pruneJobRuns();

	// Only draft cleanup needs storage. A nightly run should not abort — and
	// leave the rollup half-done — because one optional dependency is missing.
	const storage = optionalStorage();
	if (!storage) {
		console.warn(
			"Skipping orphan draft cleanup: R2 is not configured on this deployment.",
		);
		return `purged ${keys.purged} keys, ${runs.purged} run records; draft cleanup skipped (no R2)`;
	}

	const drafts = await cleanupOrphanDrafts(storage);
	console.log(
		`Deleted ${drafts.draftsDeleted} orphan drafts and ${drafts.objectsDeleted} objects` +
			(drafts.objectsFailed > 0
				? ` (${drafts.objectsFailed} object deletions failed and will be retried)`
				: ""),
	);

	return `purged ${keys.purged} keys, ${runs.purged} run records, ${drafts.draftsDeleted} drafts, ${drafts.objectsDeleted} objects`;
}

/**
 * Everything a night should do, in order.
 *
 * The rollup first, because it reads the raw events the cleanup may prune, and
 * the rescore before the cleanup for the same reason.
 */
async function runNightly(): Promise<string> {
	const parts = [await runRollup(), await runScores(), await runCleanup()];
	return parts.join("; ");
}

switch (command) {
	case "rollup":
		await runRollup();
		break;
	case "cleanup":
		await runCleanup();
		break;
	case "scores":
		await runScores();
		break;
	case "create-admin":
		await runCreateAdmin();
		break;
	case "nightly":
		// Locked and recorded even when run by hand, so a manual run cannot
		// collide with the scheduled one and shows up in the same history.
		await runLocked("nightly", runNightly);
		break;
	case "schedule": {
		const controller = new AbortController();
		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			process.on(signal, () => {
				console.log(`${signal} received, stopping after the current run.`);
				controller.abort();
			});
		}
		await runSchedule(runNightly, { signal: controller.signal });
		break;
	}
	default:
		console.error(
			`Unknown job "${command ?? ""}". Expected: schedule, nightly, rollup, scores, cleanup, create-admin.`,
		);
		process.exit(1);
}

process.exit(0);
