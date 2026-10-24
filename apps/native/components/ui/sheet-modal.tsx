import { Ionicons } from "@expo/vector-icons";
import { useThemeColor } from "heroui-native";
import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useT } from "@/lib/i18n";

/**
 * A bottom sheet for a short task: report a greeting, add your name.
 *
 * A plain `Modal` rather than a gesture-driven sheet. These hold a text field,
 * and a sheet that can be dragged half-closed while the keyboard is up is one
 * more way for an unsure user to lose what they typed. Tapping outside or the
 * labelled Close button are the only ways out, and both are obvious.
 *
 * The translucent flags let the keyboard controller see the modal's window on
 * Android, which is what lets the sheet rise above the keyboard there.
 */
export function SheetModal({
	visible,
	title,
	onClose,
	children,
}: {
	visible: boolean;
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const t = useT();
	const insets = useSafeAreaInsets();
	const foreground = useThemeColor("foreground");

	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			onRequestClose={onClose}
			statusBarTranslucent
			navigationBarTranslucent
		>
			<KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
				<Pressable
					onPress={onClose}
					accessibilityLabel={t("common.close")}
					className="flex-1 bg-black/50"
				/>
				<View
					className="rounded-t-3xl bg-background px-5 pt-5"
					style={{ paddingBottom: insets.bottom + 16, maxHeight: "90%" }}
				>
					<View className="mb-4 flex-row items-center gap-2">
						<Text
							className="flex-1 font-heading text-foreground text-xl"
							accessibilityRole="header"
						>
							{title}
						</Text>
						<Pressable
							onPress={onClose}
							accessibilityRole="button"
							accessibilityLabel={t("common.close")}
							hitSlop={8}
							className="size-12 items-center justify-center rounded-full bg-default"
						>
							<Ionicons name="close" size={24} color={foreground} />
						</Pressable>
					</View>
					<ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
						{children}
					</ScrollView>
				</View>
			</KeyboardAvoidingView>
		</Modal>
	);
}
