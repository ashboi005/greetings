import {
	Button,
	Input,
	Label,
	Spinner,
	Surface,
	TextField,
} from "heroui-native";
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useT } from "@/lib/i18n";

/**
 * A small "type something" dialog: a design's title, a name to stamp, a line
 * of text for a design.
 *
 * Anchored near the top of the screen rather than centred, so the keyboard
 * can never cover the field or the buttons — a centred dialog inside a
 * `Modal` is exactly where keyboard avoidance is least reliable on Android.
 */
export function TextPrompt({
	visible,
	title,
	label,
	initialValue = "",
	placeholder,
	multiline,
	maxLength,
	confirmLabel,
	busy,
	onCancel,
	onSubmit,
}: {
	visible: boolean;
	title: string;
	label: string;
	initialValue?: string;
	placeholder?: string;
	multiline?: boolean;
	maxLength: number;
	confirmLabel: string;
	busy?: boolean;
	onCancel: () => void;
	onSubmit: (value: string) => void;
}) {
	const t = useT();
	const insets = useSafeAreaInsets();

	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			statusBarTranslucent
			onRequestClose={onCancel}
		>
			<Pressable
				className="flex-1 bg-black/50 px-4"
				style={{ paddingTop: insets.top + 32 }}
				onPress={onCancel}
				accessible={false}
			>
				{/* Remounted per opening so it starts from `initialValue` each time. */}
				{visible ? (
					<PromptBody
						title={title}
						label={label}
						initialValue={initialValue}
						placeholder={placeholder}
						multiline={multiline}
						maxLength={maxLength}
						confirmLabel={confirmLabel}
						cancelLabel={t("common.cancel")}
						busy={busy}
						onCancel={onCancel}
						onSubmit={onSubmit}
					/>
				) : null}
			</Pressable>
		</Modal>
	);
}

function PromptBody({
	title,
	label,
	initialValue,
	placeholder,
	multiline,
	maxLength,
	confirmLabel,
	cancelLabel,
	busy,
	onCancel,
	onSubmit,
}: {
	title: string;
	label: string;
	initialValue: string;
	placeholder?: string;
	multiline?: boolean;
	maxLength: number;
	confirmLabel: string;
	cancelLabel: string;
	busy?: boolean;
	onCancel: () => void;
	onSubmit: (value: string) => void;
}) {
	const [value, setValue] = useState(initialValue);
	const trimmed = value.trim();
	const submit = () => {
		if (trimmed && !busy) onSubmit(trimmed);
	};

	return (
		// Swallows taps so pressing inside the card does not dismiss it.
		<Pressable onPress={() => {}} accessible={false}>
			<Surface className="gap-4 rounded-2xl p-5">
				<Text className="font-heading text-foreground text-lg">{title}</Text>
				<TextField>
					<Label>{label}</Label>
					<Input
						value={value}
						onChangeText={setValue}
						placeholder={placeholder}
						autoFocus
						multiline={multiline}
						maxLength={maxLength}
						returnKeyType={multiline ? "default" : "done"}
						onSubmitEditing={multiline ? undefined : submit}
						style={multiline ? { minHeight: 96 } : undefined}
						textAlignVertical={multiline ? "top" : "center"}
					/>
				</TextField>
				<View className="flex-row gap-3">
					<Button
						variant="secondary"
						className="min-h-12 flex-1"
						onPress={onCancel}
					>
						<Button.Label>{cancelLabel}</Button.Label>
					</Button>
					<Button
						className="min-h-12 flex-1"
						onPress={submit}
						isDisabled={!trimmed || busy}
					>
						{busy ? (
							<Spinner size="sm" color="default" />
						) : (
							<Button.Label>{confirmLabel}</Button.Label>
						)}
					</Button>
				</View>
			</Surface>
		</Pressable>
	);
}
