import axios from "axios";
import * as Crypto from "expo-crypto";
import * as LegacyFileSystem from "expo-file-system/legacy";

import { api } from "./api";
import { queryClient } from "./query-client";
import type {
	AuthResponse,
	Design,
	DesignAssetPurpose,
	DesignsResponse,
	DownloadHistoryResponse,
	DownloadResponse,
	FeedResponse,
	Language,
	Region,
	ReportPayload,
	ReportResponse,
	SearchResponse,
	Tag,
	UpdateProfilePayload,
	UploadTicket,
	User,
	UserProfile,
} from "./types";

export async function authWithFirebase(idToken: string): Promise<AuthResponse> {
	const res = await api.post<AuthResponse>("/v1/auth/firebase", { idToken });
	return res.data;
}

export async function getMe(): Promise<User> {
	const res = await api.get<User>("/v1/auth/me");
	return res.data;
}

/**
 * Permanently deletes the signed-in account (Play requires it). The server
 * keeps download counts for designers but detaches them from the person.
 * Callers sign out afterwards; the session is already dead server-side.
 */
export async function deleteAccount(): Promise<void> {
	await api.delete("/v1/me");
}

export async function getProfile(): Promise<UserProfile> {
	const res = await api.get<UserProfile>("/v1/me/profile");
	return res.data;
}

export async function updateProfile(
	payload: UpdateProfilePayload,
): Promise<{ ok: boolean }> {
	const res = await api.put<{ ok: boolean }>("/v1/me/profile", payload);
	// Region and languages are two of the feed's three ranking signals, so a
	// cached feed is now ranked for someone else. Reset rather than refetched:
	// a refetch would replay every loaded page, a reset starts one fresh page 1
	// — at once if the feed tab is mounted, on next mount otherwise.
	void queryClient.resetQueries({ queryKey: ["feed"] });
	return res.data;
}

export async function getRegions(): Promise<Region[]> {
	const res = await api.get<Region[]>("/v1/regions");
	return res.data;
}

export async function getLanguages(): Promise<Language[]> {
	const res = await api.get<Language[]>("/v1/languages");
	return res.data;
}

export async function getTags(category?: string): Promise<Tag[]> {
	const res = await api.get<Tag[]>("/v1/tags", {
		params: category ? { category } : undefined,
	});
	return res.data;
}

export async function getFeed(
	cursor?: string | null,
	limit = 20,
): Promise<FeedResponse> {
	const res = await api.get<FeedResponse>("/v1/feed", {
		params: {
			cursor: cursor || undefined,
			limit,
		},
	});
	return res.data;
}

export async function searchContent(params: {
	q?: string;
	tags?: string;
	language?: string;
	region?: string;
	cursor?: string | null;
	limit?: number;
}): Promise<SearchResponse> {
	const res = await api.get<SearchResponse>("/v1/search", {
		params: {
			q: params.q || undefined,
			tags: params.tags || undefined,
			language: params.language || undefined,
			region: params.region || undefined,
			cursor: params.cursor || undefined,
			limit: params.limit || 20,
		},
	});
	return res.data;
}

export type DownloadSource = "feed" | "search" | "detail";

/**
 * Records a download and returns the URL to fetch the bytes from.
 *
 * This is the counted event — the one that credits the designer — so it is
 * called once per deliberate save or share, never to render anything.
 *
 * Retries once on a network failure *with the same idempotency key*, which the
 * server turns into "return the stored URL, do not count again" within 60s.
 * A fresh key per deliberate action, the same key for its retry: that is what
 * makes flaky connections safe without double-counting. §6.
 */
export async function downloadContent(
	id: string,
	source: DownloadSource = "detail",
	customized = false,
): Promise<DownloadResponse> {
	const idempotencyKey = Crypto.randomUUID();
	const send = () =>
		api.post<DownloadResponse>(
			`/v1/content/${id}/download`,
			{ source, customized },
			{ headers: { "Idempotency-Key": idempotencyKey }, timeout: 20_000 },
		);

	try {
		return (await send()).data;
	} catch (cause) {
		// No response at all means it may or may not have landed — exactly the
		// case the idempotency key exists for. A response (409, 429…) is final.
		if (axios.isAxiosError(cause) && !cause.response) {
			return (await send()).data;
		}
		throw cause;
	}
}

export async function reportContent(
	id: string,
	payload: ReportPayload,
): Promise<ReportResponse> {
	const res = await api.post<ReportResponse>(
		`/v1/content/${id}/report`,
		payload,
	);
	return res.data;
}

export async function getDownloadHistory(
	cursor?: string | null,
	limit = 20,
): Promise<DownloadHistoryResponse> {
	const res = await api.get<DownloadHistoryResponse>("/v1/me/downloads", {
		params: {
			cursor: cursor || undefined,
			limit,
		},
	});
	return res.data;
}

export async function getDesigns(
	cursor?: string | null,
	limit = 20,
): Promise<DesignsResponse> {
	const res = await api.get<DesignsResponse>("/v1/me/designs", {
		params: {
			cursor: cursor || undefined,
			limit,
		},
	});
	return res.data;
}

export async function getDesign(id: string): Promise<Design> {
	const res = await api.get<Design>(`/v1/me/designs/${id}`);
	return res.data;
}

export async function createDesign(payload: {
	title: string;
	designJson: Record<string, unknown>;
}): Promise<Design> {
	const res = await api.post<Design>("/v1/me/designs", payload);
	return res.data;
}

export async function patchDesign(
	id: string,
	payload: { title?: string; designJson?: Record<string, unknown> },
): Promise<Design> {
	const res = await api.patch<Design>(`/v1/me/designs/${id}`, payload);
	return res.data;
}

// ---------------------------------------------------------------------------
// Uploads: sign → PUT straight to R2 → confirm. §3 "The logo", §10.
// ---------------------------------------------------------------------------

export type UploadMimeType = "image/jpeg" | "image/png" | "image/webp";

/**
 * PUTs a local file to a presigned URL with exactly the content type that was
 * declared when signing — R2 rejects the upload if they differ.
 *
 * The legacy uploadAsync because it streams from disk natively; reading a
 * 5 MB image into a JS string first would be slow on the phones this targets.
 */
async function putToSignedUrl(
	uploadUrl: string,
	fileUri: string,
	mimeType: UploadMimeType,
): Promise<void> {
	const result = await LegacyFileSystem.uploadAsync(uploadUrl, fileUri, {
		httpMethod: "PUT",
		uploadType: LegacyFileSystem.FileSystemUploadType.BINARY_CONTENT,
		headers: { "content-type": mimeType },
	});
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`Upload failed with status ${result.status}`);
	}
}

/** Uploads a new logo. Replaces the old one, under a new key. 5 MB max. */
export async function uploadAvatar(file: {
	uri: string;
	mimeType: UploadMimeType;
	bytes: number;
}): Promise<{ avatarKey: string; avatarUrl: string | null }> {
	const ticket = (
		await api.post<UploadTicket>("/v1/me/avatar/upload-url", {
			mimeType: file.mimeType,
			bytes: file.bytes,
		})
	).data;
	await putToSignedUrl(ticket.uploadUrl, file.uri, file.mimeType);
	// Not a formality: the server HEADs the object and only then points the
	// profile at it. Skip this and the old logo silently stays.
	const res = await api.post<{ avatarKey: string; avatarUrl: string | null }>(
		"/v1/me/avatar",
		{ storageKey: ticket.storageKey },
	);
	return res.data;
}

export async function deleteAvatar(): Promise<void> {
	await api.delete("/v1/me/avatar");
}

/**
 * Attaches an image to a design: its one source image, or its flattened
 * preview. Same three steps as the logo; 10 MB max.
 */
export async function uploadDesignAsset(
	designId: string,
	purpose: DesignAssetPurpose,
	file: { uri: string; mimeType: UploadMimeType; bytes: number },
): Promise<Design> {
	const ticket = (
		await api.post<UploadTicket>(`/v1/me/designs/${designId}/upload-url`, {
			purpose,
			mimeType: file.mimeType,
			bytes: file.bytes,
		})
	).data;
	await putToSignedUrl(ticket.uploadUrl, file.uri, file.mimeType);
	const res = await api.post<Design>(`/v1/me/designs/${designId}/assets`, {
		purpose,
		storageKey: ticket.storageKey,
	});
	return res.data;
}
