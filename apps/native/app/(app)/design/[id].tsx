import type { SkImage } from "@shopify/react-native-skia";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { Spinner, useThemeColor, useToast } from "heroui-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import {
	AlignRow,
	BACKGROUND_COLOR_NAMES,
	CanvasArea,
	COLOR_NAMES,
	FontRow,
	HeaderButton,
	Segmented,
	SizeRow,
	SwatchRow,
	ToggleRow,
	ToolButton,
} from "@/components/canvas/controls";
import {
	downscaleImage,
	renderScene,
	type SceneAssets,
} from "@/components/canvas/draw";
import { useFontProvider } from "@/components/canvas/fonts";
import {
	ASPECTS,
	type AspectId,
	BACKGROUND_SWATCHES,
	clamp,
	type DesignDocV1,
	MAX_ELEMENTS,
	MAX_SCALE,
	MAX_TEXT_LENGTH,
	MIN_SCALE,
	newLogoElement,
	newTextElement,
	type Placement,
	parseDesignDoc,
	type SceneElement,
	SWATCHES,
	serializeDesignDoc,
	type TextElement,
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
import { loadSkImage, saveToGallery, shareImage, writeJpeg } from "@/lib/media";
import { getDesign, patchDesign, uploadDesignAsset } from "@/lib/services";
import type { Design } from "@/lib/types";

/**
 * My Designs editor: a background (colour, optionally the design's one
 * photo), text, and the profile logo, saved to the server as a versioned
 * scene (§10). Same renderer as Customize; see components/canvas.
 *
 * Saving is one deliberate action that does three things in order — the new
 * photo if there is one, the scene, then a fresh preview for the gallery,
 * which nothing on the server would otherwise regenerate.
 */

/** Exports are WhatsApp-sized: it re-encodes anything larger anyway. */
const EXPORT_WIDTH = 1080;
/** Gallery tiles are at most half a phone wide. */
const PREVIEW_WIDTH = 540;
/** A picked photo is kept to this on its long edge before upload. */
const SOURCE_MAX_SIDE = 2160;
/** The server's cap on designJson (§10). */
const MAX_DESIGN_JSON_BYTES = 256 * 1024;

const PREVIEW_TRANSFORM = "width=1080,quality=90,fit=scale-down";
const LOGO_TRANSFORM = "width=512,fit=scale-down";

const DESIGN_KEY = (id: string) => ["design", id];

export default function DesignScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const { t, language } = useI18n();
	const router = useRouter();
	const query = useQuery({
		queryKey: DESIGN_KEY(id),
		queryFn: () => getDesign(id),
	});

	if (query.data)
		return <DesignEditor key={query.data.id} design={query.data} />;

	let body: ReactNode;
	if (query.isError) {
		body = isGone(query.error) ? (
			// Another user's design is a 404 too (§10); either way, not openable.
			<EmptyState
				icon="document-outline"
				title={t("designs.notFound")}
				action={
					<ActionButton
						label={t("common.back")}
						icon="chevron-back"
						variant="secondary"
						onPress={() => router.back()}
					/>
				}
			/>
		) : (
			<EmptyState
				icon="cloud-offline-outline"
				title={friendlyError(query.error, t, language)}
				action={
					<ActionButton
						label={t("common.retry")}
						icon="refresh"
						variant="secondary"
						onPress={() => void query.refetch()}
					/>
				}
			/>
		);
	} else {
		body = (
			<View className="flex-1 items-center justify-center">
				<Spinner />
			</View>
		);
	}

	return (
		<SafeAreaView edges={["top", "bottom"]} className="flex-1 bg-background">
			<View className="flex-row px-2">
				<HeaderButton
					icon="chevron-back"
					label={t("common.back")}
					onPress={() => router.back()}
				/>
			</View>
			{body}
		</SafeAreaView>
	);
}

type Busy = "save" | "photo" | "exportSave" | "exportShare" | null;
type Prompt =
	| { kind: "add" }
	| { kind: "edit"; id: string }
	| { kind: "rename" };

function DesignEditor({ design }: { design: Design }) {
	const { t, language } = useI18n();
	const router = useRouter();
	const navigation = useNavigation();
	const { toast } = useToast();
	const queryClient = useQueryClient();
	const { userProfile } = useAuth();
	const accent = useThemeColor("accent");

	const [initial] = useState(() => parseDesignDoc(design.designJson));
	const readOnly = initial.status === "unsupported";
	const [doc, setDoc] = useState<DesignDocV1>(initial.doc);
	const [title, setTitle] = useState(design.title);
	const [saved, setSaved] = useState(design);
	const [dirty, setDirty] = useState(false);
	// Bumped on every edit. A save only clears `dirty` if nothing changed while
	// it was in flight; otherwise the newer edits would be marked saved.
	const revision = useRef(0);
	// A photo picked in this session. Kept after upload too, so the canvas does
	// not flash while it swaps to the same picture from the CDN.
	const [localImage, setLocalImage] = useState<{
		file: File;
		uploaded: boolean;
	} | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [prompt, setPrompt] = useState<Prompt | null>(null);
	const [busy, setBusy] = useState<Busy>(null);

	const fonts = useFontProvider();
	const sourceUri = localImage?.file.uri ?? saved.sourceImageUrl;
	const background = useSkImage(
		doc.background.image
			? localImage
				? localImage.file.uri
				: transformImageUrl(saved.sourceImageUrl, PREVIEW_TRANSFORM)
			: null,
	);
	const avatarUrl = userProfile?.avatarUrl ?? null;
	const logo = useSkImage(transformImageUrl(avatarUrl, LOGO_TRANSFORM));

	const fontProvider =
		fonts.state.status === "ready" ? fonts.state.provider : null;
	const assets: SceneAssets | null = fontProvider
		? {
				fonts: fontProvider,
				background: background.state.image,
				logo: logo.state.image,
			}
		: null;
	const aspect = ASPECTS[doc.aspect];
	const selected = doc.elements.find((el) => el.id === selectedId) ?? null;
	const hasLogoElement = doc.elements.some((el) => el.type === "logo");

	// Leaving with unsaved work asks first. The swipe-back gesture is off for
	// this screen, so this catches the header button and Android's back.
	useEffect(
		() =>
			navigation.addListener("beforeRemove", (e) => {
				if (!dirty) return;
				e.preventDefault();
				Alert.alert(t("designs.leaveTitle"), t("designs.leaveBody"), [
					{ text: t("designs.keepEditing"), style: "cancel" },
					{
						text: t("designs.leave"),
						style: "destructive",
						onPress: () => navigation.dispatch(e.data.action),
					},
				]);
			}),
		[navigation, dirty, t],
	);

	const markDirty = () => {
		revision.current += 1;
		setDirty(true);
	};

	const change = (update: (d: DesignDocV1) => DesignDocV1) => {
		setDoc(update);
		markDirty();
	};

	const updateElement = (id: string, patch: Partial<SceneElement>) =>
		change((d) => ({
			...d,
			elements: d.elements.map((el) =>
				el.id === id ? ({ ...el, ...patch } as SceneElement) : el,
			),
		}));

	const updateText = (id: string, patch: Partial<TextElement>) =>
		updateElement(id, patch);

	const addElement = (el: SceneElement) => {
		if (doc.elements.length >= MAX_ELEMENTS) {
			toast.show({
				variant: "warning",
				label: t("designs.tooManyItems", { count: MAX_ELEMENTS }),
			});
			return;
		}
		change((d) => ({ ...d, elements: [...d.elements, el] }));
		setSelectedId(el.id);
	};

	const removeSelected = () => {
		if (!selectedId) return;
		change((d) => ({
			...d,
			elements: d.elements.filter((el) => el.id !== selectedId),
		}));
		setSelectedId(null);
	};

	const resize = (factor: number) => {
		if (!selected) return;
		updateElement(selected.id, {
			scale: clamp(selected.scale * factor, MIN_SCALE, MAX_SCALE),
		});
	};

	const submitPrompt = (value: string) => {
		if (prompt?.kind === "add") {
			addElement(newTextElement(value, doc.background.color));
		} else if (prompt?.kind === "edit") {
			const el = doc.elements.find((e) => e.id === prompt.id);
			if (el?.type === "text") {
				const first = el.runs[0];
				updateText(el.id, {
					runs: [{ text: value, size: first.size, bold: first.bold }],
				});
			}
		} else if (prompt?.kind === "rename") {
			setTitle(value);
			markDirty();
		}
		setPrompt(null);
	};

	const pickPhoto = async () => {
		if (busy) return;
		let result: ImagePicker.ImagePickerResult;
		try {
			result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ["images"],
				quality: 1,
				// JPEG rather than HEIC on iOS, which Skia cannot be relied on to decode.
				preferredAssetRepresentationMode:
					ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
			});
		} catch {
			toast.show({ variant: "danger", label: t("designs.photoFailed") });
			return;
		}
		const asset = result.canceled ? null : result.assets[0];
		if (!asset) return;

		setBusy("photo");
		let picked: SkImage | null = null;
		let scaled: SkImage | null = null;
		try {
			picked = await loadSkImage(asset.uri);
			scaled = downscaleImage(picked, SOURCE_MAX_SIDE);
			// Re-encoded to JPEG whatever was picked: a known type and size for
			// the upload, and a fresh name so the canvas sees a new picture.
			const file = writeJpeg(
				scaled,
				`design-source-${design.id}-${Date.now()}`,
			);
			setLocalImage({ file, uploaded: false });
			change((d) => ({
				...d,
				background: {
					...d.background,
					image: d.background.image ?? { fit: "cover" },
				},
			}));
		} catch {
			toast.show({ variant: "danger", label: t("designs.photoFailed") });
		} finally {
			picked?.dispose();
			scaled?.dispose();
			setBusy(null);
		}
	};

	const save = async () => {
		if (busy || readOnly || !assets) return;
		const designJson = serializeDesignDoc(doc);
		if (
			new TextEncoder().encode(JSON.stringify(designJson)).length >
			MAX_DESIGN_JSON_BYTES
		) {
			toast.show({ variant: "danger", label: t("designs.tooBig") });
			return;
		}

		setBusy("save");
		const savingRevision = revision.current;
		try {
			let updated = saved;
			if (localImage && !localImage.uploaded) {
				updated = await uploadDesignAsset(design.id, "source", {
					uri: localImage.file.uri,
					mimeType: "image/jpeg",
					bytes: localImage.file.size ?? 0,
				});
				setLocalImage({ ...localImage, uploaded: true });
				track("design_image_added");
			}
			updated = await patchDesign(design.id, { title, designJson });
			if (revision.current === savingRevision) setDirty(false);
			track("design_saved", {
				has_image: doc.background.image !== null && sourceUri !== null,
				element_count: doc.elements.length,
			});

			// The design is safely saved by now; a failed preview only means the
			// gallery tile is stale, so it gets a softer message, not an error.
			let preview: SkImage | null = null;
			try {
				preview = renderScene(
					doc,
					PREVIEW_WIDTH,
					Math.round(PREVIEW_WIDTH / aspect),
					assets,
				);
				const file = writeJpeg(preview, `design-preview-${design.id}`);
				updated = await uploadDesignAsset(design.id, "preview", {
					uri: file.uri,
					mimeType: "image/jpeg",
					bytes: file.size ?? 0,
				});
				toast.show({ variant: "success", label: t("designs.savedToast") });
			} catch {
				toast.show({ variant: "warning", label: t("designs.previewFailed") });
			} finally {
				preview?.dispose();
			}

			setSaved(updated);
			queryClient.setQueryData(DESIGN_KEY(design.id), updated);
			void queryClient.invalidateQueries({ queryKey: ["myDesigns"] });
		} catch (cause) {
			toast.show({
				variant: "danger",
				label: friendlyError(cause, t, language),
			});
		} finally {
			setBusy(null);
		}
	};

	const exportDesign = async (action: "save" | "share") => {
		if (busy || !assets) return;
		setBusy(action === "save" ? "exportSave" : "exportShare");
		let full: SkImage | null = null;
		let composed: SkImage | null = null;
		try {
			// The editor shows a CDN-resized photo; the export draws the original.
			if (doc.background.image && sourceUri)
				full = await loadSkImage(sourceUri);
			composed = renderScene(
				doc,
				EXPORT_WIDTH,
				Math.round(EXPORT_WIDTH / aspect),
				{ ...assets, background: full },
			);
			const jpeg = writeJpeg(composed, `design-${design.id}`);
			if (action === "save") {
				await saveToGallery(jpeg);
				toast.show({ variant: "success", label: t("editor.savedToast") });
			} else {
				await shareImage(jpeg, title);
			}
			track("design_exported", { action });
		} catch (cause) {
			toast.show({
				variant: "danger",
				label: friendlyError(cause, t, language),
			});
		} finally {
			full?.dispose();
			composed?.dispose();
			setBusy(null);
		}
	};

	const promptValue =
		prompt?.kind === "edit"
			? (
					doc.elements.find((e) => e.id === prompt.id) as
						| TextElement
						| undefined
				)?.runs
					.map((r) => r.text)
					.join("\n")
			: prompt?.kind === "rename"
				? title
				: "";

	let canvas: ReactNode;
	if (fonts.state.status === "error" || background.state.status === "error") {
		canvas = (
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
	} else if (!assets || background.state.status === "loading") {
		canvas = (
			<View className="flex-1 items-center justify-center gap-3">
				<Spinner />
				<Text className="text-base text-muted">{t("editor.loading")}</Text>
			</View>
		);
	} else {
		canvas = (
			<CanvasArea aspect={aspect}>
				{(w, h) => (
					<SceneCanvas
						scene={doc}
						width={w}
						height={h}
						assets={assets}
						selectedId={selectedId}
						onSelect={setSelectedId}
						onCommit={(id, placement: Placement) =>
							updateElement(id, placement)
						}
						interactive={!readOnly && busy === null}
						selectionColor={accent}
						accessibilityLabel={t("designs.canvasLabel")}
					/>
				)}
			</CanvasArea>
		);
	}

	return (
		<SafeAreaView edges={["top", "bottom"]} className="flex-1 bg-background">
			<View className="flex-row items-center gap-1 px-2">
				<HeaderButton
					icon="chevron-back"
					label={t("common.back")}
					disabled={busy === "save"}
					onPress={() => router.back()}
				/>
				<Pressable
					onPress={() => !readOnly && setPrompt({ kind: "rename" })}
					disabled={readOnly}
					accessibilityRole="button"
					accessibilityLabel={t("designs.rename")}
					accessibilityValue={{ text: title }}
					className="min-h-12 flex-1 justify-center"
				>
					<Text
						className="font-heading text-foreground text-lg"
						numberOfLines={1}
					>
						{title}
					</Text>
				</Pressable>
				<ActionButton
					label={t("common.save")}
					icon="checkmark"
					size="md"
					isLoading={busy === "save"}
					isDisabled={readOnly || !dirty || busy !== null || !assets}
					onPress={save}
				/>
			</View>

			{readOnly ? (
				<Text className="mx-4 rounded-xl bg-surface-secondary p-3 text-base text-foreground">
					{t("designs.newerVersion")}
				</Text>
			) : null}

			{canvas}

			{readOnly ? null : (
				<View className="gap-3 border-border border-t px-4 pt-3 pb-3">
					<ScrollView
						style={{ maxHeight: 270 }}
						contentContainerClassName="gap-3"
						keyboardShouldPersistTaps="handled"
					>
						{selected?.type === "text" ? (
							<TextPanel
								element={selected}
								onEdit={() => setPrompt({ kind: "edit", id: selected.id })}
								onChange={(patch) => updateText(selected.id, patch)}
								onResize={resize}
								onRemove={removeSelected}
								onDone={() => setSelectedId(null)}
							/>
						) : selected?.type === "logo" ? (
							<>
								<View className="flex-row gap-2">
									<ToolButton
										icon="trash-outline"
										label={t("designs.removeItem")}
										onPress={removeSelected}
									/>
									<ToolButton
										icon="checkmark-circle-outline"
										label={t("common.done")}
										onPress={() => setSelectedId(null)}
									/>
								</View>
								<SizeRow
									onSmaller={() => resize(1 / 1.15)}
									onBigger={() => resize(1.15)}
								/>
							</>
						) : (
							<>
								<Text className="text-center text-muted text-sm">
									{doc.elements.length === 0
										? t("designs.emptyCanvasHint")
										: t("designs.selectHint")}
								</Text>
								<View className="flex-row gap-2">
									<ToolButton
										icon="text-outline"
										label={t("designs.addText")}
										onPress={() => setPrompt({ kind: "add" })}
									/>
									<ToolButton
										icon="image-outline"
										label={
											doc.background.image
												? t("designs.changePhoto")
												: t("designs.addPhoto")
										}
										onPress={pickPhoto}
										disabled={busy !== null}
									/>
									<ToolButton
										icon="person-circle-outline"
										label={t("designs.addLogo")}
										onPress={() => addElement(newLogoElement())}
										disabled={!logo.state.image || hasLogoElement}
									/>
								</View>
								{!avatarUrl ? (
									<Text className="text-muted text-xs">
										{t("designs.logoMissing")}
									</Text>
								) : null}
								{doc.background.image ? (
									<View className="gap-2">
										<Segmented
											options={[
												{ id: "cover", label: t("designs.fitFill") },
												{ id: "contain", label: t("designs.fitWhole") },
											]}
											value={doc.background.image.fit}
											onChange={(fit) =>
												change((d) => ({
													...d,
													background: { ...d.background, image: { fit } },
												}))
											}
										/>
										<ActionButton
											label={t("designs.removePhoto")}
											icon="close-circle-outline"
											variant="tertiary"
											size="md"
											onPress={() =>
												change((d) => ({
													...d,
													background: { ...d.background, image: null },
												}))
											}
										/>
									</View>
								) : null}
								<Text className="font-semibold text-foreground text-sm">
									{t("designs.shape")}
								</Text>
								<Segmented<AspectId>
									options={[
										{ id: "1:1", label: t("designs.shapeSquare") },
										{ id: "4:5", label: t("designs.shapePortrait") },
										{ id: "9:16", label: t("designs.shapeStory") },
									]}
									value={doc.aspect}
									onChange={(aspectId) =>
										change((d) => ({ ...d, aspect: aspectId }))
									}
								/>
								<Text className="font-semibold text-foreground text-sm">
									{t("designs.backgroundColor")}
								</Text>
								<SwatchRow
									colors={BACKGROUND_SWATCHES}
									value={doc.background.color}
									onChange={(color) =>
										change((d) => ({
											...d,
											background: { ...d.background, color },
										}))
									}
									names={BACKGROUND_COLOR_NAMES.map((key) => t(key))}
								/>
							</>
						)}
					</ScrollView>
					{selected ? null : (
						<View className="flex-row gap-3">
							<ActionButton
								className="flex-1"
								label={t("editor.saveToPhone")}
								icon="download-outline"
								variant="secondary"
								isLoading={busy === "exportSave"}
								isDisabled={busy !== null || !assets}
								onPress={() => exportDesign("save")}
							/>
							<ActionButton
								className="flex-1"
								label={t("editor.share")}
								icon="share-social"
								isLoading={busy === "exportShare"}
								isDisabled={busy !== null || !assets}
								onPress={() => exportDesign("share")}
							/>
						</View>
					)}
				</View>
			)}

			<TextPrompt
				visible={prompt !== null}
				title={
					prompt?.kind === "rename"
						? t("designs.renameTitle")
						: t("designs.textPromptTitle")
				}
				label={
					prompt?.kind === "rename"
						? t("designs.titleLabel")
						: t("designs.textLabel")
				}
				placeholder={
					prompt?.kind === "rename"
						? t("designs.titlePlaceholder")
						: t("designs.textPlaceholder")
				}
				initialValue={promptValue}
				multiline={prompt?.kind !== "rename"}
				maxLength={prompt?.kind === "rename" ? 80 : MAX_TEXT_LENGTH}
				confirmLabel={t("common.done")}
				onCancel={() => setPrompt(null)}
				onSubmit={submitPrompt}
			/>
		</SafeAreaView>
	);
}

function TextPanel({
	element,
	onEdit,
	onChange,
	onResize,
	onRemove,
	onDone,
}: {
	element: TextElement;
	onEdit: () => void;
	onChange: (patch: Partial<TextElement>) => void;
	onResize: (factor: number) => void;
	onRemove: () => void;
	onDone: () => void;
}) {
	const { t } = useI18n();
	const bold = element.runs.every((r) => r.bold);
	return (
		<>
			<View className="flex-row gap-2">
				<ToolButton
					icon="create-outline"
					label={t("designs.editText")}
					onPress={onEdit}
				/>
				<ToolButton
					icon="trash-outline"
					label={t("designs.removeItem")}
					onPress={onRemove}
				/>
				<ToolButton
					icon="checkmark-circle-outline"
					label={t("common.done")}
					onPress={onDone}
				/>
			</View>
			<Text className="font-semibold text-foreground text-sm">
				{t("editor.textColor")}
			</Text>
			<SwatchRow
				colors={SWATCHES}
				value={element.color}
				onChange={(color) => onChange({ color })}
				names={COLOR_NAMES.map((key) => t(key))}
			/>
			<Text className="font-semibold text-foreground text-sm">
				{t("editor.font")}
			</Text>
			<FontRow value={element.font} onChange={(font) => onChange({ font })} />
			<SizeRow
				onSmaller={() => onResize(1 / 1.15)}
				onBigger={() => onResize(1.15)}
			/>
			<AlignRow
				value={element.align}
				onChange={(align) => onChange({ align })}
			/>
			<ToggleRow
				label={t("designs.bold")}
				value={bold}
				onChange={(value) =>
					onChange({ runs: element.runs.map((r) => ({ ...r, bold: value })) })
				}
			/>
			<ToggleRow
				label={t("editor.backdrop")}
				hint={t("editor.backdropHint")}
				value={element.backdrop}
				onChange={(backdrop) => onChange({ backdrop })}
			/>
		</>
	);
}
