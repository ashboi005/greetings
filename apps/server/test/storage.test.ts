/**
 * Covers the real R2 adapter's URL signing.
 *
 * The in-memory fake used everywhere else deliberately returns made-up URLs,
 * so this is the only place the actual signing path runs. Presigning is pure
 * computation — no network — so it can be asserted directly with throwaway
 * credentials.
 */

import { describe, expect, test } from "bun:test";
import { AppError } from "../src/lib/errors";
import { createR2Storage, requireObjectStorage } from "../src/lib/storage";

const config = {
	accountId: "test-account",
	accessKeyId: "AKIATESTKEY",
	secretAccessKey: "test-secret-key",
	bucket: "greetings-content",
};

describe("R2 presigning", () => {
	test("signs an upload URL against the account's R2 endpoint", () => {
		const url = createR2Storage(config).presignUpload({
			key: "content/abc/image.jpg",
			contentType: "image/jpeg",
			expiresInSeconds: 900,
		});

		const parsed = new URL(url);
		expect(parsed.host).toBe("test-account.r2.cloudflarestorage.com");
		expect(parsed.pathname).toBe("/greetings-content/content/abc/image.jpg");
		expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
		expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900");
		expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
		// Credentials must never appear in the query beyond the scoped
		// access-key id that SigV4 requires.
		expect(url).not.toContain(config.secretAccessKey);
	});

	test("download URLs differ from upload URLs for the same key", () => {
		const storage = createR2Storage(config);
		const key = "content/abc/image.jpg";

		const put = storage.presignUpload({
			key,
			contentType: "image/jpeg",
			expiresInSeconds: 300,
		});
		const get = storage.presignDownload({ key, expiresInSeconds: 300 });

		expect(put).not.toBe(get);
		expect(new URL(get).searchParams.get("X-Amz-Signature")).not.toBe(
			new URL(put).searchParams.get("X-Amz-Signature"),
		);
	});

	test("distinct keys produce distinct signatures", () => {
		const storage = createR2Storage(config);
		const a = storage.presignDownload({ key: "a.jpg", expiresInSeconds: 60 });
		const b = storage.presignDownload({ key: "b.jpg", expiresInSeconds: 60 });
		expect(a).not.toBe(b);
	});
});

describe("requireObjectStorage", () => {
	test("returns the injected override without needing configuration", () => {
		const fake = {} as never;
		expect(requireObjectStorage({}, fake)).toBe(fake);
	});

	test("fails with a clear message when R2 is unconfigured", () => {
		expect(() => requireObjectStorage({})).toThrow(AppError);
		try {
			requireObjectStorage({});
		} catch (err) {
			expect((err as AppError).code).toBe("INTERNAL");
			expect((err as AppError).message).toContain("R2_");
		}
	});

	test("fails when only some credentials are present", () => {
		expect(() => requireObjectStorage({ accountId: "a", bucket: "b" })).toThrow(
			AppError,
		);
	});
});
