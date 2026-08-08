"use client";

import { Button } from "@greetings/ui/components/button";
import { Textarea } from "@greetings/ui/components/textarea";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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
import { api, errorMessage, type ReviewDetail } from "@/lib/api";
import { canModerate, isSuperAdmin, useSession } from "@/lib/session";

export default function ReviewPage() {
	return (
		<PanelShell allow={canModerate}>
			<Review />
		</PanelShell>
	);
}

function Review() {
	const { id } = useParams<{ id: string }>();
	const router = useRouter();
	const { user } = useSession();

	const [item, setItem] = useState<ReviewDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [reason, setReason] = useState("");

	const load = useCallback(async () => {
		try {
			setItem(await api<ReviewDetail>(`/v1/admin/content/${id}`));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [id]);

	useEffect(() => {
		void load();
	}, [load]);

	const act = async (
		action: "approve" | "reject" | "remove" | "restore",
		requiresReason: boolean,
	) => {
		if (requiresReason && !reason.trim()) {
			setError(
				action === "reject"
					? "Say what needs to change. A rejection with no reason just becomes a support conversation."
					: "Give a reason. This goes on the permanent record for this item.",
			);
			return;
		}

		setBusy(true);
		setError(null);
		try {
			await api(`/v1/admin/content/${id}/${action}`, {
				method: "POST",
				body: reason.trim() ? { reason: reason.trim() } : {},
			});
			toast.success(`Done: ${action}`);
			setReason("");
			await load();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	if (loading) return <Empty>Loading…</Empty>;
	if (!item) {
		return (
			<>
				<ErrorNote message={error} />
				<Empty>This item could not be loaded.</Empty>
			</>
		);
	}

	const can = (action: string) => item.availableActions.includes(action);

	return (
		<>
			<PageHeader
				action={
					isSuperAdmin(user?.role) ? (
						<Button
							render={<Link href={`/admin/content/${item.id}`} />}
							size="sm"
							variant="ghost"
						>
							Full history
						</Button>
					) : null
				}
				description={`By ${item.designerName}`}
				title={item.title}
			/>

			<div className="mb-4">
				<StatusBadge held={item.visibilityHold} status={item.status} />
			</div>

			<ErrorNote message={error} />

			{item.description ? (
				<p className="mb-4 max-w-2xl text-sm">{item.description}</p>
			) : null}

			<dl className="mb-6 grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
				<dt className="text-muted-foreground">Language</dt>
				<dd>{item.primaryLanguage}</dd>
				<dt className="text-muted-foreground">Region</dt>
				<dd>{item.regionCode ?? "All India"}</dd>
				<dt className="text-muted-foreground">Submitted</dt>
				<dd>
					<When value={item.submittedAt} />
				</dd>
			</dl>

			<section className="mb-8">
				{item.assets.length === 0 ? (
					<Empty>This item has no image.</Empty>
				) : (
					<div className="flex flex-wrap gap-3">
						{item.assets.map((asset) =>
							asset.previewUrl ? (
								// biome-ignore lint/performance/noImgElement: a signed storage URL cannot be served through next/image's optimiser
								<img
									alt=""
									className="max-h-[28rem] w-auto border bg-muted"
									key={asset.id}
									src={asset.previewUrl}
								/>
							) : (
								// Reviewing without being able to see the image is not
								// review. Better to say why than to show a broken icon.
								<div
									className="flex h-64 w-48 items-center justify-center border border-dashed p-4 text-center text-muted-foreground text-sm"
									key={asset.id}
								>
									Image storage is not configured on this server, so the picture
									cannot be shown.
								</div>
							),
						)}
					</div>
				)}
			</section>

			<section className="mb-8 border-t pt-6">
				<h2 className="mb-3 font-medium text-sm">Decision</h2>

				<Textarea
					className="mb-3 max-w-xl"
					maxLength={500}
					onChange={(event) => setReason(event.target.value)}
					placeholder="Reason — required to reject or remove, and shown to the designer"
					rows={2}
					value={reason}
				/>

				<div className="flex flex-wrap gap-2">
					{can("approve") ? (
						<Button disabled={busy} onClick={() => act("approve", false)}>
							Approve and publish
						</Button>
					) : null}
					{can("reject") ? (
						<Button
							disabled={busy}
							onClick={() => act("reject", true)}
							variant="outline"
						>
							Request changes
						</Button>
					) : null}
					{can("remove") ? (
						<Button
							disabled={busy}
							onClick={() => act("remove", true)}
							variant="destructive"
						>
							Take down
						</Button>
					) : null}
					{can("restore") ? (
						<Button
							disabled={busy}
							onClick={() => act("restore", false)}
							variant="outline"
						>
							Put back
						</Button>
					) : null}
				</div>

				{item.availableActions.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						Nothing to decide — this item is {item.status}.
					</p>
				) : null}
			</section>

			<section>
				<h2 className="mb-3 font-medium text-sm">History</h2>
				{item.history.length === 0 ? (
					<Empty>Nothing recorded yet.</Empty>
				) : (
					<ol className="space-y-2 border-l pl-4 text-sm">
						{item.history.map((entry) => (
							<li key={`${entry.action}-${entry.createdAt}`}>
								<span className="font-medium">{entry.action}</span>
								{" · "}
								{/* Null actor means the system acted alone — currently only
								    the automatic hold. Saying so beats a blank. */}
								<span className="text-muted-foreground">
									{entry.actorName ?? "automatic"}
								</span>
								{" · "}
								<span className="text-muted-foreground">
									<When value={entry.createdAt} />
								</span>
								{entry.reason ? (
									<div className="text-muted-foreground text-xs">
										{entry.reason}
									</div>
								) : null}
							</li>
						))}
					</ol>
				)}
			</section>

			<div className="mt-8 border-t pt-4">
				<Button onClick={() => router.push("/moderation")} variant="ghost">
					Back to queue
				</Button>
			</div>
		</>
	);
}
