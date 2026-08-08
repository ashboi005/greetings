"use client";

import { Button } from "@greetings/ui/components/button";
import { Input } from "@greetings/ui/components/input";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	Empty,
	ErrorNote,
	PageHeader,
	PanelShell,
	StatusBadge,
	When,
} from "@/components/panel";
import { api, errorMessage, type ReportGroup } from "@/lib/api";
import { canModerate } from "@/lib/session";

export default function ReportsPage() {
	return (
		<PanelShell allow={canModerate}>
			<Reports />
		</PanelShell>
	);
}

function Reports() {
	const [groups, setGroups] = useState<ReportGroup[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [notes, setNotes] = useState<Record<string, string>>({});

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setGroups(await api<ReportGroup[]>("/v1/admin/reports"));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const resolve = async (group: ReportGroup, action: "keep" | "remove") => {
		setBusy(group.contentId);
		setError(null);
		try {
			await api(`/v1/admin/reports/${group.latestReportId}/resolve`, {
				method: "POST",
				body: { action, note: notes[group.contentId]?.trim() || undefined },
			});
			toast.success(action === "keep" ? "Kept" : "Removed");
			await load();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			<PageHeader
				description="Grouped by item, most-reported first. Deciding once settles every open report on that item — the decision is about the content, not the individual report."
				title="Reports"
			/>

			<ErrorNote message={error} />

			{loading ? (
				<Empty>Loading…</Empty>
			) : groups.length === 0 ? (
				<Empty>No open reports.</Empty>
			) : (
				<div className="space-y-3">
					{groups.map((group) => (
						<div className="border p-4" key={group.contentId}>
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div className="min-w-0 flex-1">
									<Link
										className="font-medium text-sm hover:underline"
										href={`/moderation/content/${group.contentId}`}
									>
										{group.title}
									</Link>
									<div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
										<StatusBadge
											held={group.visibilityHold}
											status={group.contentStatus}
										/>
										<span>{group.reasons.join(", ")}</span>
										<span>
											first <When value={group.firstReportedAt} />
										</span>
									</div>
								</div>
								<div className="text-right">
									<div className="font-semibold text-lg tabular-nums">
										{group.reportCount}
									</div>
									<div className="text-muted-foreground text-xs">
										{group.reportCount === 1 ? "report" : "reports"}
									</div>
								</div>
							</div>

							<div className="mt-3 flex flex-wrap items-center gap-2">
								<Input
									className="max-w-xs"
									maxLength={500}
									onChange={(event) =>
										setNotes((current) => ({
											...current,
											[group.contentId]: event.target.value,
										}))
									}
									placeholder="Note (optional)"
									value={notes[group.contentId] ?? ""}
								/>
								<Button
									disabled={busy === group.contentId}
									onClick={() => resolve(group, "keep")}
									size="sm"
									variant="outline"
								>
									Keep
								</Button>
								<Button
									disabled={busy === group.contentId}
									onClick={() => resolve(group, "remove")}
									size="sm"
									variant="destructive"
								>
									Remove
								</Button>
							</div>

							{group.visibilityHold ? (
								<p className="mt-2 text-muted-foreground text-xs">
									Enough people reported this that it was hidden automatically.
									Keeping it makes it visible again.
								</p>
							) : null}
						</div>
					))}
				</div>
			)}
		</>
	);
}
