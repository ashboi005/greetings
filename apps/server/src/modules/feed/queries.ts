/**
 * Feed and search queries (spec §7).
 *
 * Written as raw SQL rather than the query builder: the scoring expression
 * appears in both the SELECT list and the keyset predicate, and reads far more
 * clearly here than assembled from fragments.
 */

import { db } from "@greetings/db";
import { sql } from "drizzle-orm";
import {
	bucketToDate,
	POPULARITY_WINDOW_DAYS,
	RECENCY_HALF_LIFE_DAYS,
	WEIGHT_GLOBAL,
	WEIGHT_LANGUAGE,
	WEIGHT_POPULARITY,
	WEIGHT_REGION,
} from "./ranking";

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
	bucket: number;
	limit: number;
	after?: { score: number; id: string };
}

/**
 * One page of the ranked feed.
 *
 * `referenceTime` comes from the caller's bucket, not `now()`, so every page of
 * a paging session scores against the same clock.
 */
export async function queryFeed(input: FeedQueryInput): Promise<FeedRow[]> {
	const reference = bucketToDate(input.bucket);

	// An empty array would make `= ANY` fail to type-infer, and a user who has
	// not onboarded has no languages.
	const languages = input.languageCodes.length > 0 ? input.languageCodes : [""];

	// `db.execute` types rows as Record<string, unknown>; the column list below
	// is the contract, so it is asserted once here rather than field by field.
	const result = await db.execute(sql`
		WITH scored AS (
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
				a.storage_key             AS "storageKey",
				(
					-- sql.param: Drizzle's template flattens a bare array into
					-- separate chunks, which reaches Postgres as a scalar.
					${num(WEIGHT_LANGUAGE)} * (CASE WHEN c.primary_language = ANY(${sql.param(languages)}::text[]) THEN 1 ELSE 0 END)
					+ ${num(WEIGHT_REGION)} * (CASE WHEN ${input.regionCode}::text IS NOT NULL
					                            AND c.region_code = ${input.regionCode}::text THEN 1 ELSE 0 END)
					+ ${num(WEIGHT_GLOBAL)} * (CASE WHEN c.region_code IS NULL THEN 1 ELSE 0 END)
					+ POWER(
						0.5,
						GREATEST(EXTRACT(EPOCH FROM (${reference}::timestamp - c.published_at)), 0)
							/ (${num(RECENCY_HALF_LIFE_DAYS)} * 86400)
					)
					+ ${num(WEIGHT_POPULARITY)} * LN(1 + COALESCE(d.recent, 0))
				) AS score
			FROM content c
			JOIN "user" u ON u.id = c.designer_id
			-- One representative image per item; the feed shows a single tile.
			LEFT JOIN LATERAL (
				SELECT storage_key FROM content_assets
				WHERE content_id = c.id
				ORDER BY created_at ASC
				LIMIT 1
			) a ON TRUE
			LEFT JOIN LATERAL (
				SELECT COUNT(*)::int AS recent
				FROM download_events de
				WHERE de.content_id = c.id
					AND de.created_at > ${reference}::timestamp - (${num(POPULARITY_WINDOW_DAYS)} || ' days')::interval
			) d ON TRUE
			WHERE c.status = 'published'
				AND c.visibility_hold = FALSE
				AND c.published_at IS NOT NULL
		)
		SELECT * FROM scored
		${
			input.after
				? sql`WHERE (score, id) < (${input.after.score}::double precision, ${input.after.id}::text)`
				: sql``
		}
		-- id breaks score ties, so the ordering is total and the keyset above is
		-- exact: no row can be skipped or repeated between pages.
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
				a.storage_key             AS "storageKey",
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
			LEFT JOIN LATERAL (
				SELECT storage_key FROM content_assets
				WHERE content_id = c.id
				ORDER BY created_at ASC
				LIMIT 1
			) a ON TRUE
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
