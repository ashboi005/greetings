export interface User {
	id: string;
	email: string;
	name: string;
	role: string;
}

export interface AuthResponse {
	token: string;
	user: User;
	onboarded: boolean;
	created: boolean;
}

export interface UserProfile {
	displayName: string | null;
	phone: string | null;
	designation: string | null;
	contactPhone: string | null;
	avatarKey: string | null;
	avatarUrl: string | null;
	regionCode: string | null;
	languages: string[];
	onboarded: boolean;
}

export interface UpdateProfilePayload {
	regionCode: string;
	languages: string[];
	displayName?: string;
	designation?: string;
	contactPhone?: string;
}

export interface Region {
	code: string;
	name: string;
}

export interface Language {
	code: string;
	name: string;
	nativeName: string;
}

export interface Tag {
	id: string;
	slug: string;
	label: string;
	category: string;
}

export interface Designer {
	id: string;
	name: string;
}

export interface FeedItem {
	id: string;
	title: string;
	description: string | null;
	primaryLanguage: string;
	regionCode: string | null;
	downloadCount: number;
	publishedAt: string;
	designer: Designer;
	storageKey: string | null;
	imageUrl: string | null;
}

export interface FeedResponse {
	items: FeedItem[];
	nextCursor: string | null;
}

export interface SearchResponse {
	items: (FeedItem & { rank?: number })[];
	nextCursor: string | null;
}

export interface DownloadResponse {
	url: string;
	expiresInSeconds: number | null;
	recorded: boolean;
}

export interface ReportPayload {
	reason: "inappropriate" | "copyright" | "spam" | "wrong_info" | "other";
	note?: string;
}

export interface ReportResponse {
	id: string;
	status: string;
	heldForReview: boolean;
}

export interface DownloadHistoryItem {
	id: string;
	title: string;
	designer: Designer;
	imageUrl: string | null;
	lastDownloadedAt: string;
	timesDownloaded: number;
}

export interface DownloadHistoryResponse {
	items: DownloadHistoryItem[];
	nextCursor: string | null;
}

export interface DesignSummary {
	id: string;
	title: string;
	sourceImageUrl: string | null;
	previewUrl: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Design extends DesignSummary {
	designJson: Record<string, unknown>;
}

export interface DesignsResponse {
	items: DesignSummary[];
	nextCursor: string | null;
}

export interface ApiErrorResponse {
	error: {
		code: string;
		message: string;
		details: Record<string, unknown> | null;
	};
}

export type DesignAssetPurpose = "source" | "preview";

/** A presigned upload: PUT the bytes to `uploadUrl`, then confirm `storageKey`. */
export interface UploadTicket {
	storageKey: string;
	uploadUrl: string;
	expiresInSeconds: number;
}
