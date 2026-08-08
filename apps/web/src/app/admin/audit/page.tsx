"use client";

import { Button } from "@greetings/ui/components/button";
import { useCallback, useEffect, useState } from "react";
import {
	Empty,
	ErrorNote,
	List,
	PageHeader,
	PanelShell,
	Row,
	When,
} from "@/components/panel";
import { api, errorMessage, type Page, type RoleChange } from "@/lib/api";
import { isSuperAdmin } from "@/lib/session";

interface ModerationAction {
	id: string;
	at: string;
	action: string;
	reason: string | null;
	contentId: string;
	contentTitle: string;
	actorId: string | null;
	actorName: string | null;
	actorRole: string | null;
}

export default function AuditPage() {
	return (
		<PanelShell allow={isSuperAdmin}>
			<Audit />
		</PanelShell>
	);
}

function Audit() {
	const [tab, setTab] = useState<"actions" | "roles">("actions");

	return (
		<>
			<PageHeader
				description="Who did what. Records are append-only — a correction is a new entry, never an edit — and names are looked up when you read this, so someone changing their display name never rewrites the past."
				title="Audit"
			/>

			<div className="mb-4 flex gap-1">
				<Button
					onClick={() => setTab("actions")}
					size="sm"
					variant={tab === "actions" ? "secondary" : "ghost"}
				>
					Moderation
				</Button>
				<Button
					onClick={() => setTab("roles")}
					size="sm"
					variant={tab === "roles" ? "secondary" : "ghost"}
				>
					Role changes
				</Button>
			</div>

			{tab === "actions" ? <Actions /> : <Roles />}
		</>
	);
}

/** Paged feed, shared shape between the two tabs. */
function usePaged<T>(path: string) {
	const [items, setItems] = useState<T[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const loadMore = useCallback(
		async (reset: boolean) => {
			setLoading(true);
			setError(null);
			try {
				const suffix = !reset && cursor ? `&cursor=${cursor}` : "";
				const page = await api<Page<T>>(`${path}?limit=25${suffix}`);
				setItems((current) =>
					reset ? page.items : [...current, ...page.items],
				);
				setCursor(page.nextCursor);
			} catch (cause) {
				setError(errorMessage(cause));
			} finally {
				setLoading(false);
			}
		},
		[path, cursor],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: loadMore changes identity whenever the cursor moves, so depending on it would reload page one after every "show older"
	useEffect(() => {
		void loadMore(true);
	}, []);

	return { items, cursor, error, loading, loadMore };
}

function Actions() {
	const { items, cursor, error, loading, loadMore } =
		usePaged<ModerationAction>("/v1/admin/audit/actions");

	return (
		<>
			<ErrorNote message={error} />
			{items.length === 0 && !loading ? (
				<Empty>Nothing recorded yet.</Empty>
			) : (
				<List>
					{items.map((entry) => (
						<Row href={`/admin/content/${entry.contentId}`} key={entry.id}>
							<div className="min-w-0 flex-1">
								<div className="text-sm">
									<span className="font-medium">{entry.action}</span>
									{" · "}
									<span className="truncate">{entry.contentTitle}</span>
								</div>
								<div className="mt-0.5 text-muted-foreground text-xs">
									{entry.actorName ?? "automatic"}
									{entry.actorRole ? ` · ${entry.actorRole}` : ""}
									{entry.reason ? ` — ${entry.reason}` : ""}
								</div>
							</div>
							<span className="text-muted-foreground text-xs">
								<When value={entry.at} />
							</span>
						</Row>
					))}
				</List>
			)}
			{cursor ? (
				<Button
					className="mt-3"
					disabled={loading}
					onClick={() => loadMore(false)}
					variant="outline"
				>
					{loading ? "Loading…" : "Show older"}
				</Button>
			) : null}
		</>
	);
}

function Roles() {
	const { items, cursor, error, loading, loadMore } = usePaged<RoleChange>(
		"/v1/admin/audit/roles",
	);

	return (
		<>
			<ErrorNote message={error} />
			{items.length === 0 && !loading ? (
				<Empty>No role has ever been changed.</Empty>
			) : (
				<List>
					{items.map((entry) => (
						<Row key={entry.id}>
							<div className="min-w-0 flex-1">
								<div className="text-sm">
									<span className="font-medium">{entry.targetName}</span>{" "}
									<span className="text-muted-foreground">
										{entry.fromRole} → {entry.toRole}
									</span>
								</div>
								<div className="mt-0.5 truncate text-muted-foreground text-xs">
									{entry.targetEmail} · by{" "}
									{/* Null actor is the seed script's bootstrap grant, or an
									    invite applying itself at first sign-in. */}
									{entry.actorName ?? "the system"}
									{entry.reason ? ` — ${entry.reason}` : ""}
								</div>
							</div>
							<span className="text-muted-foreground text-xs">
								<When value={entry.at} />
							</span>
						</Row>
					))}
				</List>
			)}
			{cursor ? (
				<Button
					className="mt-3"
					disabled={loading}
					onClick={() => loadMore(false)}
					variant="outline"
				>
					{loading ? "Loading…" : "Show older"}
				</Button>
			) : null}
		</>
	);
}
