/**
 * Response compression (spec §12.6).
 *
 * The audience is on Indian mobile networks, where the round trip and the bytes
 * cost far more than the CPU to shrink them. A feed page is JSON — highly
 * repetitive keys, long storage keys, ISO timestamps — which gzip takes down by
 * roughly three quarters.
 *
 * Hand-rolled rather than a plugin, because it is thirty lines and Bun ships
 * the codecs. The parts that matter are the ones a naive version gets wrong:
 *
 *   - **Only when asked.** A client that did not send `accept-encoding` gets
 *     bytes it can read.
 *   - **Not below a threshold.** Under about a kilobyte the gzip header and the
 *     CPU cost more than the saving, and for the smallest responses the
 *     compressed form is larger than the original.
 *   - **Never twice.** Anything already carrying `content-encoding` is left
 *     alone.
 *   - **`Vary: accept-encoding`.** Without it a shared cache can hand a gzipped
 *     body to a client that cannot decode it.
 */

import { Elysia } from "elysia";

/**
 * Below this, compression is not worth it.
 *
 * A feed page or a tag list is comfortably above; an `{ok:true}` or an error
 * envelope is comfortably below and is left alone.
 */
const MIN_BYTES = 1024;

/** Types worth compressing. Images and video are already compressed. */
function isCompressible(contentType: string | null): boolean {
	if (!contentType) return false;
	return (
		contentType.includes("json") ||
		contentType.includes("text/") ||
		contentType.includes("javascript") ||
		contentType.includes("xml")
	);
}

function chosenEncoding(accept: string | null): "gzip" | "deflate" | null {
	if (!accept) return null;
	const lower = accept.toLowerCase();
	// gzip first: universally supported, and the difference against deflate is
	// not worth preferring the less compatible one.
	if (lower.includes("gzip")) return "gzip";
	if (lower.includes("deflate")) return "deflate";
	return null;
}

export const compression = new Elysia({ name: "compression" }).mapResponse(
	{ as: "global" },
	({ response, set, request }) => {
		// Already encoded, or something this should not touch.
		if (set.headers["content-encoding"]) return;

		const encoding = chosenEncoding(request.headers.get("accept-encoding"));
		if (!encoding) return;

		// Only bodies this layer produced as text. A Response the handler built
		// itself is left alone: it may be a stream, and buffering it here to
		// compress would undo the reason it was streamed.
		let body: string;
		let contentType: string;

		if (typeof response === "string") {
			body = response;
			contentType = String(set.headers["content-type"] ?? "text/plain");
		} else if (
			response !== null &&
			typeof response === "object" &&
			!(response instanceof Response) &&
			!(response instanceof Blob) &&
			!(response instanceof ArrayBuffer)
		) {
			body = JSON.stringify(response);
			contentType = "application/json";
		} else {
			return;
		}

		if (!isCompressible(contentType)) return;

		const raw = Buffer.from(body, "utf8");
		if (raw.byteLength < MIN_BYTES) return;

		const compressed =
			encoding === "gzip" ? Bun.gzipSync(raw) : Bun.deflateSync(raw);

		// Refuse to make it worse. Rare for JSON above the threshold, but a body
		// of random-looking data (base64, a long cursor) can grow.
		if (compressed.byteLength >= raw.byteLength) return;

		set.headers["content-encoding"] = encoding;
		set.headers["content-type"] = contentType;
		// Without this a shared cache can serve the gzipped body to a client that
		// never asked for one.
		set.headers.vary = set.headers.vary
			? `${set.headers.vary}, accept-encoding`
			: "accept-encoding";

		// biome-ignore lint/suspicious/noExplicitAny: Response accepts a Uint8Array at runtime; the DOM lib this project compiles against does not model that
		return new Response(compressed as any, {
			headers: set.headers as Record<string, string>,
			status: (set.status as number) ?? 200,
		});
	},
);
