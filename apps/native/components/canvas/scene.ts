/**
 * The one scene model behind both editors — Customize & Share and My Designs.
 *
 * Geometry is normalised so a scene renders identically at any pixel size:
 *
 *   - An element's position (`x`, `y`) is its *centre*, as a fraction of the
 *     canvas width and height. Centre rather than corner, so a pinch grows the
 *     element in place instead of away from the finger.
 *   - Everything else is in "design units", where the canvas is always
 *     `DESIGN_UNITS` wide (and `DESIGN_UNITS / aspect` tall). An element is
 *     laid out once in those units and the renderer scales the result to the
 *     target width. That is what keeps the on-screen preview and the
 *     full-resolution export the same picture: text wraps at the same words
 *     and sits at the same place, because it was laid out in the same space.
 *
 * Designs persist a `DesignDocV1` as `designJson` (docs/mobile-integration.md
 * §10). The server never reads it, so nothing but `parseDesignDoc` stands
 * between a malformed or future scene and a crash — it is deliberately
 * forgiving. Customize builds a `Scene` on the fly and persists nothing (§9).
 */

import * as Crypto from "expo-crypto";
import { z } from "zod";

export const DESIGN_UNITS = 1000;

/** Base font size of a text run at `size: 1`, in design units. */
export const BASE_FONT_SIZE = 56;

/** Longest line before a text element wraps, in design units (unscaled). */
export const MAX_TEXT_WIDTH = 900;

/** Edge of a logo's bounding square at `scale: 1`, in design units. */
export const LOGO_SIZE = 180;

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 4;

/** Cap on user-typed text per element: keeps designJson far below 256 KB. */
export const MAX_TEXT_LENGTH = 400;
export const MAX_ELEMENTS = 30;

export type FontId = "poppins" | "kalam" | "serif";
export type AlignId = "left" | "center" | "right";
export type AspectId = "1:1" | "4:5" | "9:16";
export type FitId = "cover" | "contain";

export interface Placement {
	/** Centre, as a fraction of canvas width. */
	x: number;
	/** Centre, as a fraction of canvas height. */
	y: number;
	/** Multiplier on the element's natural size. */
	scale: number;
}

/** One line (or paragraph) of a text block, sized relative to the base. */
export interface TextRun {
	text: string;
	size: number;
	bold: boolean;
}

export interface TextElement extends Placement {
	id: string;
	type: "text";
	runs: TextRun[];
	color: string;
	font: FontId;
	align: AlignId;
	/** A translucent rounded panel behind the text; off means a soft shadow. */
	backdrop: boolean;
}

/**
 * The user's profile logo. No image data or URL is stored: it always draws the
 * logo currently on the profile, which is also what keeps image bytes out of
 * designJson.
 */
export interface LogoElement extends Placement {
	id: string;
	type: "logo";
}

export type SceneElement = TextElement | LogoElement;

export interface Background {
	color: string;
	/** The design's one source image (or the greeting), and how it fills. */
	image: { fit: FitId } | null;
}

/** What the renderer draws. Pixel size is the caller's choice. */
export interface Scene {
	background: Background;
	elements: SceneElement[];
}

/** What My Designs persists as designJson. */
export interface DesignDocV1 extends Scene {
	version: 1;
	aspect: AspectId;
}

export const ASPECTS: Record<AspectId, number> = {
	"1:1": 1,
	"4:5": 4 / 5,
	"9:16": 9 / 16,
};

/**
 * Overlay colours. Hardcoded on purpose: these are paint on the artwork, not
 * UI chrome, so they must not follow the app theme.
 */
export const SWATCHES = [
	"#FFFFFF",
	"#111111",
	"#F2C14E",
	"#F28C28",
	"#8B1E3F",
	"#1F6F5C",
] as const;

export const BACKGROUND_SWATCHES = [
	"#FFF8E7",
	"#FFFFFF",
	"#F28C28",
	"#8B1E3F",
	"#1F3A5F",
	"#111111",
] as const;

export function newId(): string {
	return Crypto.randomUUID().slice(0, 8);
}

export function clamp(value: number, min: number, max: number): number {
	"worklet";
	return Math.min(max, Math.max(min, value));
}

/** True for light colours, which need a dark backdrop or shadow to read. */
export function isLight(hex: string): boolean {
	const n = Number.parseInt(hex.slice(1), 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

export function defaultDesignDoc(): DesignDocV1 {
	return {
		version: 1,
		aspect: "1:1",
		background: { color: BACKGROUND_SWATCHES[0], image: null },
		elements: [],
	};
}

export function newTextElement(text: string, background: string): TextElement {
	return {
		id: newId(),
		type: "text",
		runs: [{ text, size: 1, bold: true }],
		color: isLight(background) ? "#111111" : "#FFFFFF",
		font: "poppins",
		align: "center",
		backdrop: false,
		x: 0.5,
		y: 0.5,
		scale: 1,
	};
}

export function newLogoElement(): LogoElement {
	return { id: newId(), type: "logo", x: 0.82, y: 0.14, scale: 1 };
}

// ---------------------------------------------------------------------------
// Parsing. Every field has a fallback and every element is validated on its
// own, so one bad element costs that element, never the whole design.
// ---------------------------------------------------------------------------

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const unit = z.number().finite().min(0).max(1);

const placement = {
	x: unit.catch(0.5),
	y: unit.catch(0.5),
	scale: z.number().finite().min(MIN_SCALE).max(MAX_SCALE).catch(1),
};

const textRun = z.object({
	text: z.string().transform((s) => s.slice(0, MAX_TEXT_LENGTH)),
	size: z.number().finite().min(0.3).max(3).catch(1),
	bold: z.boolean().catch(false),
});

const textElement = z.object({
	...placement,
	id: z.string().min(1).max(64),
	type: z.literal("text"),
	runs: z
		.array(textRun)
		.min(1)
		.max(8)
		.refine((runs) => runs.some((r) => r.text.trim().length > 0)),
	color: hex.catch("#111111"),
	font: z.enum(["poppins", "kalam", "serif"]).catch("poppins"),
	align: z.enum(["left", "center", "right"]).catch("center"),
	backdrop: z.boolean().catch(false),
});

const logoElement = z.object({
	...placement,
	id: z.string().min(1).max(64),
	type: z.literal("logo"),
});

const element = z.discriminatedUnion("type", [textElement, logoElement]);

const docV1 = z.object({
	version: z.literal(1),
	aspect: z.enum(["1:1", "4:5", "9:16"]).catch("1:1"),
	background: z
		.object({
			color: hex.catch(BACKGROUND_SWATCHES[0]),
			image: z
				.object({ fit: z.enum(["cover", "contain"]).catch("cover") })
				.nullable()
				.catch(null),
		})
		.catch({ color: BACKGROUND_SWATCHES[0], image: null }),
	elements: z.array(z.unknown()).catch([]),
});

export type ParsedDesign =
	| { status: "ok"; doc: DesignDocV1 }
	/** Written by a newer app. Shown blank and read-only so a save cannot clobber it. */
	| { status: "unsupported"; doc: DesignDocV1 };

export function parseDesignDoc(json: unknown): ParsedDesign {
	const version =
		typeof json === "object" && json !== null && "version" in json
			? (json as { version: unknown }).version
			: undefined;
	if (typeof version === "number" && version > 1) {
		return { status: "unsupported", doc: defaultDesignDoc() };
	}

	const parsed = docV1.safeParse({ ...(json as object), version: 1 });
	if (!parsed.success) return { status: "ok", doc: defaultDesignDoc() };

	const elements: SceneElement[] = [];
	const seen = new Set<string>();
	for (const raw of parsed.data.elements.slice(0, MAX_ELEMENTS)) {
		const el = element.safeParse(raw);
		if (el.success && !seen.has(el.data.id)) {
			seen.add(el.data.id);
			elements.push(el.data);
		}
	}
	return { status: "ok", doc: { ...parsed.data, elements } };
}

/** The scene as designJson. A plain object so the API types accept it. */
export function serializeDesignDoc(doc: DesignDocV1): Record<string, unknown> {
	return {
		version: 1,
		aspect: doc.aspect,
		background: doc.background,
		elements: doc.elements,
	};
}
