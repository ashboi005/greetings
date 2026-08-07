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
 * are preferred. They are client-controllable when the server is exposed
 * directly, which is why this is only used for unauthenticated endpoints where
 * the alternative is no limit at all — anything authenticated keys on user id.
 */
export function clientIp(request: Request, fallback = "unknown"): string {
	const forwarded = request.headers.get("x-forwarded-for");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim();
		if (first) return first;
	}

	return request.headers.get("cf-connecting-ip") ?? fallback;
}
