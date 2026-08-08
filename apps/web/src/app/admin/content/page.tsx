"use client";

import { Input } from "@greetings/ui/components/input";
import { useCallback, useEffect, useState } from "react";
import {
	Empty,
	ErrorNote,
	List,
	PageHeader,
	PanelShell,
	Row,
	StatusBadge,
	When,
} from "@/components/panel";
import {
	type AdminContentRow,
	api,
	type ContentStatus,
	errorMessage,
} from "@/lib/api";
import { isSuperAdmin } from "@/lib/session";

const STATUSES: { value: ContentStatus | ""; label: string }[] = [
	{ value: "", label: "Any status" },
	{ value: "draft", label: "Draft" },
	{ value: "pending_review", label: "In review" },
	{ value: "published", label: "Published" },
	{ value: "rejected", label: "Rejected" },
	{ value: "removed", label: "Removed" },
];

export default function AdminContentSearch() {
	return (
		<PanelShell allow={isSuperAdmin}>
			<Search />
		</PanelShell>
	);
}

function Search() {
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<ContentStatus | "">("");
	const [rows, setRows] = useState<AdminContentRow[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		const params = new URLSearchParams();
		if (query.trim()) params.set("q", query.trim());
		if (status) params.set("status", status);
		try {
			setRows(await api<AdminContentRow[]>(`/v1/admin/content?${params}`));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [query, status]);

	useEffect(() => {
		const timer = setTimeout(() => void load(), 250);
		return () => clearTimeout(timer);
	}, [load]);

	return (
		<>
			<PageHeader
				description="Every item in every state, including removed and never-submitted. Open one to see its full history."
				title="All content"
			/>

			<div className="mb-4 flex flex-wrap gap-2">
				<Input
					className="max-w-sm"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Title, or paste an item id"
					value={query}
				/>
				<select
					className="h-8 border bg-background px-2 text-sm"
					onChange={(event) =>
						setStatus(event.target.value as ContentStatus | "")
					}
					value={status}
				>
					{STATUSES.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>

			<ErrorNote message={error} />

			{loading ? (
				<Empty>Loading…</Empty>
			) : rows.length === 0 ? (
				<Empty>Nothing matches.</Empty>
			) : (
				<List>
					{rows.map((row) => (
						<Row href={`/admin/content/${row.id}`} key={row.id}>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium text-sm">{row.title}</div>
								<div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
									<StatusBadge held={row.visibilityHold} status={row.status} />
									<span>{row.designerName}</span>
									<span>
										<When value={row.createdAt} />
									</span>
									{row.openReports > 0 ? (
										<span className="text-destructive">
											{row.openReports} open{" "}
											{row.openReports === 1 ? "report" : "reports"}
										</span>
									) : null}
								</div>
							</div>
							<div className="text-right text-sm tabular-nums">
								<div className="font-medium">{row.downloadCount}</div>
								<div className="text-muted-foreground text-xs">downloads</div>
							</div>
						</Row>
					))}
				</List>
			)}
		</>
	);
}
