import type { SkImage } from "@shopify/react-native-skia";
import { useEffect, useState } from "react";

import { loadSkImage } from "@/lib/media";

export type SkImageState =
	| { status: "idle" | "loading" | "error"; image: null }
	| { status: "ready"; image: SkImage };

/**
 * Decodes an image (remote or local) into Skia for drawing, and disposes it
 * when the uri changes or the screen goes away.
 *
 * Disposal is the point of this hook: a decoded 1080px image is ~4 MB of
 * native memory that the JS garbage collector cannot see, so it will not be
 * reclaimed promptly on its own.
 */
export function useSkImage(uri: string | null): {
	state: SkImageState;
	retry: () => void;
} {
	const [state, setState] = useState<SkImageState>({
		status: uri ? "loading" : "idle",
		image: null,
	});
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!uri) {
			setState({ status: "idle", image: null });
			return;
		}
		let live = true;
		let loaded: SkImage | null = null;
		setState({ status: "loading", image: null });
		loadSkImage(uri).then(
			(image) => {
				if (live) {
					loaded = image;
					setState({ status: "ready", image });
				} else {
					image.dispose();
				}
			},
			() => {
				if (live) setState({ status: "error", image: null });
			},
		);
		return () => {
			live = false;
			loaded?.dispose();
		};
	}, [uri, attempt]);

	return { state, retry: () => setAttempt((n) => n + 1) };
}
