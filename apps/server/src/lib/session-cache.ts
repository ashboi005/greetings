/**
 * A very short-lived cache of resolved sessions (spec §12.6).
 *
 * Resolving a session is two queries — the session row, then the user row — and
 * *every* authenticated request pays them before doing any of its own work.
 * Measured across the API, that was half of all database round trips: most
 * endpoints are one query of real work sitting behind two of authentication.
 *
 * Web requests already avoid this. Better Auth's cookie cache puts the session
 * and user in a signed cookie for five minutes, so a browser request touches no
 * table at all. Mobile clients send a bearer token and have no cookie jar, so
 * they pay in full — and mobile is the entire end-user population.
 *
 * This closes that gap for bearer tokens, on the same principle and with a much
 * tighter bound: **thirty seconds, against the cookie cache's five minutes.**
 *
 * ## What staleness this buys, precisely
 *
 * A cached entry survives changes made elsewhere for up to its TTL. Concretely:
 *
 *   - **Sign-out**: the session row is deleted, but a cached entry would still
 *     authorise. So sign-out is not left to the TTL — any write through Better
 *     Auth's own handler clears the cache (`invalidateAll`).
 *   - **Role change**: `applyRoleChange` already deletes the target's sessions
 *     so a new role takes effect immediately; it now also drops their cached
 *     entries.
 *   - **A session expiring naturally**: the entry carries the session's own
 *     `expiresAt` and is treated as a miss past it, so an expired session is
 *     never served from cache regardless of TTL.
 *
 * What remains is the multi-process case: an invalidation in one instance is
 * invisible to another, so there the bound really is the TTL. Thirty seconds,
 * for a system whose cookie path already accepts five minutes.
 *
 * ## Why not longer
 *
 * Because the win is already almost all captured. A user browsing the feed
 * makes several requests in a few seconds; thirty seconds covers a whole
 * session of scrolling. Going to five minutes would buy very little more and
 * cost ten times the staleness.
 */

import type { UserRole } from "@greetings/db/schema";

export interface CachedSession {
	userId: string;
	email: string;
	name: string;
	role: UserRole;
	/** The session's own expiry, which the TTL can shorten but never extend. */
	expiresAt: number;
}

interface Entry {
	value: CachedSession | null;
	/** When this cache entry stops being trusted. */
	staleAt: number;
}

/** How long a resolved session may be reused without asking the database. */
export const SESSION_CACHE_TTL_MS = 30_000;

/**
 * How long a *failed* lookup is remembered.
 *
 * Shorter, and for a different reason: it stops a client hammering the database
 * with a token that will never resolve. Long enough to blunt a loop, short
 * enough that a client which has just signed in is not told no.
 */
export const SESSION_MISS_TTL_MS = 2_000;

/**
 * Entries this process will hold.
 *
 * A bound rather than an unbounded map: tokens are attacker-supplied, and a
 * cache keyed on them with no ceiling is a memory-exhaustion primitive. When
 * full, the oldest insertions go — a Map iterates in insertion order, which
 * makes this a FIFO in three lines rather than an LRU in thirty. Sessions are
 * short-lived and re-resolve on a miss, so the difference is not worth the code.
 */
export const SESSION_CACHE_MAX = 10_000;

const entries = new Map<string, Entry>();

/** Reads a cached session. Returns undefined for a miss. */
export function readCachedSession(
	token: string,
	now = Date.now(),
): CachedSession | null | undefined {
	const entry = entries.get(token);
	if (!entry) return undefined;

	if (entry.staleAt <= now) {
		entries.delete(token);
		return undefined;
	}

	// The session's own expiry always wins. A cache must be able to shorten a
	// lifetime, never extend one.
	if (entry.value && entry.value.expiresAt <= now) {
		entries.delete(token);
		return undefined;
	}

	return entry.value;
}

export function writeCachedSession(
	token: string,
	value: CachedSession | null,
	now = Date.now(),
): void {
	if (entries.size >= SESSION_CACHE_MAX) {
		// Drop the oldest handful rather than one, so a full cache does not do
		// this on every single insert.
		let dropped = 0;
		for (const key of entries.keys()) {
			entries.delete(key);
			if (++dropped >= 64) break;
		}
	}

	entries.set(token, {
		value,
		staleAt: now + (value ? SESSION_CACHE_TTL_MS : SESSION_MISS_TTL_MS),
	});
}

/** Forgets one user's sessions — used when their role changes. */
export function invalidateUser(userId: string): void {
	for (const [token, entry] of entries) {
		if (entry.value?.userId === userId) entries.delete(token);
	}
}

/**
 * Forgets everything.
 *
 * Called after any write through Better Auth's handler, because sign-out,
 * session revocation and account linking all happen in there and this module
 * cannot tell which. Clearing a cache of a few thousand entries costs
 * microseconds and happens only on auth writes, which are rare next to reads.
 */
export function invalidateAll(): void {
	entries.clear();
}

/** For tests and diagnostics. */
export function cacheSize(): number {
	return entries.size;
}

/**
 * The bearer token on a request, if there is one.
 *
 * Only bearer tokens are cached. A cookie-borne session is already served from
 * Better Auth's signed cookie cache without touching the database, so caching
 * it again would add staleness for no gain.
 */
export function bearerToken(headers: Headers): string | null {
	const authorization = headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) return null;

	const token = authorization.slice(7).trim();
	return token.length > 0 ? token : null;
}
