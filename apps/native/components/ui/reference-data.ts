import { useQuery } from "@tanstack/react-query";

import { getLanguages, getRegions, getTags } from "@/lib/services";

/**
 * The three public picker lists (§3).
 *
 * Fetched rather than bundled — admins edit them at runtime — and the server
 * already sends cache headers, so the only caching here is React Query keeping
 * one copy per session so every picker does not refetch on mount.
 */

const REFERENCE_STALE_MS = 30 * 60 * 1000;

export function useLanguages() {
	return useQuery({
		queryKey: ["reference", "languages"],
		queryFn: getLanguages,
		staleTime: REFERENCE_STALE_MS,
	});
}

export function useRegions() {
	return useQuery({
		queryKey: ["reference", "regions"],
		queryFn: getRegions,
		staleTime: REFERENCE_STALE_MS,
	});
}

export function useTags() {
	return useQuery({
		queryKey: ["reference", "tags"],
		queryFn: () => getTags(),
		staleTime: REFERENCE_STALE_MS,
	});
}
