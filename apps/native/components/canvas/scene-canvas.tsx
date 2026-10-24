/**
 * The on-screen editor surface: the scene drawn by the shared renderer, plus
 * the gestures that move and scale its elements.
 *
 * Positions live in a Reanimated shared value while a finger is down, so a
 * drag never round-trips through React; the final placement is committed to
 * the screen's state once, when the gesture ends. The screen's state stays
 * the source of truth — it is copied back into the shared value whenever it
 * changes, which is also how the size buttons and "reset" take effect.
 *
 * The selection outline is drawn here and only here. It is not part of the
 * scene, so it can never reach an exported image.
 */

import {
	Canvas,
	createPicture,
	Group,
	Picture,
	RoundedRect,
	Skia,
} from "@shopify/react-native-skia";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
	type SharedValue,
	useDerivedValue,
	useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import {
	type BuiltElement,
	buildElement,
	drawBackground,
	placement,
	type SceneAssets,
} from "./draw";
import {
	clamp,
	MAX_SCALE,
	MIN_SCALE,
	type Placement,
	type Scene,
} from "./scene";

type Positions = Record<string, Placement>;
type Sizes = Record<string, { w: number; h: number }>;

/** Extra touch margin around each element, in dp: small logos are fiddly. */
const TOUCH_SLOP = 14;

interface SceneCanvasProps {
	scene: Scene;
	/** On-screen size in dp. The scene is normalised, so any size works. */
	width: number;
	height: number;
	assets: SceneAssets;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	onCommit: (id: string, placement: Placement) => void;
	/** False in the final preview: no gestures, no outline. */
	interactive: boolean;
	selectionColor: string;
	accessibilityLabel: string;
}

export function SceneCanvas({
	scene,
	width,
	height,
	assets,
	selectedId,
	onSelect,
	onCommit,
	interactive,
	selectionColor,
	accessibilityLabel,
}: SceneCanvasProps) {
	const { fonts, logo, background } = assets;
	const built = useMemo(
		() => scene.elements.map((el) => buildElement(el, { fonts, logo })),
		[scene.elements, fonts, logo],
	);
	const backgroundPicture = useMemo(
		() =>
			createPicture((canvas) =>
				drawBackground(canvas, scene.background, width, height, background),
			),
		[scene.background, width, height, background],
	);

	const positions = useSharedValue<Positions>({});
	const sizes = useSharedValue<Sizes>({});
	const order = useSharedValue<string[]>([]);
	const selected = useSharedValue<string | null>(selectedId);

	useEffect(() => {
		positions.value = Object.fromEntries(
			scene.elements.map((el) => [
				el.id,
				{ x: el.x, y: el.y, scale: el.scale },
			]),
		);
	}, [scene.elements, positions]);

	useEffect(() => {
		sizes.value = Object.fromEntries(
			built.map((b) => [b.id, { w: b.width, h: b.height }]),
		);
		order.value = built.map((b) => b.id);
	}, [built, sizes, order]);

	const visibleSelection = interactive ? selectedId : null;
	useEffect(() => {
		selected.value = visibleSelection;
	}, [visibleSelection, selected]);

	const handleSelect = (id: string | null) => {
		if (id) void Haptics.selectionAsync().catch(() => {});
		onSelect(id);
	};

	const hitTest = (x: number, y: number): string | null => {
		"worklet";
		const contains = (id: string) => {
			const p = positions.value[id];
			const size = sizes.value[id];
			if (!p || !size) return false;
			const { tx, ty, s } = placement(p, size.w, size.h, width, height);
			return (
				x >= tx - TOUCH_SLOP &&
				x <= tx + size.w * s + TOUCH_SLOP &&
				y >= ty - TOUCH_SLOP &&
				y <= ty + size.h * s + TOUCH_SLOP
			);
		};
		// The selected element wins an overlap, so you can keep dragging what
		// you are working on even when it sits under something else.
		const current = selected.value;
		if (current && contains(current)) return current;
		const ids = order.value;
		for (let i = ids.length - 1; i >= 0; i--) {
			if (contains(ids[i])) return ids[i];
		}
		return null;
	};

	const update = (id: string, patch: Partial<Placement>) => {
		"worklet";
		const p = positions.value[id];
		if (!p) return;
		positions.value = { ...positions.value, [id]: { ...p, ...patch } };
	};

	const commit = (id: string | null) => {
		"worklet";
		if (!id) return;
		const p = positions.value[id];
		if (p) scheduleOnRN(onCommit, id, p);
	};

	const select = (id: string | null) => {
		"worklet";
		if (id === selected.value) return;
		selected.value = id;
		scheduleOnRN(handleSelect, id);
	};

	const panId = useSharedValue<string | null>(null);
	const panStart = useSharedValue({ x: 0, y: 0 });
	const pinchId = useSharedValue<string | null>(null);
	const pinchStart = useSharedValue(1);

	const pan = Gesture.Pan()
		.enabled(interactive)
		.minDistance(4)
		.averageTouches(true)
		.onStart((e) => {
			// A drag that starts on empty canvas moves the current selection:
			// a small logo is hard to land a finger on, the space around it isn't.
			const id =
				hitTest(e.x - e.translationX, e.y - e.translationY) ?? selected.value;
			panId.value = id;
			if (!id) return;
			select(id);
			const p = positions.value[id];
			if (p) panStart.value = { x: p.x, y: p.y };
		})
		.onUpdate((e) => {
			const id = panId.value;
			if (!id) return;
			update(id, {
				x: clamp(panStart.value.x + e.translationX / width, 0, 1),
				y: clamp(panStart.value.y + e.translationY / height, 0, 1),
			});
		})
		.onEnd(() => {
			commit(panId.value);
			panId.value = null;
		});

	const pinch = Gesture.Pinch()
		.enabled(interactive)
		.onStart((e) => {
			const id = selected.value ?? hitTest(e.focalX, e.focalY);
			pinchId.value = id;
			if (!id) return;
			select(id);
			pinchStart.value = positions.value[id]?.scale ?? 1;
		})
		.onUpdate((e) => {
			const id = pinchId.value;
			if (!id) return;
			update(id, {
				scale: clamp(pinchStart.value * e.scale, MIN_SCALE, MAX_SCALE),
			});
		})
		.onEnd(() => {
			commit(pinchId.value);
			pinchId.value = null;
		});

	const tap = Gesture.Tap()
		.enabled(interactive)
		.onEnd((e, success) => {
			if (success) select(hitTest(e.x, e.y));
		});

	const gesture = Gesture.Race(Gesture.Simultaneous(pan, pinch), tap);

	const outline = useDerivedValue(() => {
		const id = selected.value;
		const p = id ? positions.value[id] : undefined;
		const size = id ? sizes.value[id] : undefined;
		if (!p || !size) return Skia.RRectXY(Skia.XYWHRect(-20, -20, 0, 0), 0, 0);
		const { tx, ty, s } = placement(p, size.w, size.h, width, height);
		const pad = 6;
		return Skia.RRectXY(
			Skia.XYWHRect(
				tx - pad,
				ty - pad,
				size.w * s + pad * 2,
				size.h * s + pad * 2,
			),
			8,
			8,
		);
	});

	return (
		<GestureDetector gesture={gesture}>
			<View
				style={{ width, height }}
				accessible
				accessibilityLabel={accessibilityLabel}
			>
				<Canvas style={{ width, height }}>
					<Picture picture={backgroundPicture} />
					{built.map((b) => {
						const el = scene.elements.find((e) => e.id === b.id);
						return el ? (
							<PlacedElement
								key={b.id}
								built={b}
								base={el}
								positions={positions}
								width={width}
								height={height}
							/>
						) : null;
					})}
					{/* Two strokes, dark under bright, so the outline shows on any art. */}
					<RoundedRect
						rect={outline}
						style="stroke"
						strokeWidth={4}
						color="rgba(0,0,0,0.35)"
					/>
					<RoundedRect
						rect={outline}
						style="stroke"
						strokeWidth={2}
						color={selectionColor}
					/>
				</Canvas>
			</View>
		</GestureDetector>
	);
}

function PlacedElement({
	built,
	base,
	positions,
	width,
	height,
}: {
	built: BuiltElement;
	base: Placement;
	positions: SharedValue<Positions>;
	width: number;
	height: number;
}) {
	// Primitives only inside the worklet: the picture itself stays on the JS
	// side and is handed to Skia as a prop.
	const { id, width: w, height: h } = built;
	const { x, y, scale } = base;
	const transform = useDerivedValue(() => {
		const p = positions.value[id] ?? { x, y, scale };
		const { tx, ty, s } = placement(p, w, h, width, height);
		return [{ translateX: tx }, { translateY: ty }, { scale: s }];
	});
	return (
		<Group transform={transform}>
			<Picture picture={built.picture} />
		</Group>
	);
}
