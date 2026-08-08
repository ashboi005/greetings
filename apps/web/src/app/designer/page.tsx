"use client";

import { Button } from "@greetings/ui/components/button";
import Link from "next/link";
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
	api,
	type ContentStatus,
	type DesignerContentSummary,
	errorMessage,
} from "@/lib/api";
import { isDesigner } from "@/lib/session";

const FILTERS: { value: ContentStatus | "all"; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "draft", label: "Drafts" },
	{ value: "pending_review", label: "In review" },
	{ value: "published", label: "Published" },
	{ value: "rejected", label: "Needs changes" },
];

export default function DesignerHome() {
	return (
		<PanelShell allow={isDesigner}>
			<DesignerContentList />
		</PanelShell>
	);
}

function DesignerContentList() {
	const [items, setItems] = useState<DesignerContentSummary[]>([]);
	const [filter, setFilter] = useState<ContentStatus | "all">("all");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const query = filter === "all" ? "" : `?status=${filter}`;
			setItems(
				await api<DesignerContentSummary[]>(`/v1/designer/content${query}`),
			);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [filter]);

	useEffect(() => {
		void load();
	}, [load]);

	// Rejections are the only thing here that needs acting on, so they are
	// counted up front rather than left to be discovered by scrolling.
	const rejected = items.filter((item) => item.status === "rejected").length;

	return (
		<>
			<PageHeader
				action={
					<Button render={<Link href="/designer/new" />}>New image</Button>
				}
				description={
					rejected > 0
						? `${rejected} ${rejected === 1 ? "item needs" : "items need"} changes before they can go live.`
						: "Everything you have made, and where it is in review."
				}
				title="My content"
			/>

			<div className="mb-4 flex flex-wrap gap-1">
				{FILTERS.map((option) => (
					<Button
						key={option.value}
						onClick={() => setFilter(option.value)}
						size="sm"
						variant={filter === option.value ? "secondary" : "ghost"}
					>
						{option.label}
					</Button>
				))}
			</div>

			<ErrorNote message={error} />

			{loading ? (
				<Empty>Loading…</Empty>
			) : items.length === 0 ? (
				<Empty>
					{filter === "all"
						? "Nothing yet. Start with “New image”."
						: "Nothing in this state."}
				</Empty>
			) : (
				<List>
					{items.map((item) => (
						<Row href={`/designer/content/${item.id}`} key={item.id}>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium text-sm">{item.title}</div>
								<div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
									<StatusBadge status={item.status} />
									<span>{item.primaryLanguage}</span>
									<span>{item.regionCode ?? "All India"}</span>
									<span>
										<When value={item.createdAt} />
									</span>
								</div>
								{item.status === "rejected" && item.rejectionReason ? (
									<p className="mt-2 text-destructive text-xs">
										{item.rejectionReason}
									</p>
								) : null}
							</div>
							<div className="text-right text-sm tabular-nums">
								<div className="font-medium">{item.downloadCount}</div>
								<div className="text-muted-foreground text-xs">downloads</div>
							</div>
						</Row>
					))}
				</List>
			)}
		</>
	);
}
