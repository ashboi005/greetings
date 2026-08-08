"use client";

import { Button } from "@greetings/ui/components/button";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
	Empty,
	ErrorNote,
	PageHeader,
	PanelShell,
	StatusBadge,
	When,
} from "@/components/panel";
import {
	api,
	type ContentAudit,
	errorMessage,
	type TimelineEntry,
} from "@/lib/api";
import { isSuperAdmin } from "@/lib/session";

/**
 * One item's whole story.
 *
 * The question this screen exists to answer is "who did this, and why" — so
 * every entry names a person, and where nobody decided it, it says so rather
 * than leaving a blank that reads like missing data.
 */
export default function ContentAuditPage() {
	return (
		<PanelShell allow={isSuperAdmin}>
			<Audit />
		</PanelShell>
	);
}

const KIND_LABELS: Record<string, string> = {
	created: "Created",
	submit: "Sent for review",
	approve: "Approved",
	reject: "Changes requested",
	remove: "Taken down",
	restore: "Put back",
	hold: "Hidden automatically",
	reported: "Reported",
	report_resolved: "Report resolved",
};

const KIND_TONE: Record<string, string> = {
	created: "bg-muted",
	submit: "bg-muted",
	approve: "bg-emerald-500/20",
	reject: "bg-amber-500/20",
	remove: "bg-destructive/20",
	restore: "bg-emerald-500/20",
	hold: "bg-amber-500/20",
	reported: "bg-destructive/20",
	report_resolved: "bg-muted",
};

function Audit() {
	const { id } = useParams<{ id: string }>();
	const [data, setData] = useState<ContentAudit | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		void (async () => {
			try {
				setData(await api<ContentAudit>(`/v1/admin/content/${id}/audit`));
			} catch (cause) {
				setError(errorMessage(cause));
			} finally {
				setLoading(false);
			}
		})();
	}, [id]);

	if (loading) return <Empty>Loading…</Empty>;
	if (!data) {
		return (
			<>
				<ErrorNote message={error} />
				<Empty>No such item.</Empty>
			</>
		);
	}

	const { content, timeline } = data;

	return (
		<>
			<PageHeader
				action={
					<Button
						render={<Link href={`/moderation/content/${content.id}`} />}
						size="sm"
						variant="outline"
					>
						Open for review
					</Button>
				}
				description={`Made by ${content.designerName} · ${content.designerEmail}`}
				title={content.title}
			/>

			<div className="mb-6">
				<StatusBadge held={content.visibilityHold} status={content.status} />
			</div>

			<dl className="mb-8 grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
				<dt className="text-muted-foreground">Created</dt>
				<dd>
					<When value={content.createdAt} />
				</dd>
				<dt className="text-muted-foreground">Published</dt>
				<dd>
					<When value={content.publishedAt} />
				</dd>
				<dt className="text-muted-foreground">Removed</dt>
				<dd>
					<When value={content.removedAt} />
				</dd>
				<dt className="text-muted-foreground">Downloads</dt>
				<dd className="tabular-nums">{content.downloadCount}</dd>
				<dt className="text-muted-foreground">Item id</dt>
				<dd className="break-all font-mono text-xs">{content.id}</dd>
			</dl>

			<h2 className="mb-3 font-medium text-sm">History</h2>
			<ol className="space-y-0">
				{timeline.map((entry, index) => (
					<Entry
						entry={entry}
						key={`${entry.kind}-${entry.at}-${index}`}
						last={index === timeline.length - 1}
					/>
				))}
			</ol>
		</>
	);
}

function Entry({ entry, last }: { entry: TimelineEntry; last: boolean }) {
	return (
		<li className="flex gap-3">
			<div className="flex flex-col items-center">
				<span
					className={`mt-1.5 size-2.5 shrink-0 ${KIND_TONE[entry.kind] ?? "bg-muted"}`}
				/>
				{last ? null : <span className="w-px flex-1 bg-border" />}
			</div>

			<div className="min-w-0 flex-1 pb-5">
				<div className="flex flex-wrap items-baseline gap-x-2">
					<span className="font-medium text-sm">
						{KIND_LABELS[entry.kind] ?? entry.kind}
					</span>
					<span className="text-muted-foreground text-xs">
						<When value={entry.at} />
					</span>
				</div>

				<div className="mt-0.5 text-muted-foreground text-xs">
					{entry.actor ? (
						<>
							{entry.actor.name ?? entry.actor.id}
							{entry.actor.role ? ` · ${entry.actor.role}` : ""}
						</>
					) : (
						// No human decided this. Attributing it to whoever happened to
						// be nearby would be a lie the record would carry forever.
						<span className="italic">automatic — no person involved</span>
					)}
				</div>

				{entry.reason ? <p className="mt-1 text-sm">{entry.reason}</p> : null}
				{entry.note ? (
					<p className="mt-1 text-muted-foreground text-sm">“{entry.note}”</p>
				) : null}
			</div>
		</li>
	);
}
