/**
 * The one way this app talks to the backend.
 *
 * Every panel request goes through `api()`. Two things are centralised here
 * because getting either wrong in one place is a bug that only shows up in one
 * screen:
 *
 *   - `credentials: "include"`. The session is a cookie set by the API on a
 *     different origin, so without this every request is anonymous and every
 *     screen shows a login prompt for no visible reason.
 *   - Unwrapping the error envelope. The API answers failures with
 *     `{ error: { code, message } }`; a caller that reads `res.ok` and moves on
 *     shows the user "something went wrong" when the server said exactly what
 *     was wrong and why.
 */

import { env } from "@greetings/env/web";

const BASE = env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, "");

/** A failure the server described. `code` is a closed set — branch on it. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}
}

/**
 * Called whenever the server says the caller is not authenticated.
 *
 * A session can expire while someone is sitting on a screen. Without this, the
 * next action shows "Authentication required" in a red box and the person is
 * stuck: the panel still looks signed in, because the session was checked once
 * at mount and never again. The provider registers a handler that clears the
 * session, which sends them to the sign-in page.
 */
let onUnauthenticated: (() => void) | null = null;

export function setUnauthenticatedHandler(handler: (() => void) | null) {
	onUnauthenticated = handler;
}

export interface ApiOptions {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	body?: unknown;
	/** Extra headers, e.g. an Idempotency-Key. */
	headers?: Record<string, string>;
}

export async function api<T>(
	path: string,
	options: ApiOptions = {},
): Promise<T> {
	const { method = "GET", body, headers = {} } = options;

	const response = await fetch(`${BASE}${path}`, {
		method,
		credentials: "include",
		headers: {
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const text = await response.text();
	const parsed: unknown = text ? safeJson(text) : null;

	if (!response.ok) {
		const envelope = parsed as {
			error?: { code?: string; message?: string; details?: unknown };
		} | null;

		if (response.status === 401) onUnauthenticated?.();

		throw new ApiError(
			response.status,
			envelope?.error?.code ?? "UNKNOWN",
			envelope?.error?.message ?? `Request failed (${response.status})`,
			envelope?.error?.details,
		);
	}

	return parsed as T;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Turns anything thrown into something worth showing a person. */
export function errorMessage(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return "Something went wrong.";
}

// --- Shapes the panels rely on -------------------------------------------
//
// Hand-written rather than generated. These endpoints are consumed only by
// this app, in this repository, so a type error at build time catches drift
// sooner and cheaper than a codegen step would. The mobile contract is the
// one that crosses a team boundary, and that one is validated at runtime by
// the server's own response schemas.

export type ContentStatus =
	| "draft"
	| "pending_review"
	| "published"
	| "rejected"
	| "removed";

export type UserRole = "user" | "designer" | "admin" | "super_admin";

export interface CurrentUser {
	id: string;
	email: string;
	name: string;
	role: UserRole;
}

export interface Asset {
	id: string;
	storageKey: string;
	mimeType: string;
	width: number;
	height: number;
	bytes: number;
	/** Null when the deployment has no storage credentials configured. */
	previewUrl: string | null;
}

export interface Tag {
	id: string;
	slug: string;
	label: string;
	category: string;
}

/**
 * The five tag groupings.
 *
 * A closed list because the server column is a Postgres enum: adding a sixth is
 * a migration, not a runtime edit. Kept here so the editor offers exactly what
 * the API will accept rather than a free-text field that fails on submit.
 */
export const TAG_CATEGORIES = [
	"festival",
	"language",
	"region",
	"theme",
	"occasion",
] as const;

export type TagCategory = (typeof TAG_CATEGORIES)[number];

/** A tag as the taxonomy editor sees it: retired ones included, with usage. */
export interface TaxonomyTag {
	id: string;
	slug: string;
	label: string;
	category: TagCategory;
	isActive: boolean;
	usageCount: number;
}

export interface TaxonomyLanguage {
	code: string;
	name: string;
	nativeName: string;
	isActive: boolean;
	contentCount: number;
}

export interface TaxonomyRegion {
	code: string;
	name: string;
	isActive: boolean;
	contentCount: number;
}

export interface ReferenceChange {
	id: string;
	entity: "tag" | "language" | "region";
	entityKey: string;
	action: "create" | "update" | "activate" | "deactivate" | "delete";
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	createdAt: string;
	actorId: string | null;
}

export interface DesignerContentSummary {
	id: string;
	title: string;
	status: ContentStatus;
	primaryLanguage: string;
	regionCode: string | null;
	downloadCount: number;
	rejectionReason: string | null;
	submittedAt: string | null;
	publishedAt: string | null;
	createdAt: string;
}

export interface DesignerContentDetail extends DesignerContentSummary {
	description: string | null;
	visibilityHold: boolean;
	tags: { id: string; slug: string; label: string }[];
	assets: Asset[];
}

export interface ReviewItem {
	id: string;
	title: string;
	description: string | null;
	status: ContentStatus;
	primaryLanguage: string;
	regionCode: string | null;
	submittedAt: string | null;
	designerId: string;
	designerName: string;
	availableActions: string[];
}

export interface ReviewDetail extends ReviewItem {
	visibilityHold: boolean;
	rejectionReason: string | null;
	publishedAt: string | null;
	assets: Asset[];
	history: {
		action: string;
		reason: string | null;
		actorId: string | null;
		actorName: string | null;
		actorRole: string | null;
		createdAt: string;
	}[];
}

export interface ReportGroup {
	contentId: string;
	reportCount: number;
	latestReportId: string;
	firstReportedAt: string;
	reasons: string[];
	title: string;
	designerId: string;
	contentStatus: ContentStatus;
	visibilityHold: boolean;
}

export interface AdminContentRow {
	id: string;
	title: string;
	status: ContentStatus;
	primaryLanguage: string;
	regionCode: string | null;
	visibilityHold: boolean;
	downloadCount: number;
	createdAt: string;
	submittedAt: string | null;
	publishedAt: string | null;
	designerId: string;
	designerName: string;
	openReports: number;
}

export interface TimelineEntry {
	/** Stable across requests — safe to use as a React key. */
	id: string;
	kind: string;
	at: string;
	actor: { id: string; name: string | null; role: string | null } | null;
	reason: string | null;
	note: string | null;
}

export interface ContentAudit {
	content: {
		id: string;
		title: string;
		status: ContentStatus;
		visibilityHold: boolean;
		createdAt: string;
		publishedAt: string | null;
		removedAt: string | null;
		downloadCount: number;
		designerId: string;
		designerName: string;
		designerEmail: string;
	};
	timeline: TimelineEntry[];
}

export interface DirectoryUser {
	id: string;
	name: string;
	email: string;
	role: UserRole;
	createdAt: string;
	phone: string | null;
	regionCode: string | null;
	onboardedAt: string | null;
	contentCount: number;
	roleChangedAt: string | null;
}

export interface RoleChange {
	id: string;
	at: string;
	fromRole: UserRole;
	toRole: UserRole;
	reason: string | null;
	actorId: string | null;
	actorName: string | null;
	targetId: string;
	targetName: string;
	targetEmail: string;
}

export interface CreatedAccount {
	userId: string;
	email: string;
	role: UserRole;
}

export interface RoleInvite {
	id: string;
	email: string | null;
	phone: string | null;
	role: UserRole;
	createdAt: string;
	consumedAt: string | null;
	revokedAt: string | null;
}

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}
