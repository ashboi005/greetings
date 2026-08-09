/**
 * Database round trips per endpoint (spec §12.6).
 *
 *   bun run bench
 *
 * Not a `.test.ts`, so the suite does not run it. It exists because "is this
 * fast" is not a judgement to make by reading code: this counts the statements
 * each endpoint actually issues, warm, which is the state a running server
 * spends its life in. An N+1 shows up here as a number that climbs with the
 * data; a forgotten round trip shows up as a 2 where a 1 would do.
 */

import "dotenv/config";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.TRUST_PROXY_HEADERS = "true";
const { queryCount, resetQueryCount } = await import(
	"@greetings/db/query-counter"
);
const { createApp } = await import("../src/app");
const { fakeObjectStorage, fakeTokenVerifier } = await import("./fakes");
const { authHelper, client, seedReference } = await import("./helpers");
const { truncateAll } = await import("./db");
await truncateAll();
await seedReference();
const firebase = fakeTokenVerifier();
const r2 = fakeObjectStorage();
const app = createApp({
	tokenVerifier: firebase.verifier,
	objectStorage: r2.storage,
});
const api = client(app);
const auth = authHelper(api, firebase);
const designer = await auth.signIn({ role: "designer" });
const admin = await auth.signIn({ role: "super_admin" });
const reader = await auth.signIn();
if (designer.role !== "designer") throw new Error("role setup failed");
await api.put("/v1/me/profile", {
	token: reader.token,
	body: { regionCode: "IN-MH", languages: ["hi"] },
});
const created = await api.post("/v1/designer/content", {
	token: designer.token,
	body: { title: "Bench item", primaryLanguage: "hi" },
});
const id = created.body.id;
const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
	token: designer.token,
	body: { mimeType: "image/jpeg", bytes: 2048 },
});
r2.putObject(url.body.storageKey);
await api.post(`/v1/designer/content/${id}/assets`, {
	token: designer.token,
	body: { storageKey: url.body.storageKey, width: 1, height: 1 },
});
await api.put(`/v1/designer/content/${id}/tags`, {
	token: designer.token,
	body: { tagIds: ["tag_good-morning"] },
});
await api.post(`/v1/designer/content/${id}/submit`, { token: designer.token });
await api.post(`/v1/admin/content/${id}/approve`, { token: admin.token });
const cases: [string, () => Promise<{ status: number }>][] = [
	["GET  /v1/feed", () => api.get("/v1/feed", { token: reader.token })],
	[
		"GET  /v1/search",
		() => api.get("/v1/search?q=Bench", { token: reader.token }),
	],
	["GET  /v1/regions", () => api.get("/v1/regions", { token: reader.token })],
	[
		"GET  /v1/languages",
		() => api.get("/v1/languages", { token: reader.token }),
	],
	["GET  /v1/tags", () => api.get("/v1/tags", { token: reader.token })],
	[
		"GET  /v1/me/profile",
		() => api.get("/v1/me/profile", { token: reader.token }),
	],
	["GET  /v1/auth/me", () => api.get("/v1/auth/me", { token: reader.token })],
	[
		"PUT  /v1/me/profile",
		() =>
			api.put("/v1/me/profile", {
				token: reader.token,
				body: { regionCode: "IN-MH", languages: ["hi", "mr"] },
			}),
	],
	[
		"POST /v1/content/:id/download",
		() => api.post(`/v1/content/${id}/download`, { token: reader.token }),
	],
	[
		"POST /v1/designer/content",
		() =>
			api.post("/v1/designer/content", {
				token: designer.token,
				body: { title: "x", primaryLanguage: "hi", regionCode: "IN-MH" },
			}),
	],
	[
		"GET  /v1/designer/content",
		() => api.get("/v1/designer/content", { token: designer.token }),
	],
	[
		"GET  /v1/designer/content/:id",
		() => api.get(`/v1/designer/content/${id}`, { token: designer.token }),
	],
	[
		"GET  /v1/designer/analytics/summary",
		() => api.get("/v1/designer/analytics/summary", { token: designer.token }),
	],
	[
		"GET  /v1/admin/content/queue",
		() =>
			api.get("/v1/admin/content/queue?status=published", {
				token: admin.token,
			}),
	],
	[
		"GET  /v1/admin/content",
		() => api.get("/v1/admin/content", { token: admin.token }),
	],
	[
		"GET  /v1/admin/content/:id",
		() => api.get(`/v1/admin/content/${id}`, { token: admin.token }),
	],
	[
		"GET  /v1/admin/content/:id/audit",
		() => api.get(`/v1/admin/content/${id}/audit`, { token: admin.token }),
	],
	[
		"GET  /v1/admin/users",
		() => api.get("/v1/admin/users", { token: admin.token }),
	],
	[
		"GET  /v1/admin/reports",
		() => api.get("/v1/admin/reports", { token: admin.token }),
	],
	[
		"GET  /v1/admin/analytics/overview",
		() => api.get("/v1/admin/analytics/overview", { token: admin.token }),
	],
	[
		"GET  /v1/admin/audit/actions",
		() => api.get("/v1/admin/audit/actions", { token: admin.token }),
	],
];
for (const [, run] of cases) await run();
console.log(`${"endpoint".padEnd(38)} ${"queries".padStart(7)}`);
console.log("-".repeat(47));

let total = 0;
let worst = 0;
for (const [label, run] of cases) {
	resetQueryCount();
	const res = await run();
	if (res.status >= 400) throw new Error(`${label} returned ${res.status}`);
	// Both Pool.query and Client.query are patched and pg-pool delegates one to
	// the other, so each logical statement is recorded twice.
	const queries = queryCount() / 2;
	total += queries;
	worst = Math.max(worst, queries);
	console.log(`${label.padEnd(38)} ${String(queries).padStart(7)}`);
}

console.log("-".repeat(47));
console.log(`${"TOTAL".padEnd(38)} ${String(total).padStart(7)}`);
console.log(`${"WORST".padEnd(38)} ${String(worst).padStart(7)}`);
process.exit(0);
