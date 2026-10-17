import { useState } from "react";
import { Text, View } from "react-native";
import { BannerAd, BannerAdSize } from "react-native-google-mobile-ads";

import { useAdsState } from "@/lib/ads/consent";
import { AD_UNITS } from "@/lib/ads/units";
import { track } from "@/lib/analytics";
import { useT } from "@/lib/i18n";

/**
 * The anchored adaptive banner above the tab bar.
 *
 * Its height is reserved *before* the ad loads. An ad that arrives and pushes
 * the content up moves buttons under the user's finger, and for this audience
 * that means taps landing on the ad — accidental clicks, which AdMob treats as
 * invalid traffic and suspends accounts over.
 *
 * Anchored adaptive banners on a phone in portrait come back 50–60dp tall, so
 * 60 is reserved and the ad is centred in it. The slot collapses only when ads
 * are definitively off (consent refused), which happens once, at launch.
 */
export const BANNER_SLOT_HEIGHT = 60;

export function BannerSlot() {
	const { settled, canRequestAds } = useAdsState();
	const [failed, setFailed] = useState(false);
	const t = useT();

	if (settled && !canRequestAds) return null;

	return (
		<View
			style={{ height: BANNER_SLOT_HEIGHT }}
			className="items-center justify-center border-border border-t bg-surface-secondary"
			accessibilityLabel={t("common.ad")}
		>
			{canRequestAds && !failed ? (
				<BannerAd
					unitId={AD_UNITS.banner}
					size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
					onAdFailedToLoad={(error) => {
						setFailed(true);
						track("ad_banner_failed", {
							// The SDK error carries a numeric `code` it does not type.
							code: String((error as { code?: unknown }).code ?? "unknown"),
						});
					}}
				/>
			) : (
				<Text className="text-muted text-xs">{t("common.ad")}</Text>
			)}
		</View>
	);
}
