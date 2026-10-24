import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ActionButton } from "@/components/ui/action-button";
import { SheetModal } from "@/components/ui/sheet-modal";
import { useAuth } from "@/contexts/auth-context";
import { track } from "@/lib/analytics";
import { friendlyError, isGone } from "@/lib/errors";
import { deleteFirebaseUser } from "@/lib/firebase";
import { useI18n } from "@/lib/i18n";
import { deleteAccount } from "@/lib/services";

/**
 * "Delete my account" at the bottom of Profile (Google Play requires it).
 *
 * A quiet text link rather than a big red button: it must be easy to find for
 * someone looking for it and hard to hit by accident for everyone else. The
 * sheet then says plainly what will be lost before anything happens, and the
 * safe choice ("Keep my account") is the one that needs no thought.
 *
 * No navigation on success: signing out clears the session, and the guard in
 * contexts/auth-context.tsx takes the person back to sign-in.
 */
export function DeleteAccountLink() {
	const { t, language } = useI18n();
	const { signOut } = useAuth();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const close = () => {
		if (busy) return;
		setOpen(false);
		setError(null);
	};

	const confirm = async () => {
		setBusy(true);
		setError(null);
		try {
			await deleteAccount();
		} catch (cause) {
			// The shared mapper reads a 404 as "this greeting is gone", which is
			// nonsense here; any failure other than being offline is generic.
			setError(
				isGone(cause)
					? t("common.somethingWrong")
					: friendlyError(cause, t, language),
			);
			setBusy(false);
			return;
		}
		track("account_deleted");
		await deleteFirebaseUser();
		await signOut();
	};

	return (
		<>
			<Pressable
				onPress={() => setOpen(true)}
				accessibilityRole="button"
				className="min-h-12 items-center justify-center"
			>
				{/* Full width + simple breaking: Android otherwise mismeasures the
				    Hindi label and clips it to "मेरा अकाउंट". */}
				<Text
					className="w-full text-center text-base text-danger underline"
					textBreakStrategy="simple"
				>
					{t("profile.deleteAccount")}
				</Text>
			</Pressable>

			<SheetModal
				visible={open}
				title={t("profile.deleteTitle")}
				onClose={close}
			>
				<View className="gap-4">
					<Text className="text-base text-foreground leading-6">
						{t("profile.deleteBody")}
					</Text>
					{error ? (
						<Text className="text-base text-danger">{error}</Text>
					) : null}
					<ActionButton
						label={t("profile.deleteKeep")}
						variant="secondary"
						onPress={close}
						isDisabled={busy}
					/>
					<ActionButton
						label={t("profile.deleteConfirm")}
						icon="trash-outline"
						variant="danger-soft"
						onPress={() => void confirm()}
						isLoading={busy}
					/>
				</View>
			</SheetModal>
		</>
	);
}
