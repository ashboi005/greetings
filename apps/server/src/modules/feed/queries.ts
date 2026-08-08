/**
 * Feed and search queries (spec §7).
 *
 * Written as raw SQL rather than the query builder: the scoring expression
 * appears in both the SELECT list and the keyset predicate, and reads far more
 * clearly here than assembled from fragments.
 */

import { db } from "@greetings/db";
import { sql } from "drizzle-orm";
import { WEIGHT_GLOBAL, WEIGHT_LANGUAGE, WEIGHT_REGION } from "./ranking";

/**
 * Inlines a numeric constant into the SQL text.
 *
 * These are compile-time weights, not user input, so there is nothing to
 * parameterise. Binding them made Postgres infer `integer` from the
 * surrounding CASE expression and reject 1.5 outright.
 */
const num = (value: number) => sql.raw(String(value));

export interface FeedRow {
	id: string;
	title: string;
	description: string | null;
	primaryLanguage: string;
	regionCode: string | null;
	downloadCount: number;
	publishedAt: Date;
	designerId: string;
	designerName: string;
	storageKey: string | null;
	score: number;
}

export interface FeedQueryInput {
	regionCode: string | null;
	languageCodes: string[];
	limit: number;
	after?: { score: number; id: string };
}

/**
 * The six groups a viewer divides the catalogue into.
 *
 * Every item falls in exactly one, and within a group the viewer-dependent part
 * of the score is a single constant. That is the whole trick: it means the
 * order *within* a group is the stored `base_score` order, which an index
 * already holds, so each group is a seek-and-read of at most one page's worth
 * of rows rather than a scan of everything published.
 *
 * The bonuses are the same weights as before (language 2.0, own region 1.5,
 * global 1.0), just enumerated rather than computed per row.
 */
type RegionClass = "own" | "global" | "other";

interface Partition {
	bonus: number;
	language: boolean;
	region: RegionClass;
}

const PARTITIONS: Partition[] = [
	{ bonus: WEIGHT_LANGUAGE + WEIGHT_REGION, language: true, region: "own" },
	{ bonus: WEIGHT_LANGUAGE + WEIGHT_GLOBAL, language: true, region: "global" },
	{ bonus: WEIGHT_LANGUAGE, language: true, region: "other" },
	{ bonus: WEIGHT_REGION, language: false, region: "own" },
	{ bonus: WEIGHT_GLOBAL, language: false, region: "global" },
	{ bonus: 0, language: false, region: "other" },
];

/**
 * One page of the ranked feed.
 *
 * The viewer-independent half of every score is already stored on the row, so
 * this reads it rather than computing it — see modules/feed/scores.ts for what
 * that buys and what it costs.
 */
export async function queryFeed(input: FeedQueryInput): Promise<FeedRow[]> {
	// An empty array would make `= ANY` fail to type-infer, and a user who has
	// not onboarded has no languages.
	const languages = input.languageCodes.length > 0 ? input.languageCodes : [""];
	const languageMatch = sql`c.primary_language = ANY(${sql.param(languages)}::text[])`;

	// A viewer with no region has no "own region" group; the predicate below
	// would compare against NULL and match nothing, which is the correct
	// outcome — those items land in "other" instead.
	const ownRegion = input.regionCode
		? sql`c.region_code = ${input.regionCode}::text`
		: sql`FALSE`;
	const otherRegion = input.regionCode
		? sql`c.region_code IS NOT NULL AND c.region_code <> ${input.regionCode}::text`
		: sql`c.region_code IS NOT NULL`;

	// A language-matching group is emitted once per language rather than once
	// with `= ANY`. It reads worse and it is the difference between an index
	// seek and a scan: with an array the planner cannot combine the match with
	// the ordering, so it reads every row in the group and sorts — measured at
	// 200k items, 18ms a branch instead of 0.1ms. Equality on a single value
	// lets it walk the index already in score order and stop at the page.
	//
	// Profiles cap at ten languages, so this is at most thirty-three branches,
	// each reading a page.
	type Branch = Partition & { languageCode: string | null };

	const expanded: Branch[] = [];
	for (const partition of PARTITIONS) {
		if (partition.language) {
			for (const code of languages) {
				expanded.push({ ...partition, languageCode: code });
			}
		} else {
			expanded.push({ ...partition, languageCode: null });
		}
	}

	const branches = expanded.map(({ bonus, language, region, languageCode }) => {
		const languagePredicate = language
			? sql`c.primary_language = ${languageCode}::text`
			: // The negated case has no value to seek on, so it reads the
				// score-ordered index and filters. That terminates quickly because
				// most content is *not* in any one viewer's languages.
				sql`NOT (${languageMatch})`;
		const regionPredicate =
			region === "own"
				? ownRegion
				: region === "global"
					? sql`c.region_code IS NULL`
					: otherRegion;

		// The keyset, translated into this group's terms. Globally the order is
		// by (base + bonus, id); within the group `bonus` is constant, so "after
		// the cursor" is `base <= cursorScore - bonus`. This exists to let the
		// index seek rather than filter as it reads, so it is deliberately
		// inclusive: subtracting a bonus and adding it back is not exact in
		// floating point, and a strict comparison here could drop the very row
		// the next page should start with. The outer query applies the exact
		// test against the score as it was issued.
		const after = input.after
			? sql`AND (c.base_score, c.id) <= (
					${input.after.score - bonus}::double precision,
					${input.after.id}::text
				)`
			: sql``;

		return sql`(
			SELECT
				c.id,
				c.title,
				c.description,
				c.primary_language   AS "primaryLanguage",
				c.region_code        AS "regionCode",
				c.download_count     AS "downloadCount",
				c.published_at       AS "publishedAt",
				c.designer_id        AS "designerId",
				c.primary_asset_key  AS "storageKey",
				c.base_score         AS "baseScore",
				${num(bonus)}::double precision AS bonus
			FROM content c
			WHERE c.status = 'published'
				AND c.visibility_hold = FALSE
				AND ${languagePredicate}
				AND ${regionPredicate}
				${after}
			-- NULLS LAST is not decoration. Postgres reads plain DESC as DESC
			-- NULLS FIRST, which does not match how the index is built, so it
			-- read every row in the group and sorted them — 18ms a branch rather
			-- than 0.2ms. Both columns are NOT NULL, so this changes nothing
			-- about the result, only about whether the index can be used.
			ORDER BY c.base_score DESC NULLS LAST, c.id DESC NULLS LAST
			-- One more than the page, so that after the outer query discards
			-- rows sitting exactly on the cursor this group can still fill its
			-- share of the page.
			LIMIT ${input.limit + 1}
		)`;
	});

	// Each branch returns at most a page, so the merge sorts six pages rather
	// than the catalogue. Any item in the true top N is in its own group's top
	// N, so taking a page from each and re-ranking gives exactly the same answer
	// as scoring everything would — this is an optimisation, not an
	// approximation.
	const result = await db.execute(sql`
		WITH pool AS (
			${sql.join(branches, sql` UNION ALL `)}
		)
		SELECT
			pool.*,
			u.name AS "designerName",
			pool."baseScore" + pool.bonus AS score
		FROM pool
		JOIN "user" u ON u.id = pool."designerId"
		${
			input.after
				? // The exact keyset, against the score as it was issued rather
					// than one reconstructed from a subtraction. Strict here, so no
					// row can repeat across pages.
					sql`WHERE (pool."baseScore" + pool.bonus, pool.id) < (
							${input.after.score}::double precision,
							${input.after.id}::text
						)`
				: sql``
		}
		ORDER BY score DESC, id DESC
		LIMIT ${input.limit}
	`);

	return (
		result.rows as unknown as (Omit<FeedRow, "score"> & { score: string })[]
	).map((row) => ({ ...row, score: Number(row.score) }));
}

export interface SearchQueryInput {
	query?: string;
	tagIds: string[];
	languageCode?: string;
	regionCode?: string;
	limit: number;
	after?: { rank: number; publishedAt: string; id: string };
}

export interface SearchRow extends Omit<FeedRow, "score"> {
	rank: number;
}

/**
 * Search published content (spec §7).
 *
 * Full-text match on the generated tsvector, with a trigram similarity
 * fallback so a misspelling still finds something — the audience is older
 * users typing on phone keyboards, and an empty result for "gud morning" is a
 * failure of the product, not of the user.
 */
export async function querySearch(
	input: SearchQueryInput,
): Promise<SearchRow[]> {
	const term = input.query?.trim();
	const hasTerm = Boolean(term);
	const tagIds = input.tagIds.length > 0 ? input.tagIds : null;

	const result = await db.execute(sql`
		WITH matched AS (
			SELECT
				c.id,
				c.title,
				c.description,
				c.primary_language        AS "primaryLanguage",
				c.region_code             AS "regionCode",
				c.download_count          AS "downloadCount",
				c.published_at            AS "publishedAt",
				c.designer_id             AS "designerId",
				u.name                    AS "designerName",
				c.primary_asset_key       AS "storageKey",
				CASE
					WHEN ${hasTerm} THEN
						GREATEST(
							ts_rank(c.title_tsv, plainto_tsquery('simple', ${term ?? ""})),
							-- Trigram similarity is on a different scale to ts_rank;
							-- halved so an exact word match still outranks a fuzzy one.
							similarity(c.title, ${term ?? ""}) * 0.5
						)
					ELSE 0
				END AS rank
			FROM content c
			JOIN "user" u ON u.id = c.designer_id
			WHERE c.status = 'published'
				AND c.visibility_hold = FALSE
				AND c.published_at IS NOT NULL
				AND (
					NOT ${hasTerm}
					OR c.title_tsv @@ plainto_tsquery('simple', ${term ?? ""})
					-- The percent operator, not similarity(...) > x: only the
					-- operator can use the trigram GIN index. Written the other
					-- way this predicate seq-scans every published row, as
					-- confirmed with EXPLAIN. Threshold is pg_trgm's default of
					-- 0.3; the similarity() call above still scores what it admits.
					OR c.title % ${term ?? ""}
				)
				AND (${input.languageCode ?? null}::text IS NULL
				     OR c.primary_language = ${input.languageCode ?? null}::text)
				AND (${input.regionCode ?? null}::text IS NULL
				     OR c.region_code = ${input.regionCode ?? null}::text)
				AND (
					${sql.param(tagIds)}::text[] IS NULL
					OR EXISTS (
						SELECT 1 FROM content_tags ct
						WHERE ct.content_id = c.id AND ct.tag_id = ANY(${sql.param(tagIds)}::text[])
					)
				)
		)
		SELECT * FROM matched
		${
			input.after
				? sql`WHERE (rank, "publishedAt", id) < (
						${input.after.rank}::double precision,
						${input.after.publishedAt}::timestamp,
						${input.after.id}::text
					)`
				: sql``
		}
		-- Recency is the second key, not the last resort: with no search term
		-- every rank is 0, and ordering by id alone would return an arbitrary
		-- slice rather than the newest content.
		ORDER BY rank DESC, "publishedAt" DESC, id DESC
		LIMIT ${input.limit}
	`);

	return (
		result.rows as unknown as (Omit<SearchRow, "rank"> & { rank: string })[]
	).map((row) => ({ ...row, rank: Number(row.rank) }));
}
