import type { SkImage } from "@shopify/react-native-skia";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { Spinner, useThemeColor, useToast } from "heroui-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
	AlignRow,
	CanvasArea,
	COLOR_NAMES,
	FontRow,
	HeaderButton,
	Segmented,
	SizeRow,
	SwatchRow,
	ToggleRow,
} from "@/components/canvas/controls";
import {
	buildElement,
	renderScene,
	type SceneAssets,
} from "@/components/canvas/draw";
import { useFontProvider } from "@/components/canvas/fonts";
import {
	type AlignId,
	clamp,
	DESIGN_UNITS,
	type FontId,
	MAX_SCALE,
	MIN_SCALE,
	type Placement,
	type Scene,
	type SceneElement,
	SWATCHES,
	type TextElement,
	type TextRun,
} from "@/components/canvas/scene";
import { SceneCanvas } from "@/components/canvas/scene-canvas";
import { TextPrompt } from "@/components/canvas/text-prompt";
import { useSkImage } from "@/components/canvas/use-sk-image";
import { ActionButton } from "@/components/ui/action-button";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { EmptyState } from "@/components/ui/state-views";
import { useAuth } from "@/contexts/auth-context";
import { track } from "@/lib/analytics";
import { transformImageUrl } from "@/lib/api";
import { friendlyError, isGone } from "@/lib/errors";
import { useI18n } from "@/lib/i18n";
import {
	ensureGalleryPermission,
	fetchGreeting,
	loadSkImage,
	saveOrShareGreeting,
	saveToGallery,
	shareImage,
	writeJpeg,
} from "@/lib/media";
import type { DownloadSource } from "@/lib/services";

/**
 * Customize & Share: the user's name, and optionally designation, phone and
 * logo, stamped onto a greeting so it doubles as a business card (§9).
 *
 * Editing happens on a CDN-resized copy; the counted download and the
 * full-resolution original are fetched only when the person actually saves
 * or shares, and the export is composed at the original's pixel size by the
 * same renderer the editor uses. Nothing about the layout is persisted — it
 * applies to this share only.
 */

const TEXT_ID = "details";
const LOGO_ID = "logo";
const DEFAULT_COLOR = SWATCHES[0];

/** Gap from the canvas edge for the default bottom-right placement. */
const MARGIN = 0.04 * DESIGN_UNITS;

/**
 * The editing copy. No `format=auto`: Cloudflare would pick a format from the
 * request's Accept header, and Skia's fetch is not a browser — keeping the
 * stored format (WebP) guarantees something Skia can decode.
 */
const PREVIEW_TRANSFORM = "width=1080,quality=90,fit=scale-down";
const LOGO_TRANSFORM = "width=512,fit=scale-down";

type ShareSource = "feed" | "search" | "detail" | "history";
type Tab = "details" | "style" | "size";
type Busy = "save" | "share" | null;

function toShareSource(value: string | undefined): ShareSource {
	return value === "feed" || value === "search" || value === "history"
		? value
		: "detail";
}

/** The API knows no "history": a re-save from history is a detail-page save. */
function toDownloadSource(source: ShareSource): DownloadSource {
	return source === "history" ? "detail" : source;
}

export default function CustomizeScreen() {
	const params = useLocalSearchParams<{
		id: string;
		imageUrl?: string;
		title?: string;
		source?: string;
	}>();
	const { t, language } = useI18n();
	const router = useRouter();
	const navigation = useNavigation();
	const { toast } = useToast();
	const queryClient = useQueryClient();
	const { userProfile } = useAuth();
	const accent = useThemeColor("accent");

	const contentId = params.id;
	const source = toShareSource(params.source);
	const title = params.title ?? t("common.appName");

	const fonts = useFontProvider();
	const background = useSkImage(
		transformImageUrl(params.imageUrl, PREVIEW_TRANSFORM),
	);
	const avatarUrl = userProfile?.avatarUrl ?? null;
	const logo = useSkImage(transformImageUrl(avatarUrl, LOGO_TRANSFORM));

	const profileName = userProfile?.displayName?.trim() || null;
	const designation = userProfile?.designation?.trim() || null;
	const phone = userProfile?.contactPhone?.trim() || null;
	const [typedName, setTypedName] = useState<string | null>(null);
	const [namePromptOpen, setNamePromptOpen] = useState(false);
	const name = profileName ?? typedName;

	const [showDesignation, setShowDesignation] = useState(true);
	// Off by default: a number burned into a forwarded image is permanent (§9).
	const [showPhone, setShowPhone] = useState(false);
	const [showLogo, setShowLogo] = useState(true);
	const [color, setColor] = useState<string>(DEFAULT_COLOR);
	const [font, setFont] = useState<FontId>("poppins");
	const [backdrop, setBackdrop] = useState(false);
	const [align, setAlign] = useState<AlignId>("right");
	// null means "the default corner", recomputed as the block changes size.
	const [textPos, setTextPos] = useState<Placement | null>(null);
	const [logoPos, setLogoPos] = useState<Placement | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("details");
	const [step, setStep] = useState<"edit" | "preview">("edit");
	const [busy, setBusy] = useState<Busy>(null);

	const hasDesignation = Boolean(designation);
	const hasPhone = Boolean(phone);
	const logoImage = logo.state.image;
	const logoOn = showLogo && logoImage !== null;
	const designationOn = showDesignation && hasDesignation;
	const phoneOn = showPhone && hasPhone;

	// Back from the preview returns to editing rather than leaving the screen.
	useEffect(
		() =>
			navigation.addListener("beforeRemove", (e) => {
				if (step !== "preview" || busy) return;
				e.preventDefault();
				setStep("edit");
			}),
		[navigation, step, busy],
	);

	const fontProvider =
		fonts.state.status === "ready" ? fonts.state.provider : null;
	const backgroundImage = background.state.image;

	const scene = useMemo((): Scene | null => {
		if (!fontProvider || !backgroundImage || !name) return null;
		const runs: TextRun[] = [{ text: name, size: 1, bold: true }];
		if (designationOn && designation) {
			runs.push({ text: designation, size: 0.68, bold: false });
		}
		if (phoneOn && phone) runs.push({ text: phone, size: 0.68, bold: false });

		const text: TextElement = {
			id: TEXT_ID,
			type: "text",
			runs,
			color,
			font,
			align,
			backdrop,
			x: 0.5,
			y: 0.5,
			scale: 1,
		};
		const canvasHeight =
			(DESIGN_UNITS * backgroundImage.height()) / backgroundImage.width();
		// Built only to measure; the canvas builds its own to draw.
		const textSize = buildElement(text, { fonts: fontProvider, logo: null });
		textSize.picture.dispose();
		const defaultText = cornerPlacement(textSize, canvasHeight);
		const placedText = { ...text, ...(textPos ?? defaultText) };

		const elements: SceneElement[] = [placedText];
		if (logoOn) {
			const logoSize = buildElement(
				{ id: LOGO_ID, type: "logo", x: 0, y: 0, scale: 1 },
				{ fonts: fontProvider, logo: logoImage },
			);
			logoSize.picture.dispose();
			const textTop =
				placedText.y * canvasHeight - (textSize.height * placedText.scale) / 2;
			elements.push({
				id: LOGO_ID,
				type: "logo",
				...(logoPos ?? logoAbove(logoSize, textTop, canvasHeight)),
			});
		}
		return {
			background: { color: "#000000", image: { fit: "cover" } },
			elements,
		};
	}, [
		fontProvider,
		backgroundImage,
		logoImage,
		name,
		designation,
		phone,
		designationOn,
		phoneOn,
		logoOn,
		color,
		font,
		align,
		backdrop,
		textPos,
		logoPos,
	]);

	const assets: SceneAssets | null =
		fontProvider && backgroundImage
			? { fonts: fontProvider, background: backgroundImage, logo: logoImage }
			: null;

	const sizeTarget = selectedId === LOGO_ID && logoOn ? LOGO_ID : TEXT_ID;

	const commit = (id: string, placement: Placement) => {
		if (id === LOGO_ID) setLogoPos(placement);
		else setTextPos(placement);
	};

	/** Scales the logo when it is selected, otherwise the text block. */
	const resize = (factor: number) => {
		const id = sizeTarget;
		const current = scene?.elements.find((el) => el.id === id);
		if (!current) return;
		commit(id, {
			x: current.x,
			y: current.y,
			scale: clamp(current.scale * factor, MIN_SCALE, MAX_SCALE),
		});
	};

	const exportImage = async (action: "save" | "share") => {
		if (!scene || !assets || busy) return;
		setBusy(action);
		let original: SkImage | null = null;
		let composed: SkImage | null = null;
		try {
			// Permission first: the download below is counted, and must not be
			// recorded for a save that is about to be refused.
			if (action === "save") await ensureGalleryPermission();
			// Counted download, flagged as customised — the only signal the server
			// gets that this feature is used (§9). Then the full-size original.
			const file = await fetchGreeting(contentId, {
				source: toDownloadSource(source),
				customized: true,
			});
			original = await loadSkImage(file);
			composed = renderScene(scene, original.width(), original.height(), {
				...assets,
				background: original,
			});
			const jpeg = writeJpeg(composed, `custom-${contentId}`);
			if (action === "save") {
				await saveToGallery(jpeg);
				track("image_saved", { customized: true, source });
				toast.show({ variant: "success", label: t("editor.savedToast") });
			} else {
				await shareImage(jpeg, title);
				track("image_shared", { customized: true, source });
			}
			track("customize_exported", {
				action,
				kept_designation: designationOn,
				kept_phone: phoneOn,
				kept_logo: logoOn,
				moved_text: textPos !== null,
				changed_color: color !== DEFAULT_COLOR,
				font,
			});
			void queryClient.invalidateQueries({ queryKey: ["downloads"] });
		} catch (cause) {
			toast.show({
				variant: "danger",
				label: friendlyError(cause, t, language),
			});
			// The detail screen underneath shows the same dead greeting, so
			// leave both rather than land on buttons that will 409 again (§7).
			if (isGone(cause)) router.dismissTo("/(app)/(tabs)");
		} finally {
			original?.dispose();
			composed?.dispose();
			setBusy(null);
		}
	};

	const sharePlain = async () => {
		if (busy) return;
		setBusy("share");
		try {
			await saveOrShareGreeting(contentId, "share", {
				source: toDownloadSource(source),
				title,
			});
			track("image_shared", { customized: false, source });
			void queryClient.invalidateQueries({ queryKey: ["downloads"] });
		} catch (cause) {
			toast.show({
				variant: "danger",
				label: friendlyError(cause, t, language),
			});
			if (isGone(cause)) router.dismissTo("/(app)/(tabs)");
		} finally {
			setBusy(null);
		}
	};

	const header = (
		<View className="flex-row items-center justify-between px-2">
			<HeaderButton
				icon="chevron-back"
				label={step === "preview" ? t("editor.edit") : t("common.back")}
				disabled={busy !== null}
				onPress={() => (step === "preview" ? setStep("edit") : router.back())}
			/>
			<Text
				className="flex-1 pr-4 text-right font-heading text-foreground text-lg"
				numberOfLines={1}
				accessibilityRole="header"
			>
				{step === "preview"
					? t("editor.previewTitle")
					: t("editor.customizeTitle")}
			</Text>
		</View>
	);

	let body: ReactNode;
	if (!params.imageUrl) {
		body = (
			<EmptyState
				icon="image-outline"
				title={t("common.noLongerAvailable")}
				action={
					<ActionButton
						label={t("common.back")}
						icon="chevron-back"
						variant="secondary"
						onPress={() => router.back()}
					/>
				}
			/>
		);
	} else if (!name) {
		body = (
			<EmptyState
				icon="person-circle-outline"
				title={t("editor.nameNeededTitle")}
				body={t("editor.nameNeededBody")}
				action={
					<View className="gap-3">
						<ActionButton
							label={t("editor.typeName")}
							icon="create-outline"
							onPress={() => setNamePromptOpen(true)}
						/>
						<ActionButton
							label={t("editor.shareWithoutName")}
							icon="share-social-outline"
							variant="secondary"
							isLoading={busy === "share"}
							onPress={sharePlain}
						/>
						<Text className="text-center text-muted text-sm">
							{t("editor.nameProfileHint")}
						</Text>
					</View>
				}
			/>
		);
	} else if (
		fonts.state.status === "error" ||
		background.state.status === "error"
	) {
		body = (
			<EmptyState
				icon="cloud-offline-outline"
				title={t("editor.imageFailed")}
				action={
					<ActionButton
						label={t("common.retry")}
						icon="refresh"
						variant="secondary"
						onPress={() => {
							if (fonts.state.status === "error") fonts.retry();
							if (background.state.status === "error") background.retry();
						}}
					/>
				}
			/>
		);
	} else if (!scene || !assets || !backgroundImage) {
		body = (
			<View className="flex-1 items-center justify-center gap-3">
				<Spinner />
				<Text className="text-base text-muted">{t("editor.loading")}</Text>
			</View>
		);
	} else {
		const aspect = backgroundImage.width() / backgroundImage.height();
		const canvas = (
			<CanvasArea aspect={aspect}>
				{(w, h) => (
					<SceneCanvas
						scene={scene}
						width={w}
						height={h}
						assets={assets}
						selectedId={selectedId}
						onSelect={setSelectedId}
						onCommit={commit}
						interactive={step === "edit" && busy === null}
						selectionColor={accent}
						accessibilityLabel={t("editor.canvasLabel")}
					/>
				)}
			</CanvasArea>
		);

		body =
			step === "preview" ? (
				<>
					{canvas}
					<View className="gap-3 px-4 pt-2 pb-3">
						{phoneOn ? (
							<View className="gap-2 rounded-xl border border-border bg-surface-secondary p-3">
								<Text className="text-base text-foreground">
									{t("editor.phoneWarning")}
								</Text>
								<ActionButton
									label={t("editor.removePhone")}
									icon="eye-off-outline"
									variant="tertiary"
									size="md"
									isDisabled={busy !== null}
									onPress={() => setShowPhone(false)}
								/>
							</View>
						) : (
							<Text className="text-center text-base text-muted">
								{t("editor.previewBody")}
							</Text>
						)}
						<View className="flex-row gap-3">
							<ActionButton
								className="flex-1"
								label={t("editor.saveToPhone")}
								icon="download-outline"
								variant="secondary"
								isLoading={busy === "save"}
								isDisabled={busy !== null}
								onPress={() => exportImage("save")}
							/>
							<ActionButton
								className="flex-1"
								label={t("editor.share")}
								icon="share-social"
								isLoading={busy === "share"}
								isDisabled={busy !== null}
								onPress={() => exportImage("share")}
							/>
						</View>
					</View>
				</>
			) : (
				<>
					{canvas}
					<Text className="px-4 pb-2 text-center text-muted text-sm">
						{t("editor.dragHint")}
					</Text>
					<View className="gap-3 border-border border-t px-4 pt-3 pb-3">
						<Segmented<Tab>
							options={[
								{ id: "details", label: t("editor.tabDetails") },
								{ id: "style", label: t("editor.tabStyle") },
								{ id: "size", label: t("editor.tabSize") },
							]}
							value={tab}
							onChange={setTab}
						/>
						<ScrollView
							style={{ maxHeight: 210 }}
							contentContainerClassName="gap-3"
						>
							{tab === "details" ? (
								<>
									<ToggleRow
										label={t("editor.showDesignation")}
										hint={
											hasDesignation ? undefined : t("editor.missingInProfile")
										}
										value={designationOn}
										onChange={setShowDesignation}
										disabled={!hasDesignation}
									/>
									<ToggleRow
										label={t("editor.showPhone")}
										hint={
											hasPhone
												? t("editor.phoneHint")
												: t("editor.missingInProfile")
										}
										value={phoneOn}
										onChange={setShowPhone}
										disabled={!hasPhone}
									/>
									<ToggleRow
										label={t("editor.showLogo")}
										hint={
											!avatarUrl
												? t("editor.missingInProfile")
												: logo.state.status === "error"
													? t("editor.logoFailed")
													: undefined
										}
										value={logoOn}
										onChange={setShowLogo}
										disabled={!logoImage}
									/>
								</>
							) : null}
							{tab === "style" ? (
								<>
									<Text className="font-semibold text-foreground text-sm">
										{t("editor.textColor")}
									</Text>
									<SwatchRow
										colors={SWATCHES}
										value={color}
										onChange={setColor}
										names={COLOR_NAMES.map((key) => t(key))}
									/>
									<Text className="font-semibold text-foreground text-sm">
										{t("editor.font")}
									</Text>
									<FontRow value={font} onChange={setFont} />
									<ToggleRow
										label={t("editor.backdrop")}
										hint={t("editor.backdropHint")}
										value={backdrop}
										onChange={setBackdrop}
									/>
								</>
							) : null}
							{tab === "size" ? (
								<>
									{logoOn ? (
										<Segmented
											options={[
												{ id: TEXT_ID, label: t("editor.targetText") },
												{ id: LOGO_ID, label: t("editor.targetLogo") },
											]}
											value={sizeTarget}
											onChange={setSelectedId}
										/>
									) : null}
									<SizeRow
										onSmaller={() => resize(1 / 1.15)}
										onBigger={() => resize(1.15)}
									/>
									{sizeTarget === TEXT_ID ? (
										<AlignRow value={align} onChange={setAlign} />
									) : null}
									<ActionButton
										label={t("editor.resetPosition")}
										icon="arrow-undo-outline"
										variant="tertiary"
										size="md"
										onPress={() => {
											setTextPos(null);
											setLogoPos(null);
										}}
									/>
								</>
							) : null}
						</ScrollView>
						<ActionButton
							label={t("editor.next")}
							icon="eye-outline"
							onPress={() => {
								setSelectedId(null);
								setStep("preview");
							}}
						/>
					</View>
				</>
			);
	}

	return (
		<SafeAreaView edges={["top", "bottom"]} className="flex-1 bg-background">
			{header}
			{body}
			<TextPrompt
				visible={namePromptOpen}
				title={t("editor.nameNeededTitle")}
				label={t("editor.nameLabel")}
				placeholder={t("editor.namePlaceholder")}
				maxLength={60}
				confirmLabel={t("editor.useName")}
				onCancel={() => setNamePromptOpen(false)}
				onSubmit={(value) => {
					setTypedName(value);
					setNamePromptOpen(false);
				}}
			/>
		</SafeAreaView>
	);
}

/** Bottom-right, inset by MARGIN, shrunk if a long name would overflow. */
function cornerPlacement(
	size: { width: number; height: number },
	canvasHeight: number,
): Placement {
	const scale = Math.min(1, (DESIGN_UNITS * 0.7) / size.width);
	return {
		x: (DESIGN_UNITS - MARGIN - (size.width * scale) / 2) / DESIGN_UNITS,
		y: (canvasHeight - MARGIN - (size.height * scale) / 2) / canvasHeight,
		scale,
	};
}

/** Right-aligned with the corner, sitting just above the text block. */
function logoAbove(
	size: { width: number; height: number },
	textTop: number,
	canvasHeight: number,
): Placement {
	const scale = 0.8;
	const centreY = textTop - MARGIN / 2 - (size.height * scale) / 2;
	return {
		x: (DESIGN_UNITS - MARGIN - (size.width * scale) / 2) / DESIGN_UNITS,
		y: clamp(centreY / canvasHeight, 0, 1),
		scale,
	};
}
