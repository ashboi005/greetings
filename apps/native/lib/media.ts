/**
 * Getting a greeting's bytes onto the phone, into the gallery, and out through
 * the share sheet.
 *
 * Two rules from docs/mobile-integration.md §8 shape all of it:
 *
 *   - Scrolling never calls the API; saving always does. Every save or share
 *     goes through `POST /download` (the counted event) — but the *bytes* are
 *     fetched once and cached on disk, since a `null` expiresInSeconds means
 *     the URL is a permanent CDN object.
 *   - Everything that leaves the app is a JPEG. Content is stored as WebP, and
 *     WhatsApp — where nearly all of these go — sends a shared .webp as a
 *     *sticker*, while older Android galleries do not show WebP at all. Skia
 *     is already in the app for overlays, so it does the conversion.
 */

import { ImageFormat, type SkImage, Skia } from "@shopify/react-native-skia";
import { Directory, File, Paths } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

import { type DownloadSource, downloadContent } from "./services";

const JPEG_QUALITY = 92;

function cacheDir(): Directory {
	const dir = new Directory(Paths.cache, "greetings");
	if (!dir.exists) dir.create({ intermediates: true });
	return dir;
}

function originalFile(contentId: string): File {
	return new File(cacheDir(), `content-${contentId}`);
}

/** Thrown when the person refused photo access, so the screen can say so. */
export class MediaPermissionError extends Error {
	constructor() {
		super("Photo library permission was not granted.");
		this.name = "MediaPermissionError";
	}
}

/**
 * Records the download and returns the original image as a local file.
 *
 * The server call happens every time (it is what credits the designer); the
 * network fetch only when the bytes are not already cached.
 */
export async function fetchGreeting(
	contentId: string,
	options: { source: DownloadSource; customized: boolean },
): Promise<File> {
	const { url, expiresInSeconds } = await downloadContent(
		contentId,
		options.source,
		options.customized,
	);

	const cached = originalFile(contentId);
	if (cached.exists && (cached.size ?? 0) > 0) return cached;

	// A number means a signed URL that dies in minutes (a deployment without a
	// CDN): fetch now, and never keep it. `null` means safe to keep forever.
	const target =
		expiresInSeconds === null
			? cached
			: new File(cacheDir(), `tmp-${Date.now()}`);
	if (target.exists) target.delete();
	await File.downloadFileAsync(url, target);
	return target;
}

/** Decodes any image Skia understands (WebP, PNG, JPEG) from a local file. */
export async function loadSkImage(file: File | string): Promise<SkImage> {
	const uri = typeof file === "string" ? file : file.uri;
	const data = await Skia.Data.fromURI(uri);
	const image = Skia.Image.MakeImageFromEncoded(data);
	if (!image) throw new Error("Could not decode image.");
	return image;
}

/** Encodes a Skia image as a JPEG in the cache and returns the file. */
export function writeJpeg(image: SkImage, name: string): File {
	const bytes = image.encodeToBytes(ImageFormat.JPEG, JPEG_QUALITY);
	const file = new File(cacheDir(), `${name}.jpg`);
	if (file.exists) file.delete();
	file.create();
	file.write(bytes);
	return file;
}

/** A JPEG copy of a cached original, for saving or sharing as-is. */
export async function toShareableJpeg(
	original: File,
	name: string,
): Promise<File> {
	const image = await loadSkImage(original);
	try {
		return writeJpeg(image, name);
	} finally {
		image.dispose();
	}
}

/**
 * Asks for write-only gallery access, throwing MediaPermissionError if refused.
 *
 * Call it BEFORE `fetchGreeting` on a save: the download is the counted event,
 * and asking afterwards means a person who denied access records a download on
 * every tap while nothing is ever saved — inflating designers' numbers.
 */
export async function ensureGalleryPermission(): Promise<void> {
	const permission = await MediaLibrary.requestPermissionsAsync(true);
	if (!permission.granted) throw new MediaPermissionError();
}

/** Saves a local image into the photo gallery. Write-only permission. */
export async function saveToGallery(file: File): Promise<void> {
	await ensureGalleryPermission();
	await MediaLibrary.saveToLibraryAsync(file.uri);
}

/** Opens the system share sheet with a local image. */
export async function shareImage(
	file: File,
	dialogTitle?: string,
): Promise<void> {
	if (!(await Sharing.isAvailableAsync())) {
		throw new Error("Sharing is not available on this device.");
	}
	await Sharing.shareAsync(file.uri, {
		mimeType: "image/jpeg",
		UTI: "public.jpeg",
		dialogTitle,
	});
}

/** The common case: record, fetch, convert, then save or share. */
export async function saveOrShareGreeting(
	contentId: string,
	action: "save" | "share",
	options: { source: DownloadSource; title?: string },
): Promise<void> {
	if (action === "save") await ensureGalleryPermission();
	const original = await fetchGreeting(contentId, {
		source: options.source,
		customized: false,
	});
	const jpeg = await toShareableJpeg(original, `greeting-${contentId}`);
	if (action === "save") await saveToGallery(jpeg);
	else await shareImage(jpeg, options.title);
}

export const isNative = Platform.OS === "ios" || Platform.OS === "android";
