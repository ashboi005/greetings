import { env } from "@greetings/env/native";
import axios from "axios";
import { PixelRatio } from "react-native";
import { TOKEN_STORAGE_KEY, tokenStorage } from "./storage";

export const api = axios.create({
	baseURL:
		env.EXPO_PUBLIC_SERVER_URL || "https://greetings-api.ashwathsoni.dev",
	headers: {
		"Content-Type": "application/json",
	},
});

api.interceptors.request.use(async (config) => {
	const token = await tokenStorage.getItem(TOKEN_STORAGE_KEY);
	if (token) {
		config.headers.Authorization = `Bearer ${token}`;
	}
	return config;
});

let onUnauthenticatedHandler: (() => void) | null = null;

export function setUnauthenticatedHandler(handler: () => void) {
	onUnauthenticatedHandler = handler;
}

api.interceptors.response.use(
	(response) => response,
	async (error) => {
		if (error.response?.status === 401) {
			await tokenStorage.deleteItem(TOKEN_STORAGE_KEY);
			if (onUnauthenticatedHandler) {
				onUnauthenticatedHandler();
			}
		}
		return Promise.reject(error);
	},
);

/**
 * The server's error envelope: `{ error: { code, message, details } }`.
 *
 * Every endpoint uses it, so unwrapping belongs here once rather than in each
 * screen's catch block.
 */
interface ApiErrorEnvelope {
	error?: { code?: string; message?: string };
}

/**
 * The message to show someone for a failed request.
 *
 * `unknown` rather than `any` on purpose: a catch block's binding could be
 * anything at all, and typing it `any` turns every property access below into
 * an unchecked guess. The narrowing here is the part worth having.
 *
 * `fallback` is used when the failure carries no envelope — a DNS failure, a
 * timeout, a proxy's own error page. Those have no message fit to show anyone.
 */
export function apiErrorMessage(cause: unknown, fallback: string): string {
	if (!axios.isAxiosError<ApiErrorEnvelope>(cause)) return fallback;
	return cause.response?.data?.error?.message ?? fallback;
}

/**
 * The server's error `code` for a failed request, or null if it sent none.
 *
 * Branch on this rather than on the status or the message: the message is
 * written for humans and gets reworded, and the code is the closed set the API
 * actually promises. See docs/mobile-integration.md §1.
 */
export function apiErrorCode(cause: unknown): string | null {
	if (!axios.isAxiosError<ApiErrorEnvelope>(cause)) return null;
	return cause.response?.data?.error?.code ?? null;
}

/**
 * Transforms a raw CDN image URL using Cloudflare cdn-cgi prefix.
 * Example format: https://cdn.example.com/cdn-cgi/image/width=400,format=auto/content/xyz.webp
 */
export function transformImageUrl(
	imageUrl: string | null | undefined,
	opts: string,
): string | null {
	if (!imageUrl) return null;
	try {
		const u = new URL(imageUrl);
		return `${u.origin}/cdn-cgi/image/${opts}${u.pathname}`;
	} catch {
		return imageUrl;
	}
}

export function getThumbnailUrl(
	imageUrl: string | null | undefined,
	width = 180,
): string | null {
	if (!imageUrl) return null;
	const pixelWidth = Math.round(width * PixelRatio.get());
	return transformImageUrl(
		imageUrl,
		`width=${pixelWidth},format=auto,quality=80,fit=scale-down`,
	);
}
