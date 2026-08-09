/**
 * In-process cache for reference data (spec §12.6).
 *
 * Regions, languages and tags are 36, 23 and 38 rows. They change when someone
 * runs a seed script, which is to say approximately never — and every mobile
 * app launch and every panel load asks for all three.
 *
 * Caching them removes those queries entirely. The staleness is real but
 * uninteresting: a newly seeded tag takes up to a minute to appear, and nothing
 * in the product depends on it appearing sooner.
 *
 * A minute rather than forever, so an operator who adds a language does not
 * have to restart the API to see it — the kind of thing that is obvious to
 * whoever wrote the cache and baffling to everyone else.
 */

const TTL_MS = 60_000;

interface Entry<T> {
	value: T;
	staleAt: number;
}

const entries = new Map<string, Entry<unknown>>();

/** In-flight loads, so a cold cache under load does not stampede the database. */
const pending = new Map<string, Promise<unknown>>();

/**
 * Returns cached data, loading it once if needed.
 *
 * The `pending` map is the part that matters under load. Without it, a hundred
 * requests arriving the instant an entry expires would each start their own
 * query — the cache would turn one slow moment into a hundred, which is the
 * opposite of the point.
 */
export async function cachedReference<T>(
	key: string,
	load: () => Promise<T>,
	now = Date.now(),
): Promise<T> {
	const entry = entries.get(key);
	if (entry && entry.staleAt > now) return entry.value as T;

	const inFlight = pending.get(key);
	if (inFlight) return inFlight as Promise<T>;

	const load$ = load()
		.then((value) => {
			entries.set(key, { value, staleAt: Date.now() + TTL_MS });
			return value;
		})
		.finally(() => {
			pending.delete(key);
		});

	pending.set(key, load$);
	return load$;
}

/** Drops everything. Used by tests, and after a seed. */
export function clearReferenceCache(): void {
	entries.clear();
	pending.clear();
}

/**
 * How long a client may reuse this data without asking again.
 *
 * Sent as `Cache-Control` so the request is not made at all: on a slow Indian
 * mobile connection the round trip costs far more than the query it saves.
 * `stale-while-revalidate` lets a client show what it has and refresh behind
 * the scenes, which for a list of Indian states is exactly the right behaviour.
 */
export const REFERENCE_CACHE_CONTROL =
	"public, max-age=300, stale-while-revalidate=3600";
