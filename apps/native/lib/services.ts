import { api } from "./api";
import type {
	AuthResponse,
	Design,
	DesignSummary,
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
	UserProfile,
} from "./types";

export async function authWithFirebase(idToken: string): Promise<AuthResponse> {
	const res = await api.post<AuthResponse>("/v1/auth/firebase", { idToken });
	return res.data;
}

export async function getProfile(): Promise<UserProfile> {
	const res = await api.get<UserProfile>("/v1/me/profile");
	return res.data;
}

export async function updateProfile(payload: UpdateProfilePayload): Promise<{ ok: boolean }> {
	const res = await api.put<{ ok: boolean }>("/v1/me/profile", payload);
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

export async function getFeed(cursor?: string | null, limit = 20): Promise<FeedResponse> {
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

function generateUUID(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

export async function downloadContent(
	id: string,
	source: "feed" | "search" | "detail" = "detail",
	customized = false
): Promise<DownloadResponse> {
	const idempotencyKey = generateUUID();
	const res = await api.post<DownloadResponse>(
		`/v1/content/${id}/download`,
		{ source, customized },
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		}
	);
	return res.data;
}

export async function reportContent(id: string, payload: ReportPayload): Promise<ReportResponse> {
	const res = await api.post<ReportResponse>(`/v1/content/${id}/report`, payload);
	return res.data;
}

export async function getDownloadHistory(cursor?: string | null, limit = 20): Promise<DownloadHistoryResponse> {
	const res = await api.get<DownloadHistoryResponse>("/v1/me/downloads", {
		params: {
			cursor: cursor || undefined,
			limit,
		},
	});
	return res.data;
}

export async function getDesigns(cursor?: string | null, limit = 20): Promise<DesignsResponse> {
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

export async function createDesign(payload: { title: string; designJson: Record<string, unknown> }): Promise<Design> {
	const res = await api.post<Design>("/v1/me/designs", payload);
	return res.data;
}

export async function patchDesign(
	id: string,
	payload: { title?: string; designJson?: Record<string, unknown> }
): Promise<Design> {
	const res = await api.patch<Design>(`/v1/me/designs/${id}`, payload);
	return res.data;
}
