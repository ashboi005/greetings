/**
 * CLI entrypoint: `bun run db:seed`.
 *
 * Seeds reference data always, and promotes SUPER_ADMIN_EMAIL when set.
 */

import { join } from "node:path";
import dotenv from "dotenv";

// Loaded before anything imports @greetings/env, which validates at import
// time. This script runs with packages/db as its working directory, so the
// server's .env is not picked up automatically. Resolved from this file rather
// than the cwd so it works however the script is invoked.
dotenv.config({ path: join(import.meta.dir, "../../../../apps/server/.env") });

// Dynamic imports: static ones are hoisted above the dotenv call and would
// read the environment before it is populated.
const { env } = await import("@greetings/env/server");
const { seedReferenceData, seedSuperAdmin } = await import("./index");

const counts = await seedReferenceData();
console.log(
	`Seeded ${counts.regions} regions, ${counts.languages} languages and ${counts.tags} tags.`,
);

if (env.SUPER_ADMIN_EMAIL) {
	const result = await seedSuperAdmin(env.SUPER_ADMIN_EMAIL);
	console.log(
		result.promoted
			? `Promoted ${env.SUPER_ADMIN_EMAIL} to super_admin.`
			: `Super admin unchanged: ${result.reason}`,
	);
} else {
	console.log("SUPER_ADMIN_EMAIL not set — skipping super admin promotion.");
}

process.exit(0);
