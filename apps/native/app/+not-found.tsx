import { useRouter } from "expo-router";

import { ActionButton } from "@/components/ui/action-button";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { EmptyState } from "@/components/ui/state-views";
import { useT } from "@/lib/i18n";

/**
 * Reached only through a bad deep link. "Home" goes to the root and lets the
 * auth guard decide where that is for this person right now.
 */
export default function NotFoundScreen() {
	const t = useT();
	const router = useRouter();

	return (
		<SafeAreaView className="flex-1 justify-center bg-background">
			<EmptyState
				icon="compass-outline"
				title={t("common.notFoundTitle")}
				body={t("common.notFoundBody")}
				action={
					<ActionButton
						label={t("common.goHome")}
						icon="home-outline"
						onPress={() => router.replace("/")}
					/>
				}
			/>
		</SafeAreaView>
	);
}
