/**
 * CLI: `bun run db:seed:demo [--clear]`
 *
 * Demo data only. Reference data comes from `db:seed`, which is safe in
 * production; this is not.
 */

import { join } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: join(import.meta.dir, "../../../../apps/server/.env") });

const { clearDemoData, seedDemoData } = await import("./demo");

if (process.argv.includes("--clear")) {
	await clearDemoData();
	console.log("Demo data removed.");
} else {
	const result = await seedDemoData();
	console.log(
		`Seeded ${result.designers} designers, ${result.readers} readers, ` +
			`${result.content} published items and ${result.downloads} downloads.`,
	);
}

process.exit(0);
