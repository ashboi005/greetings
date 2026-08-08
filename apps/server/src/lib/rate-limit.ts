/**
 * Request rate limiting (spec §12).
 *
 * A fixed-window counter held in this process's memory. That is a deliberate
 * limit, not an oversight: it needs no extra infrastructure, costs nothing per
 * request, and is the right first line for a single-instance deployment. Two
 * consequences to know before scaling out:
 *
 *   - Counters are per instance, so N instances allow N times the limit.
 *   - Counters reset on restart.
 *
 * Neither matters while this runs as one container. When it does not, replace
 * the store with Redis behind the same `RateLimitStore` interface — the call
 * sites do not change.
 *
 * Report submission is limited separately and durably in the moderation module,
 * because that limit protects the admin queue rather than the server, and must
 * survive a restart.
 */

import { env } from "@greetings/env/server";
import { AppError } from "./errors";

export interface RateLimitStore {
	/** Records a hit and returns the count within the current window. */
	hit(key: string, windowSeconds: number): { count: number; resetAt: number };
	clear(): void;
}

export function createMemoryStore(): RateLimitStore {
	const windows = new Map<string, { count: number; resetAt: number }>();
	let lastSweep = Date.now();

	return {
		hit(key, windowSeconds) {
			const now = Date.now();

			// Expired entries are dropped lazily rather than on a timer, so an
			// idle process holds no interval and nothing keeps it alive.
			if (now - lastSweep > 60_000) {
				for (const [existing, window] of windows) {
					if (window.resetAt <= now) windows.delete(existing);
				}
				lastSweep = now;
			}

			const existing = windows.get(key);
			if (existing && existing.resetAt > now) {
				existing.count += 1;
				return existing;
			}

			const fresh = { count: 1, resetAt: now + windowSeconds * 1000 };
			windows.set(key, fresh);
			return fresh;
		},

		clear() {
			windows.clear();
		},
	};
}

/** Shared by every limiter in the process. */
export const defaultStore = createMemoryStore();

export interface RateLimitOptions {
	limit: number;
	windowSeconds: number;
	store?: RateLimitStore;
}

/**
 * Consumes one unit of quota, or throws a 429.
 *
 * The message states the limit rather than just refusing, so a client
 * developer can tell a bug from a deliberate throttle.
 */
export function consume(
	key: string,
	{ limit, windowSeconds, store = defaultStore }: RateLimitOptions,
): void {
	const { count, resetAt } = store.hit(key, windowSeconds);

	if (count > limit) {
		const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
		throw new AppError(
			"RATE_LIMITED",
			`Too many requests. Limit is ${limit} per ${windowSeconds} seconds.`,
			{ retryAfterSeconds: retryAfter },
		);
	}
}

/**
 * Best-effort client address.
 *
 * Behind a proxy the socket address is the proxy's, so the forwarded headers
 * carry the real client — but only a proxy that *overwrites* them makes them
 * trustworthy. Talking to this server directly, a client sets them itself, and
 * a limiter that believes them is no limiter at all: rotate the header each
 * request and nothing ever trips.
 *
 * So the headers are read only when `TRUST_PROXY_HEADERS` says a proxy is in
 * front. Otherwise the socket address is the answer, and where there is no
 * socket to ask — Elysia's `handle()` in tests, for one — everything shares one
 * bucket, which fails towards limiting too much rather than too little.
 *
 * This is the weaker of the two defences either way. Carrier-grade NAT means a
 * single address fronts thousands of real users in this market, so the per-
 * address limit has to be loose enough to be evadable by anyone determined.
 * The ceiling that actually holds under attack is the global one below.
 */
export function clientIp(
	request: Request,
	options: { socketAddress?: string | null; fallback?: string } = {},
): string {
	const fallback = options.fallback ?? "unknown";

	if (env.TRUST_PROXY_HEADERS) {
		const forwarded = request.headers.get("x-forwarded-for");
		if (forwarded) {
			const first = forwarded.split(",")[0]?.trim();
			if (first) return first;
		}

		const cloudflare = request.headers.get("cf-connecting-ip");
		if (cloudflare) return cloudflare;
	}

	return options.socketAddress ?? fallback;
}

/**
 * A ceiling on an expensive operation, regardless of who is asking.
 *
 * Per-address limits are the wrong tool against a determined caller: addresses
 * are cheap and, behind carrier-grade NAT, shared by people who have done
 * nothing wrong. This is the backstop — a cap on how much of a costly thing the
 * process will do per minute in total. Past it, callers are refused quickly
 * with a 429 instead of the server queueing work until it falls over.
 *
 * Set generously: it should never bind in normal operation, only when something
 * has gone wrong.
 */
export function consumeGlobal(
	operation: string,
	options: RateLimitOptions,
): void {
	consume(`global:${operation}`, options);
}
