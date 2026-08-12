import { beforeEach, describe, expect, test } from "bun:test";
import {
	content,
	dailyContentStats,
	downloadEvents,
} from "@greetings/db/schema";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../src/app";
import {
	clearDay,
	previousDay,
	rollupDay,
	rollupRange,
	toStatDate,
} from "../src/jobs/rollup-daily-stats";
import { testDb, truncateAll } from "./db";
import { fakeObjectStorage, fakeTokenVerifier } from "./fakes";
import { authHelper, client, seedReference } from "./helpers";

const firebase = fakeTokenVerifier();
const r2 = fakeObjectStorage();
const app = createApp({
	tokenVerifier: firebase.verifier,
	objectStorage: r2.storage,
});
const api = client(app);
const auth = authHelper(api, firebase);

const DAY = 24 * 60 * 60 * 1000;
const today = () => toStatDate(new Date());
const daysAgo = (n: number) => toStatDate(new Date(Date.now() - n * DAY));

/**
 * Midday UTC, `n` days back.
 *
 * These tests arrange events on a particular calendar day and then assert the
 * rollup for that day. Offsetting from `Date.now()` puts the timestamp an
 * arbitrary number of hours into the day, which is fine until the suite runs
 * near a boundary — `now - 24h + 1h` lands on *today* when the clock reads 23:xx
 * UTC, and eight tests fail for one hour in twenty-four. Anchoring to midday
 * makes the day the test means the day it gets, whenever it runs.
 */
function middayUtc(daysBack: number): Date {
	const day = new Date(Date.now() - daysBack * DAY);
	day.setUTCHours(12, 0, 0, 0);
	return day;
}

let designerId: string;
let designerToken: string;
let adminToken: string;
let superToken: string;

beforeEach(async () => {
	await truncateAll();
	firebase.reset();
	r2.reset();
	await seedReference();

	const designer = await auth.signIn({ role: "designer" });
	designerId = designer.userId;
	designerToken = designer.token;
	adminToken = (await auth.signIn({ role: "admin" })).token;
	superToken = (await auth.signIn({ role: "super_admin" })).token;
});

async function publish(title = "Item", token = designerToken) {
	const created = await api.post("/v1/designer/content", {
		token,
		body: { title, primaryLanguage: "hi" },
	});
	const id = created.body.id as string;

	const url = await api.post(`/v1/designer/content/${id}/upload-url`, {
		token,
		body: { mimeType: "image/jpeg", bytes: 2048 },
	});
	r2.putObject(url.body.storageKey);
	await api.post(`/v1/designer/content/${id}/assets`, {
		token,
		body: { storageKey: url.body.storageKey, width: 1, height: 1 },
	});
	await api.put(`/v1/designer/content/${id}/tags`, {
		token,
		body: { tagIds: ["tag_good-morning"] },
	});
	await api.post(`/v1/designer/content/${id}/submit`, { token });
	await api.post(`/v1/admin/content/${id}/approve`, { token: adminToken });
	return id;
}

/** Writes raw events at a chosen date, standing in for past activity. */
async function events(
	contentId: string,
	ownerId: string,
	rows: { userId: string; region: string | null; daysAgo: number }[],
) {
	await testDb.insert(downloadEvents).values(
		rows.map((row) => ({
			contentId,
			designerId: ownerId,
			userId: row.userId,
			regionCode: row.region,
			source: "feed" as const,
			createdAt: middayUtc(row.daysAgo),
		})),
	);
}

/**
 * Signs in `count` users.
 *
 * Returns an accessor rather than a bare array so tests can index without a
 * non-null assertion on every use, and get a clear failure if they overrun.
 */
async function someUsers(count: number) {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) ids.push((await auth.signIn()).userId);

	return {
		count,
		get(index: number): string {
			const id = ids[index];
			if (!id) throw new Error(`No test user at index ${index}`);
			return id;
		},
	};
}

describe("the rollup job", () => {
	test("aggregates a day's events into per-content, per-region rows", async () => {
		const id = await publish();
		const users = await someUsers(3);
		const [u1, u2, u3] = [users.get(0), users.get(1), users.get(2)];

		await events(id, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u2, region: "IN-MH", daysAgo: 1 },
			{ userId: u3, region: "IN-TN", daysAgo: 1 },
		]);

		await rollupDay(previousDay());

		const rows = await testDb
			.select()
			.from(dailyContentStats)
			.orderBy(dailyContentStats.regionCode);

		expect(rows).toHaveLength(2);
		const mh = rows.find((r) => r.regionCode === "IN-MH");
		expect(mh?.downloads).toBe(3);
		// Three downloads, two people.
		expect(mh?.uniqueUsers).toBe(2);
		expect(rows.find((r) => r.regionCode === "IN-TN")?.downloads).toBe(1);
	});

	test("rollup totals equal a direct aggregation of the same events", async () => {
		// This is the spec's acceptance criterion for M7.
		const a = await publish("A");
		const b = await publish("B");
		const users = await someUsers(6);

		const regions = ["IN-MH", "IN-TN", "IN-KA", null];
		const rows = Array.from({ length: 60 }, (_, i) => ({
			userId: users.get(i % users.count),
			region: regions[i % regions.length] ?? null,
			daysAgo: 1,
		}));
		await events(a, designerId, rows.slice(0, 35));
		await events(b, designerId, rows.slice(35));

		await rollupDay(previousDay());

		const [rolled] = await testDb
			.select({ total: sql<number>`COALESCE(SUM(downloads), 0)::int` })
			.from(dailyContentStats);

		const [raw] = await testDb
			.select({ total: sql<number>`COUNT(*)::int` })
			.from(downloadEvents);

		expect(rolled?.total).toBe(60);
		expect(rolled?.total).toBe(raw?.total);
	});

	test("counts downloads from users who never onboarded", async () => {
		const id = await publish();
		const u1 = (await someUsers(1)).get(0);

		// A null region must not silently vanish from the rollup, or the totals
		// stop matching the events.
		await events(id, designerId, [
			{ userId: u1, region: null, daysAgo: 1 },
			{ userId: u1, region: null, daysAgo: 1 },
		]);

		await rollupDay(previousDay());

		const rows = await testDb.select().from(dailyContentStats);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.regionCode).toBe("");
		expect(rows[0]?.downloads).toBe(2);
	});

	test("re-running produces identical numbers, not doubled ones", async () => {
		const id = await publish();
		const u1 = (await someUsers(1)).get(0);
		await events(id, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
		]);

		await rollupDay(previousDay());
		await rollupDay(previousDay());
		await rollupDay(previousDay());

		const rows = await testDb.select().from(dailyContentStats);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.downloads).toBe(2);
	});

	test("a recomputation reflects events that have since been deleted", async () => {
		const id = await publish();
		const u1 = (await someUsers(1)).get(0);
		await events(id, designerId, [{ userId: u1, region: "IN-MH", daysAgo: 1 }]);

		await rollupDay(previousDay());
		expect(await testDb.select().from(dailyContentStats)).toHaveLength(1);

		// The upsert alone can only add or update; without a prune the stale row
		// would survive and disagree with the events it claims to summarise.
		await testDb.delete(downloadEvents);
		await rollupDay(previousDay());

		expect(await testDb.select().from(dailyContentStats)).toHaveLength(0);
	});

	test("only aggregates the requested day", async () => {
		const id = await publish();
		const u1 = (await someUsers(1)).get(0);
		await events(id, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 2 },
			{ userId: u1, region: "IN-MH", daysAgo: 3 },
		]);

		await rollupDay(previousDay());

		const rows = await testDb.select().from(dailyContentStats);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.downloads).toBe(1);
	});

	test("backfills a range of days", async () => {
		const id = await publish();
		const u1 = (await someUsers(1)).get(0);
		await events(id, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 2 },
			{ userId: u1, region: "IN-MH", daysAgo: 3 },
		]);

		const results = await rollupRange(daysAgo(3), daysAgo(1));

		expect(results).toHaveLength(3);
		const rows = await testDb.select().from(dailyContentStats);
		expect(rows).toHaveLength(3);
	});
});

describe("designer analytics", () => {
	test("combines rolled-up history with today's live events", async () => {
		const id = await publish();
		const users = await someUsers(2);
		const [u1, u2] = [users.get(0), users.get(1)];

		await events(id, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u2, region: "IN-MH", daysAgo: 1 },
		]);
		await rollupDay(previousDay());

		// Today's download has not been rolled up and must still appear — a
		// figure that only moves overnight reads as broken.
		await api.post(`/v1/content/${id}/download`, {
			token: (await auth.signIn()).token,
			body: {},
		});

		const res = await api.get(
			`/v1/designer/analytics/summary?from=${daysAgo(2)}&to=${today()}`,
			{ token: designerToken },
		);

		expect(res.status).toBe(200);
		expect(res.body.totalDownloads).toBe(3);
	});

	test("never counts another designer's downloads", async () => {
		const mine = await publish("Mine");

		const other = await auth.signIn({ role: "designer" });
		const theirs = await publish("Theirs", other.token);

		const u1 = (await someUsers(1)).get(0);
		await events(mine, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
		]);
		await events(theirs, other.userId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
		]);
		await rollupDay(previousDay());

		const res = await api.get(
			`/v1/designer/analytics/summary?from=${daysAgo(2)}&to=${today()}`,
			{ token: designerToken },
		);
		expect(res.body.totalDownloads).toBe(1);

		const theirRes = await api.get(
			`/v1/designer/analytics/summary?from=${daysAgo(2)}&to=${today()}`,
			{ token: other.token },
		);
		expect(theirRes.body.totalDownloads).toBe(2);
	});

	test("a designerId in the query string is ignored", async () => {
		const other = await auth.signIn({ role: "designer" });
		const theirs = await publish("Theirs", other.token);
		const u1 = (await someUsers(1)).get(0);
		await events(theirs, other.userId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
		]);
		await rollupDay(previousDay());

		// There is no request shape that reads another designer's numbers.
		const res = await api.get(
			`/v1/designer/analytics/summary?from=${daysAgo(2)}&to=${today()}&designerId=${other.userId}`,
			{ token: designerToken },
		);
		expect(res.body.totalDownloads).toBe(0);
	});

	test("breaks downloads down by region", async () => {
		const id = await publish();
		const users = await someUsers(2);
		const [u1, u2] = [users.get(0), users.get(1)];
		await events(id, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u2, region: "IN-TN", daysAgo: 1 },
		]);
		await rollupDay(previousDay());

		const res = await api.get(
			`/v1/designer/analytics/by-region?from=${daysAgo(2)}&to=${today()}`,
			{ token: designerToken },
		);

		const rows = res.body as {
			regionCode: string;
			downloads: number;
			regionName: string;
		}[];
		expect(rows[0]?.regionCode).toBe("IN-MH");
		expect(rows[0]?.downloads).toBe(2);
		expect(rows[0]?.regionName).toBe("Maharashtra");
	});

	test("reports downloads per post, most downloaded first", async () => {
		const quiet = await publish("Quiet");
		const popular = await publish("Popular");
		const u1 = (await someUsers(1)).get(0);

		await events(quiet, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
		]);
		await events(popular, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
		]);
		await rollupDay(previousDay());

		const res = await api.get(
			`/v1/designer/analytics/by-content?from=${daysAgo(2)}&to=${today()}`,
			{ token: designerToken },
		);

		const rows = res.body as { contentId: string; downloads: number }[];
		expect(rows[0]?.contentId).toBe(popular);
		expect(rows[0]?.downloads).toBe(3);
	});

	test("returns a day-by-day series", async () => {
		const id = await publish();
		const u1 = (await someUsers(1)).get(0);
		await events(id, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 2 },
			{ userId: u1, region: "IN-MH", daysAgo: 2 },
		]);
		await rollupRange(daysAgo(2), daysAgo(1));

		const res = await api.get(
			`/v1/designer/analytics/timeseries?from=${daysAgo(3)}&to=${today()}`,
			{ token: designerToken },
		);

		const rows = res.body as { date: string; downloads: number }[];
		expect(rows).toHaveLength(2);
		expect(rows[0]?.date).toBe(daysAgo(2));
		expect(rows[0]?.downloads).toBe(2);
		expect(rows[1]?.downloads).toBe(1);
	});

	test("is empty rather than broken when there is no data", async () => {
		const res = await api.get("/v1/designer/analytics/summary", {
			token: designerToken,
		});
		expect(res.status).toBe(200);
		expect(res.body.totalDownloads).toBe(0);
	});
});

describe("platform analytics", () => {
	test("reports totals across all designers", async () => {
		const a = await publish("A");
		const other = await auth.signIn({ role: "designer" });
		const b = await publish("B", other.token);
		const u1 = (await someUsers(1)).get(0);

		await events(a, designerId, [{ userId: u1, region: "IN-MH", daysAgo: 1 }]);
		await events(b, other.userId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
		]);
		await rollupDay(previousDay());

		const res = await api.get(
			`/v1/admin/analytics/overview?from=${daysAgo(2)}&to=${today()}`,
			{ token: superToken },
		);

		expect(res.body.downloadsInRange).toBe(3);
		expect(res.body.publishedContent).toBe(2);
		expect(res.body.totalDesigners).toBe(2);
	});

	test("ranks designers by downloads", async () => {
		const a = await publish("A");
		const other = await auth.signIn({ role: "designer" });
		const b = await publish("B", other.token);
		const u1 = (await someUsers(1)).get(0);

		await events(a, designerId, [{ userId: u1, region: "IN-MH", daysAgo: 1 }]);
		await events(b, other.userId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
		]);
		await rollupDay(previousDay());

		const res = await api.get(
			`/v1/admin/analytics/by-designer?from=${daysAgo(2)}&to=${today()}`,
			{ token: superToken },
		);

		const rows = res.body as { designerId: string; downloads: number }[];
		expect(rows[0]?.designerId).toBe(other.userId);
		expect(rows[0]?.downloads).toBe(2);
	});

	test("an admin cannot reach platform analytics; only a super admin can", async () => {
		expect(
			(await api.get("/v1/admin/analytics/overview", { token: adminToken }))
				.status,
		).toBe(403);
		expect(
			(await api.get("/v1/admin/analytics/overview", { token: superToken }))
				.status,
		).toBe(200);
	});
});

describe("date range handling", () => {
	test("rejects a malformed date", async () => {
		const res = await api.get(
			"/v1/designer/analytics/summary?from=last-tuesday",
			{
				token: designerToken,
			},
		);
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("from");
	});

	test("rejects an impossible calendar date before it reaches Postgres", async () => {
		const res = await api.get(
			"/v1/designer/analytics/summary?from=2026-02-31",
			{ token: designerToken },
		);

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("from");
	});

	test("rejects a reversed range", async () => {
		const res = await api.get(
			`/v1/designer/analytics/summary?from=${today()}&to=${daysAgo(5)}`,
			{ token: designerToken },
		);
		expect(res.status).toBe(400);
	});

	test("rejects an unreasonably long range", async () => {
		const res = await api.get(
			"/v1/designer/analytics/summary?from=2000-01-01&to=2026-01-01",
			{ token: designerToken },
		);
		expect(res.status).toBe(400);
	});

	test("excludes days outside the range", async () => {
		const id = await publish();
		const u1 = (await someUsers(1)).get(0);
		await events(id, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 10 },
		]);
		await rollupRange(daysAgo(10), daysAgo(1));

		const res = await api.get(
			`/v1/designer/analytics/summary?from=${daysAgo(2)}&to=${today()}`,
			{ token: designerToken },
		);
		expect(res.body.totalDownloads).toBe(1);
	});
});

describe("clearing a day", () => {
	test("removes only that date", async () => {
		const id = await publish();
		const u1 = (await someUsers(1)).get(0);
		await events(id, designerId, [
			{ userId: u1, region: "IN-MH", daysAgo: 1 },
			{ userId: u1, region: "IN-MH", daysAgo: 2 },
		]);
		await rollupRange(daysAgo(2), daysAgo(1));

		await clearDay(daysAgo(1));

		const rows = await testDb.select().from(dailyContentStats);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.statDate).toBe(daysAgo(2));
	});
});

describe("content deletion", () => {
	test("rollup rows disappear with their content", async () => {
		const id = await publish();
		const u1 = (await someUsers(1)).get(0);
		await events(id, designerId, [{ userId: u1, region: "IN-MH", daysAgo: 1 }]);
		await rollupDay(previousDay());

		await testDb.delete(content).where(eq(content.id, id));

		expect(await testDb.select().from(dailyContentStats)).toHaveLength(0);
	});
});
