"use client";

import { Button } from "@greetings/ui/components/button";
import { Input } from "@greetings/ui/components/input";
import { Textarea } from "@greetings/ui/components/textarea";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	Empty,
	ErrorNote,
	Field,
	PageHeader,
	PanelShell,
	StatusBadge,
	When,
} from "@/components/panel";
import {
	api,
	type DesignerContentDetail,
	errorMessage,
	type Tag,
} from "@/lib/api";
import { isDesigner } from "@/lib/session";

export default function DesignerContentPage() {
	return (
		<PanelShell allow={isDesigner}>
			<Editor />
		</PanelShell>
	);
}

function Editor() {
	const { id } = useParams<{ id: string }>();
	const router = useRouter();

	const [item, setItem] = useState<DesignerContentDetail | null>(null);
	const [tags, setTags] = useState<Tag[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		try {
			const [detail, allTags] = await Promise.all([
				api<DesignerContentDetail>(`/v1/designer/content/${id}`),
				api<Tag[]>("/v1/tags"),
			]);
			setItem(detail);
			setTags(allTags);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [id]);

	useEffect(() => {
		void load();
	}, [load]);

	if (loading) return <Empty>Loading…</Empty>;
	if (!item) {
		return (
			<>
				<ErrorNote message={error} />
				<Empty>This item could not be loaded.</Empty>
			</>
		);
	}

	const editable = item.status === "draft" || item.status === "rejected";

	return (
		<>
			<PageHeader
				description={
					editable
						? "Add an image and at least one tag, then send it for review."
						: "This is with the reviewers, or already decided. It cannot be changed now."
				}
				title={item.title}
			/>

			<div className="mb-4">
				<StatusBadge held={item.visibilityHold} status={item.status} />
			</div>

			<ErrorNote message={error} />

			{item.status === "rejected" && item.rejectionReason ? (
				<div className="mb-6 border border-destructive/30 bg-destructive/10 px-3 py-2">
					<p className="font-medium text-destructive text-sm">
						Changes requested
					</p>
					<p className="mt-1 text-destructive text-sm">
						{item.rejectionReason}
					</p>
				</div>
			) : null}

			<div className="space-y-8">
				<ImageSection editable={editable} item={item} onChange={load} />
				<TagSection
					allTags={tags}
					editable={editable}
					item={item}
					onChange={load}
				/>
				<DetailsSection editable={editable} item={item} onChange={load} />
				<SubmitSection
					item={item}
					onChange={load}
					onDeleted={() => router.push("/designer")}
				/>
			</div>
		</>
	);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
	return <h2 className="mb-3 font-medium text-sm">{children}</h2>;
}

/**
 * The upload.
 *
 * Three steps, because the server never touches the bytes: ask for a presigned
 * URL, PUT the file straight to storage, then tell the server it landed. The
 * server checks the object really exists with the right type and size before
 * recording it, so a client that skips the middle step gets a clear refusal
 * rather than a broken image nobody notices until a user downloads it.
 */
function ImageSection({
	item,
	editable,
	onChange,
}: {
	item: DesignerContentDetail;
	editable: boolean;
	onChange: () => Promise<void>;
}) {
	const fileInput = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const upload = async (file: File) => {
		setUploading(true);
		setError(null);
		try {
			// The dimensions are read here because the browser already decoded the
			// image to show it; asking the server to do it would mean sending the
			// bytes through it, which is the one thing this design avoids.
			const dimensions = await readDimensions(file);

			const presigned = await api<{ storageKey: string; uploadUrl: string }>(
				`/v1/designer/content/${item.id}/upload-url`,
				{
					method: "POST",
					body: { mimeType: file.type, bytes: file.size },
				},
			);

			const put = await fetch(presigned.uploadUrl, {
				method: "PUT",
				headers: { "content-type": file.type },
				body: file,
			});
			if (!put.ok) {
				throw new Error(
					`Upload to storage failed (${put.status}). Check your connection and try again.`,
				);
			}

			await api(`/v1/designer/content/${item.id}/assets`, {
				method: "POST",
				body: {
					storageKey: presigned.storageKey,
					width: dimensions.width,
					height: dimensions.height,
				},
			});

			toast.success("Image uploaded");
			await onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setUploading(false);
			if (fileInput.current) fileInput.current.value = "";
		}
	};

	return (
		<section>
			<SectionTitle>Image</SectionTitle>
			<ErrorNote message={error} />

			{item.assets.length > 0 ? (
				<div className="mb-3 flex flex-wrap gap-3">
					{item.assets.map((asset) =>
						asset.previewUrl ? (
							// biome-ignore lint/performance/noImgElement: a signed storage URL cannot be served through next/image's optimiser
							<img
								alt=""
								className="max-h-64 w-auto border bg-muted"
								key={asset.id}
								src={asset.previewUrl}
							/>
						) : (
							// The server said it has no storage credentials. Saying so
							// beats a broken image icon that reads like a lost file.
							<div
								className="flex h-40 w-32 items-center justify-center border border-dashed p-3 text-center text-muted-foreground text-xs"
								key={asset.id}
							>
								Image storage is not configured on this server
							</div>
						),
					)}
				</div>
			) : (
				<Empty>No image yet. One is required before review.</Empty>
			)}

			{editable ? (
				<div className="mt-3">
					<input
						accept="image/jpeg,image/png,image/webp"
						className="hidden"
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (file) void upload(file);
						}}
						ref={fileInput}
						type="file"
					/>
					<Button
						disabled={uploading}
						onClick={() => fileInput.current?.click()}
						variant="outline"
					>
						{uploading
							? "Uploading…"
							: item.assets.length > 0
								? "Replace image"
								: "Choose image"}
					</Button>
					<p className="mt-2 text-muted-foreground text-xs">
						JPEG, PNG or WebP, up to 10MB. Portrait images work best — most
						people will see this on a phone.
					</p>
				</div>
			) : null}
		</section>
	);
}

function TagSection({
	item,
	allTags,
	editable,
	onChange,
}: {
	item: DesignerContentDetail;
	allTags: Tag[];
	editable: boolean;
	onChange: () => Promise<void>;
}) {
	const [selected, setSelected] = useState<string[]>(
		item.tags.map((tag) => tag.id),
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setSelected(item.tags.map((tag) => tag.id));
	}, [item.tags]);

	const save = async (next: string[]) => {
		setSelected(next);
		if (next.length === 0) return; // The API requires at least one.
		setSaving(true);
		setError(null);
		try {
			await api(`/v1/designer/content/${item.id}/tags`, {
				method: "PUT",
				body: { tagIds: next },
			});
			await onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	const grouped = allTags.reduce<Record<string, Tag[]>>((acc, tag) => {
		const bucket = acc[tag.category];
		if (bucket) bucket.push(tag);
		else acc[tag.category] = [tag];
		return acc;
	}, {});

	return (
		<section>
			<SectionTitle>Tags {saving ? "· saving…" : ""}</SectionTitle>
			<ErrorNote message={error} />

			{!editable ? (
				<p className="text-sm">
					{item.tags.map((tag) => tag.label).join(", ") || "None"}
				</p>
			) : (
				<>
					<p className="mb-3 text-muted-foreground text-xs">
						Tags are how people find this. At least one is required.
					</p>
					{Object.entries(grouped).map(([category, categoryTags]) => (
						<div className="mb-3" key={category}>
							<div className="mb-1.5 text-muted-foreground text-xs capitalize">
								{category}
							</div>
							<div className="flex flex-wrap gap-1.5">
								{categoryTags.map((tag) => {
									const on = selected.includes(tag.id);
									return (
										<Button
											key={tag.id}
											onClick={() =>
												save(
													on
														? selected.filter((value) => value !== tag.id)
														: [...selected, tag.id],
												)
											}
											size="xs"
											variant={on ? "secondary" : "outline"}
										>
											{tag.label}
										</Button>
									);
								})}
							</div>
						</div>
					))}
					{selected.length === 0 ? (
						<p className="text-destructive text-xs">Pick at least one tag.</p>
					) : null}
				</>
			)}
		</section>
	);
}

function DetailsSection({
	item,
	editable,
	onChange,
}: {
	item: DesignerContentDetail;
	editable: boolean;
	onChange: () => Promise<void>;
}) {
	const [title, setTitle] = useState(item.title);
	const [description, setDescription] = useState(item.description ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const dirty =
		title !== item.title || description !== (item.description ?? "");

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			await api(`/v1/designer/content/${item.id}`, {
				method: "PATCH",
				body: { title: title.trim(), description: description.trim() || null },
			});
			toast.success("Saved");
			await onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	if (!editable) {
		return (
			<section>
				<SectionTitle>Details</SectionTitle>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
					<dt className="text-muted-foreground">Language</dt>
					<dd>{item.primaryLanguage}</dd>
					<dt className="text-muted-foreground">Region</dt>
					<dd>{item.regionCode ?? "All India"}</dd>
					<dt className="text-muted-foreground">Submitted</dt>
					<dd>
						<When value={item.submittedAt} />
					</dd>
					<dt className="text-muted-foreground">Published</dt>
					<dd>
						<When value={item.publishedAt} />
					</dd>
				</dl>
			</section>
		);
	}

	return (
		<section>
			<SectionTitle>Details</SectionTitle>
			<ErrorNote message={error} />
			<div className="max-w-xl space-y-3">
				<Field label="Title">
					<Input
						maxLength={200}
						onChange={(event) => setTitle(event.target.value)}
						value={title}
					/>
				</Field>
				<Field label="Description (optional)">
					<Textarea
						maxLength={2000}
						onChange={(event) => setDescription(event.target.value)}
						rows={3}
						value={description}
					/>
				</Field>
				<Button
					disabled={!dirty || saving || !title.trim()}
					onClick={save}
					variant="outline"
				>
					{saving ? "Saving…" : "Save changes"}
				</Button>
			</div>
		</section>
	);
}

function SubmitSection({
	item,
	onChange,
	onDeleted,
}: {
	item: DesignerContentDetail;
	onChange: () => Promise<void>;
	onDeleted: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const editable = item.status === "draft" || item.status === "rejected";
	// Mirrors what the server checks, so the reason a submission is blocked is
	// visible before the button is pressed rather than after.
	const blockers: string[] = [];
	if (!item.title.trim()) blockers.push("a title");
	if (item.assets.length === 0) blockers.push("an image");
	if (item.tags.length === 0) blockers.push("at least one tag");

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			await api(`/v1/designer/content/${item.id}/submit`, { method: "POST" });
			toast.success("Sent for review");
			await onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const discard = async () => {
		if (
			!window.confirm("Discard this item and its image? This cannot be undone.")
		) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api(`/v1/designer/content/${item.id}`, { method: "DELETE" });
			toast.success("Discarded");
			onDeleted();
		} catch (cause) {
			setError(errorMessage(cause));
			setBusy(false);
		}
	};

	if (!editable) {
		return (
			<section className="border-t pt-6">
				<p className="text-muted-foreground text-sm">
					{item.status === "pending_review"
						? "Waiting for a reviewer. You will see the outcome here."
						: item.status === "published"
							? "This is live. To take it down, ask an administrator."
							: "This was removed by an administrator."}
				</p>
			</section>
		);
	}

	return (
		<section className="border-t pt-6">
			<ErrorNote message={error} />
			<div className="flex flex-wrap items-center gap-3">
				<Button disabled={busy || blockers.length > 0} onClick={submit}>
					{busy ? "Working…" : "Send for review"}
				</Button>
				<Button disabled={busy} onClick={discard} variant="destructive">
					Discard
				</Button>
			</div>
			{blockers.length > 0 ? (
				<p className="mt-2 text-muted-foreground text-xs">
					Still needs {blockers.join(", ")}.
				</p>
			) : null}
		</section>
	);
}

/** Reads an image's pixel dimensions in the browser. */
function readDimensions(
	file: File,
): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(url);
			resolve({ width: image.naturalWidth, height: image.naturalHeight });
		};
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("That file could not be read as an image."));
		};
		image.src = url;
	});
}
