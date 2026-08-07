/**
 * Job entrypoint, for cron or a scheduled container task.
 *
 *   bun run jobs nightly              # everything a nightly run should do
 *   bun run jobs rollup               # recompute yesterday
 *   bun run jobs rollup 2026-08-01    # recompute one date
 *   bun run jobs rollup 2026-08-01 2026-08-07
 *   bun run jobs cleanup              # orphan drafts and expired keys
 *
 * Every job is idempotent, so a retry after a failure is always safe.
 */

import { env } from "@greetings/env/server";
import { requireObjectStorage } from "../lib/storage";
import {
	cleanupOrphanDrafts,
	purgeExpiredIdempotencyKeys,
} from "./cleanup-orphan-drafts";
import { previousDay, rollupDay, rollupRange } from "./rollup-daily-stats";

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

async function runRollup() {
	if (args.length === 2 && args[0] && args[1]) {
		const results = await rollupRange(args[0], args[1]);
		console.log(`Rolled up ${results.length} days: ${args[0]} to ${args[1]}`);
		return;
	}

	const date = args[0] ?? previousDay();
	const result = await rollupDay(date);
	console.log(`Rolled up ${date}: ${result.rows} rows written`);
}

async function runCleanup() {
	const keys = await purgeExpiredIdempotencyKeys();
	console.log(`Purged ${keys.purged} expired idempotency records`);

	// Only draft cleanup needs storage. A nightly run should not abort — and
	// leave the rollup half-done — because one optional dependency is missing.
	const storage = optionalStorage();
	if (!storage) {
		console.warn(
			"Skipping orphan draft cleanup: R2 is not configured on this deployment.",
		);
		return;
	}

	const drafts = await cleanupOrphanDrafts(storage);
	console.log(
		`Deleted ${drafts.draftsDeleted} orphan drafts and ${drafts.objectsDeleted} objects` +
			(drafts.objectsFailed > 0
				? ` (${drafts.objectsFailed} object deletions failed and will be retried)`
				: ""),
	);
}

switch (command) {
	case "rollup":
		await runRollup();
		break;
	case "cleanup":
		await runCleanup();
		break;
	case "nightly":
		await runRollup();
		await runCleanup();
		break;
	default:
		console.error(
			`Unknown job "${command ?? ""}". Expected: nightly, rollup, cleanup.`,
		);
		process.exit(1);
}

process.exit(0);
