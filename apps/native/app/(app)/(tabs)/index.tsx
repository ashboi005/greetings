import { useInfiniteQuery } from "@tanstack/react-query";

import { feedSummary, GreetingGrid } from "@/components/ui/greeting-grid";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { ScreenHeader } from "@/components/ui/screen-header";
import { EmptyState } from "@/components/ui/state-views";
import { useAuth } from "@/contexts/auth-context";
import { useT } from "@/lib/i18n";
import { getFeed } from "@/lib/services";

const FEED_KEY = ["feed"];

/**
 * Home: the personalised feed.
 *
 * The ranking always includes global content, so the feed is never empty for
 * lack of local greetings (§4) — the empty state here only ever means the
 * server has nothing published at all, which in practice is a fresh deployment.
 */
export default function FeedScreen() {
	const t = useT();
	const { userProfile } = useAuth();

	const query = useInfiniteQuery({
		queryKey: FEED_KEY,
		queryFn: ({ pageParam }) => getFeed(pageParam),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor,
	});

	const name = userProfile?.displayName;

	return (
		<SafeAreaView edges={["top"]} className="flex-1 bg-background">
			<GreetingGrid
				query={query}
				queryKey={FEED_KEY}
				source="feed"
				toSummary={feedSummary}
				header={
					<ScreenHeader
						title={name ? t("feed.helloName", { name }) : t("feed.hello")}
						subtitle={t("feed.subtitle")}
					/>
				}
				empty={
					<EmptyState
						icon="images-outline"
						title={t("feed.emptyTitle")}
						body={t("feed.emptyBody")}
					/>
				}
			/>
		</SafeAreaView>
	);
}
