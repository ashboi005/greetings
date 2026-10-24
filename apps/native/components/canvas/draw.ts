/**
 * The renderer. Pure, imperative Skia, shared by the on-screen editor and the
 * export — one code path is the whole WYSIWYG guarantee.
 *
 * Each element is recorded once into an `SkPicture` in design units (see
 * scene.ts) with its top-left at the origin. Placing it is then only a
 * translate and a uniform scale, which:
 *
 *   - the export applies with `canvas.translate/scale` at the source image's
 *     pixel size, and
 *   - the editor applies as a Skia `<Group transform>` driven by Reanimated,
 *     so a drag moves a finished picture on the UI thread at 60fps instead of
 *     re-laying out text every frame.
 *
 * Pictures are vector command lists, so the same recording is as sharp at
 * 4000px as at 360dp. The export never captures the visible view (§9).
 */

import {
	ClipOp,
	createPicture,
	FilterMode,
	FontWeight,
	MipmapMode,
	type SkCanvas,
	type SkImage,
	Skia,
	type SkParagraph,
	type SkPicture,
	type SkTypefaceFontProvider,
	TextAlign,
} from "@shopify/react-native-skia";

import { fontFamilies } from "./fonts";
import {
	BASE_FONT_SIZE,
	type Background,
	DESIGN_UNITS,
	isLight,
	LOGO_SIZE,
	MAX_TEXT_WIDTH,
	type Placement,
	type Scene,
	type SceneElement,
	type TextElement,
} from "./scene";

export interface SceneAssets {
	fonts: SkTypefaceFontProvider;
	/** The greeting, or the design's source image. */
	background: SkImage | null;
	/** The profile logo, when there is one and it loaded. */
	logo: SkImage | null;
}

/** An element recorded at its natural size, in design units. */
export interface BuiltElement {
	id: string;
	picture: SkPicture;
	width: number;
	height: number;
}

const ALIGN: Record<TextElement["align"], TextAlign> = {
	left: TextAlign.Left,
	center: TextAlign.Center,
	right: TextAlign.Right,
};

function layoutParagraph(
	el: TextElement,
	fonts: SkTypefaceFontProvider,
): SkParagraph {
	const builder = Skia.ParagraphBuilder.Make(
		// Hinting snaps glyphs to the pixel grid of one particular size; off, the
		// layout is the same at preview and export scale.
		{ textAlign: ALIGN[el.align], disableHinting: true },
		fonts,
	);
	el.runs.forEach((run, i) => {
		builder.pushStyle({
			color: Skia.Color(el.color),
			fontFamilies: fontFamilies(el.font),
			fontSize: BASE_FONT_SIZE * run.size,
			fontStyle: { weight: run.bold ? FontWeight.Bold : FontWeight.Normal },
			heightMultiplier: 1.2,
		});
		builder.addText(i < el.runs.length - 1 ? `${run.text}\n` : run.text);
		builder.pop();
	});
	const paragraph = builder.build();

	// Lay out once to find the longest line, then again at exactly that width,
	// so alignment is relative to the block rather than to MAX_TEXT_WIDTH.
	paragraph.layout(MAX_TEXT_WIDTH);
	paragraph.layout(Math.ceil(paragraph.getLongestLine()) + 1);
	return paragraph;
}

/**
 * The legibility aid when there is no backdrop: a dark shadow under light
 * text, a pale glow under dark text, so either reads on busy artwork.
 *
 * An image filter on a layer rather than the paragraph's own text shadows:
 * those blur in device pixels whatever the scale, so the shadow would look
 * four times softer on screen than in a 4000px export. Image filter sizes are
 * in local units and scale with the picture.
 */
function shadowPaint(color: string) {
	const paint = Skia.Paint();
	paint.setImageFilter(
		Skia.ImageFilter.MakeDropShadow(
			0,
			2,
			3,
			3,
			Skia.Color(isLight(color) ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.7)"),
			null,
		),
	);
	return paint;
}

function buildText(el: TextElement, fonts: SkTypefaceFontProvider) {
	const paragraph = layoutParagraph(el, fonts);
	const textWidth = paragraph.getMaxWidth();
	const textHeight = paragraph.getHeight();
	const padX = el.backdrop ? BASE_FONT_SIZE * 0.35 : 0;
	const padY = el.backdrop ? BASE_FONT_SIZE * 0.2 : 0;
	const width = textWidth + padX * 2;
	const height = textHeight + padY * 2;

	const picture = createPicture((canvas) => {
		if (el.backdrop) {
			const paint = Skia.Paint();
			paint.setColor(
				Skia.Color(
					isLight(el.color) ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.72)",
				),
			);
			paint.setAntiAlias(true);
			const r = BASE_FONT_SIZE * 0.3;
			canvas.drawRRect(
				Skia.RRectXY(Skia.XYWHRect(0, 0, width, height), r, r),
				paint,
			);
			paragraph.paint(canvas, padX, padY);
		} else {
			canvas.saveLayer(shadowPaint(el.color));
			paragraph.paint(canvas, 0, 0);
			canvas.restore();
		}
	});
	// The picture holds its own recording of the glyphs; the laid-out
	// paragraph is native memory nothing will read again.
	paragraph.dispose();
	return { picture, width, height };
}

function buildLogo(logo: SkImage | null) {
	// A missing logo still has a size, so hit-testing and placement stay sane
	// for the instant before the image arrives; it just draws nothing.
	const iw = logo?.width() ?? 1;
	const ih = logo?.height() ?? 1;
	const fit = LOGO_SIZE / Math.max(iw, ih);
	const width = iw * fit;
	const height = ih * fit;

	const picture = createPicture((canvas) => {
		if (!logo) return;
		const r = Math.min(width, height) * 0.12;
		canvas.save();
		canvas.clipRRect(
			Skia.RRectXY(Skia.XYWHRect(0, 0, width, height), r, r),
			ClipOp.Intersect,
			true,
		);
		canvas.drawImageRectOptions(
			logo,
			Skia.XYWHRect(0, 0, iw, ih),
			Skia.XYWHRect(0, 0, width, height),
			FilterMode.Linear,
			MipmapMode.Linear,
		);
		canvas.restore();
	});
	return { picture, width, height };
}

export function buildElement(
	el: SceneElement,
	assets: Pick<SceneAssets, "fonts" | "logo">,
): BuiltElement {
	const built =
		el.type === "text" ? buildText(el, assets.fonts) : buildLogo(assets.logo);
	return { id: el.id, ...built };
}

/**
 * Where a built element lands on a canvas of `width × height` pixels: draw
 * the picture after `translate(tx, ty)` then `scale(s)`.
 *
 * A worklet, because the editor runs it on the UI thread on every frame of a
 * drag; the export calls it on the JS thread. Same numbers either way.
 */
export function placement(
	pos: Placement,
	elementWidth: number,
	elementHeight: number,
	width: number,
	height: number,
): { tx: number; ty: number; s: number } {
	"worklet";
	const s = (width / DESIGN_UNITS) * pos.scale;
	return {
		tx: pos.x * width - (elementWidth * s) / 2,
		ty: pos.y * height - (elementHeight * s) / 2,
		s,
	};
}

/** Fills the canvas with the background colour, then the image fitted. */
export function drawBackground(
	canvas: SkCanvas,
	background: Background,
	width: number,
	height: number,
	image: SkImage | null,
) {
	canvas.drawColor(Skia.Color(background.color));
	if (!background.image || !image) return;

	const iw = image.width();
	const ih = image.height();
	const scale =
		background.image.fit === "cover"
			? Math.max(width / iw, height / ih)
			: Math.min(width / iw, height / ih);
	const dw = iw * scale;
	const dh = ih * scale;
	canvas.drawImageRectOptions(
		image,
		Skia.XYWHRect(0, 0, iw, ih),
		Skia.XYWHRect((width - dw) / 2, (height - dh) / 2, dw, dh),
		FilterMode.Linear,
		MipmapMode.Linear,
	);
}

export function drawPlaced(
	canvas: SkCanvas,
	built: BuiltElement,
	pos: Placement,
	width: number,
	height: number,
) {
	const { tx, ty, s } = placement(
		pos,
		built.width,
		built.height,
		width,
		height,
	);
	canvas.save();
	canvas.translate(tx, ty);
	canvas.scale(s, s);
	canvas.drawPicture(built.picture);
	canvas.restore();
}

/** The whole scene onto any canvas at any pixel size. */
export function drawScene(
	canvas: SkCanvas,
	scene: Scene,
	width: number,
	height: number,
	assets: SceneAssets,
) {
	drawBackground(canvas, scene.background, width, height, assets.background);
	for (const el of scene.elements) {
		const built = buildElement(el, assets);
		drawPlaced(canvas, built, el, width, height);
		// Synchronous and single-use: free it now rather than leave a stack of
		// native recordings for the GC after every export.
		built.picture.dispose();
	}
}

/**
 * Renders a scene to a new image of exactly `width × height` pixels. The
 * caller owns the result and must `dispose()` it.
 *
 * A CPU raster surface rather than `MakeOffscreen`: a GPU surface is capped
 * at the device's maximum texture size — 4096px on plenty of the phones this
 * targets — and a designer's original can be larger. One frame on the CPU is
 * a fraction of a second and has no such ceiling.
 */
export function renderScene(
	scene: Scene,
	width: number,
	height: number,
	assets: SceneAssets,
): SkImage {
	const surface = Skia.Surface.Make(Math.round(width), Math.round(height));
	if (!surface) throw new Error("Could not allocate an image to draw on.");
	try {
		drawScene(surface.getCanvas(), scene, width, height, assets);
		surface.flush();
		return surface.makeImageSnapshot();
	} finally {
		surface.dispose();
	}
}

/**
 * A copy of `image` no larger than `maxSide` on its long edge. The caller owns
 * the result and must `dispose()` it.
 *
 * Used on a photo picked for a design: a 12-megapixel camera original would
 * blow the 10 MB upload limit and is several times more pixels than any
 * export of a design needs.
 */
export function downscaleImage(image: SkImage, maxSide: number): SkImage {
	const scale = Math.min(1, maxSide / Math.max(image.width(), image.height()));
	const width = Math.max(1, Math.round(image.width() * scale));
	const height = Math.max(1, Math.round(image.height() * scale));
	const surface = Skia.Surface.Make(width, height);
	if (!surface) throw new Error("Could not allocate an image to draw on.");
	try {
		surface
			.getCanvas()
			.drawImageRectOptions(
				image,
				Skia.XYWHRect(0, 0, image.width(), image.height()),
				Skia.XYWHRect(0, 0, width, height),
				FilterMode.Linear,
				MipmapMode.Linear,
			);
		surface.flush();
		return surface.makeImageSnapshot();
	} finally {
		surface.dispose();
	}
}
