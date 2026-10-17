import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";

import { ActionButton } from "@/components/ui/action-button";
import { GreetingGrid } from "@/components/ui/greeting-grid";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { ScreenHeader } from "@/components/ui/screen-header";
import { EmptyState } from "@/components/ui/state-views";
import { useT } from "@/lib/i18n";
import { getDownloadHistory } from "@/lib/services";

/** The detail screen invalidates this same key after a save or share. */
const DOWNLOADS_KEY = ["downloads"];

/**
 * Saved: everything this person has saved or shared, newest first.
 *
 * One entry per greeting, not per download (§11). Removed greetings stay in
 * the list — it is their own history — and the detail screen handles the 409
 * if they try to save one again.
 */
export default function DownloadsScreen() {
	const t = useT();
	const router = useRouter();

	const query = useInfiniteQuery({
		queryKey: DOWNLOADS_KEY,
		queryFn: ({ pageParam }) => getDownloadHistory(pageParam),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor,
	});

	return (
		<SafeAreaView edges={["top"]} className="flex-1 bg-background">
			<GreetingGrid
				query={query}
				queryKey={DOWNLOADS_KEY}
				source="history"
				toSummary={(item) => ({
					id: item.id,
					title: item.title,
					imageUrl: item.imageUrl,
					designerName: item.designer.name,
				})}
				caption={(item) =>
					item.timesDownloaded > 1
						? t("downloads.timesSaved", { count: item.timesDownloaded })
						: t("downloads.savedOnce")
				}
				header={
					<ScreenHeader
						title={t("downloads.title")}
						subtitle={t("downloads.subtitle")}
					/>
				}
				empty={
					<EmptyState
						icon="bookmark-outline"
						title={t("downloads.emptyTitle")}
						body={t("downloads.emptyBody")}
						action={
							<ActionButton
								label={t("downloads.browse")}
								icon="home-outline"
								onPress={() => router.navigate("/(app)/(tabs)")}
							/>
						}
					/>
				}
			/>
		</SafeAreaView>
	);
}
