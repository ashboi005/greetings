import { Description, Input, Label, TextField } from "heroui-native";
import { View } from "react-native";

import { useT } from "@/lib/i18n";

/** The three free-text fields printed on a customised greeting (§9). */
export interface DetailsValues {
	displayName: string;
	designation: string;
	contactPhone: string;
}

/** Server limits from `PUT /v1/me/profile` (§3). */
const LIMITS = { displayName: 80, designation: 80, contactPhone: 40 } as const;

/**
 * Name, designation and phone, as entered in onboarding and edited in Profile.
 *
 * `maxLength` enforces the server's limits at the keyboard, so there is no
 * "too long" error to explain after the fact.
 */
export function DetailsFields({
	values,
	onChange,
	isDisabled,
}: {
	values: DetailsValues;
	onChange: (next: DetailsValues) => void;
	isDisabled?: boolean;
}) {
	const t = useT();
	const set = (field: keyof DetailsValues) => (text: string) =>
		onChange({ ...values, [field]: text });

	return (
		<View className="gap-5">
			<TextField isDisabled={isDisabled}>
				<Label>{t("common.fieldName")}</Label>
				<Input
					value={values.displayName}
					onChangeText={set("displayName")}
					placeholder={t("common.fieldNamePlaceholder")}
					maxLength={LIMITS.displayName}
					autoCapitalize="words"
					autoComplete="name"
					textContentType="name"
					className="text-base"
				/>
			</TextField>

			<TextField isDisabled={isDisabled}>
				<Label>{t("common.fieldDesignation")}</Label>
				<Input
					value={values.designation}
					onChangeText={set("designation")}
					placeholder={t("common.fieldDesignationPlaceholder")}
					maxLength={LIMITS.designation}
					autoCapitalize="words"
					textContentType="jobTitle"
					className="text-base"
				/>
			</TextField>

			<TextField isDisabled={isDisabled}>
				<Label>{t("common.fieldPhone")}</Label>
				<Input
					value={values.contactPhone}
					onChangeText={set("contactPhone")}
					placeholder="98765 43210"
					maxLength={LIMITS.contactPhone}
					keyboardType="phone-pad"
					autoComplete="tel"
					textContentType="telephoneNumber"
					className="text-base"
				/>
				<Description className="text-sm">
					{t("common.fieldPhoneHint")}
				</Description>
			</TextField>
		</View>
	);
}

/**
 * The trimmed values, with blanks as `undefined`.
 *
 * `undefined` rather than `""`: the PUT replaces the whole profile, so an
 * omitted field is how a cleared one gets cleared, and the server rejects an
 * empty display name outright.
 */
export function cleanDetails(values: DetailsValues) {
	const clean = (value: string) => value.trim() || undefined;
	return {
		displayName: clean(values.displayName),
		designation: clean(values.designation),
		contactPhone: clean(values.contactPhone),
	};
}
