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
	StatusBadge,
	When,
} from "@/components/panel";
import {
	api,
	type ContentStatus,
	errorMessage,
	type ReviewItem,
} from "@/lib/api";
import { canModerate } from "@/lib/session";

const QUEUES: { value: ContentStatus; label: string }[] = [
	{ value: "pending_review", label: "Awaiting review" },
	{ value: "published", label: "Published" },
	{ value: "rejected", label: "Rejected" },
	{ value: "removed", label: "Removed" },
];

export default function ModerationQueue() {
	return (
		<PanelShell allow={canModerate}>
			<Queue />
		</PanelShell>
	);
}

function Queue() {
	const [status, setStatus] = useState<ContentStatus>("pending_review");
	const [items, setItems] = useState<ReviewItem[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setItems(
				await api<ReviewItem[]>(`/v1/admin/content/queue?status=${status}`),
			);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [status]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<>
			<PageHeader
				description="Oldest first — a newest-first queue starves whatever is at the back, and a designer is waiting on every one of these."
				title="Review queue"
			/>

			<div className="mb-4 flex flex-wrap gap-1">
				{QUEUES.map((queue) => (
					<Button
						key={queue.value}
						onClick={() => setStatus(queue.value)}
						size="sm"
						variant={status === queue.value ? "secondary" : "ghost"}
					>
						{queue.label}
					</Button>
				))}
			</div>

			<ErrorNote message={error} />

			{loading ? (
				<Empty>Loading…</Empty>
			) : items.length === 0 ? (
				<Empty>
					{status === "pending_review"
						? "Nothing waiting. The queue is clear."
						: "Nothing here."}
				</Empty>
			) : (
				<List>
					{items.map((item) => (
						<Row href={`/moderation/content/${item.id}`} key={item.id}>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium text-sm">{item.title}</div>
								<div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
									<StatusBadge status={item.status} />
									<span>{item.designerName}</span>
									<span>{item.primaryLanguage}</span>
									<span>{item.regionCode ?? "All India"}</span>
								</div>
							</div>
							<div className="text-muted-foreground text-xs">
								<When value={item.submittedAt} />
							</div>
						</Row>
					))}
				</List>
			)}
		</>
	);
}
