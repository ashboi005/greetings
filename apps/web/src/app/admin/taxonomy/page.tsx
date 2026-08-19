"use client";

import { Button } from "@greetings/ui/components/button";
import { Input } from "@greetings/ui/components/input";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	Empty,
	ErrorNote,
	Field,
	List,
	PageHeader,
	PanelShell,
	Row,
	When,
} from "@/components/panel";
import {
	api,
	errorMessage,
	type ReferenceChange,
	TAG_CATEGORIES,
	type TagCategory,
	type TaxonomyLanguage,
	type TaxonomyRegion,
	type TaxonomyTag,
} from "@/lib/api";
import { canModerate } from "@/lib/session";

/**
 * Taxonomy editor.
 *
 * Tags, languages and regions used to change only when someone ran a seed
 * script. This is the screen that makes them editorial: a new festival can be
 * added the week before it happens instead of the next deploy.
 *
 * The recurring idea in this UI is **retire, not delete**. Everything here is
 * referenced by content or by download history, so removing a row is usually
 * either impossible or destructive. Retiring hides it from designers and readers
 * while leaving every past post and every analytics row intact — so that is the
 * prominent action, and Delete is offered only where it is genuinely safe.
 */
export default function TaxonomyPage() {
	return (
		<PanelShell allow={canModerate}>
			<Taxonomy />
		</PanelShell>
	);
}

type Panel = "tags" | "languages" | "regions" | "history";

function Taxonomy() {
	const [panel, setPanel] = useState<Panel>("tags");

	return (
		<>
			<PageHeader
				description="What designers can tag content with, and what readers can filter by. Retiring hides an entry from everyone without touching the content already using it — prefer it to deleting, which is only possible while nothing references the entry at all. Every change here is recorded."
				title="Taxonomy"
			/>

			<nav className="mb-6 flex flex-wrap gap-1 border-b">
				{(
					[
						["tags", "Tags"],
						["languages", "Languages"],
						["regions", "Regions"],
						["history", "History"],
					] as [Panel, string][]
				).map(([value, label]) => (
					<button
						className={`-mb-px border-b-2 px-3 py-2 text-sm ${
							panel === value
								? "border-foreground font-medium"
								: "border-transparent text-muted-foreground"
						}`}
						key={value}
						onClick={() => setPanel(value)}
						type="button"
					>
						{label}
					</button>
				))}
			</nav>

			{panel === "tags" ? <Tags /> : null}
			{panel === "languages" ? <Languages /> : null}
			{panel === "regions" ? <Regions /> : null}
			{panel === "history" ? <History /> : null}
		</>
	);
}

/** Shared shape for the small inline edit forms below. */
function useCollection<T>(path: string) {
	const [items, setItems] = useState<T[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setItems(await api<T[]>(path));
			setError(null);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}, [path]);

	useEffect(() => {
		void load();
	}, [load]);

	return { items, error, reload: load, setError };
}

// ------------------------------------------------------------------- tags

function Tags() {
	const { items, error, reload, setError } = useCollection<TaxonomyTag>(
		"/v1/admin/reference/tags",
	);
	const [showRetired, setShowRetired] = useState(false);

	if (error) return <ErrorNote message={error} />;
	if (!items) return <Empty>Loading…</Empty>;

	const visible = showRetired ? items : items.filter((tag) => tag.isActive);
	const grouped = TAG_CATEGORIES.map((category) => ({
		category,
		tags: visible.filter((tag) => tag.category === category),
	})).filter((group) => group.tags.length > 0);

	const retiredCount = items.filter((tag) => !tag.isActive).length;

	return (
		<>
			<NewTag onCreated={reload} onError={setError} />

			{retiredCount > 0 ? (
				<label className="mb-4 flex items-center gap-2 text-muted-foreground text-sm">
					<input
						checked={showRetired}
						onChange={(event) => setShowRetired(event.target.checked)}
						type="checkbox"
					/>
					Show {retiredCount} retired tag{retiredCount === 1 ? "" : "s"}
				</label>
			) : null}

			{grouped.length === 0 ? <Empty>No tags yet.</Empty> : null}

			{grouped.map((group) => (
				<section className="mb-8" key={group.category}>
					<h2 className="mb-2 font-medium text-sm capitalize">
						{group.category}
					</h2>
					<List>
						{group.tags.map((tag) => (
							<TagRow key={tag.id} onChange={reload} tag={tag} />
						))}
					</List>
				</section>
			))}
		</>
	);
}

function NewTag({
	onCreated,
	onError,
}: {
	onCreated: () => Promise<void>;
	onError: (message: string | null) => void;
}) {
	const [label, setLabel] = useState("");
	const [slug, setSlug] = useState("");
	const [category, setCategory] = useState<TagCategory>("festival");
	const [busy, setBusy] = useState(false);
	const [slugEdited, setSlugEdited] = useState(false);

	// The slug follows the label until someone edits it by hand, at which point
	// it stops fighting them. Typing the same words twice is the kind of chore
	// that makes people give a tag a bad slug.
	const onLabelChange = (value: string) => {
		setLabel(value);
		if (!slugEdited) setSlug(slugify(value));
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		onError(null);
		try {
			await api<TaxonomyTag>("/v1/admin/reference/tags", {
				method: "POST",
				body: { slug: slug.trim(), label: label.trim(), category },
			});
			toast.success(`Added “${label.trim()}”`);
			setLabel("");
			setSlug("");
			setSlugEdited(false);
			await onCreated();
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="mb-8 border p-4">
			<h2 className="mb-3 font-medium text-sm">Add a tag</h2>
			<form className="grid gap-3 sm:grid-cols-3" onSubmit={submit}>
				<Field label="Label">
					<Input
						maxLength={80}
						onChange={(event) => onLabelChange(event.target.value)}
						placeholder="Ganesh Chaturthi"
						required
						value={label}
					/>
				</Field>
				<Field label="Slug">
					<Input
						maxLength={64}
						onChange={(event) => {
							setSlugEdited(true);
							setSlug(event.target.value);
						}}
						pattern="[a-z0-9]+(-[a-z0-9]+)*"
						placeholder="ganesh-chaturthi"
						required
						title="Lowercase letters, numbers and single hyphens"
						value={slug}
					/>
				</Field>
				<Field label="Category">
					<select
						className="h-9 w-full border bg-background px-2 text-sm"
						onChange={(event) => setCategory(event.target.value as TagCategory)}
						value={category}
					>
						{TAG_CATEGORIES.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				</Field>
				<div className="sm:col-span-3">
					<Button
						disabled={busy || !label.trim() || !slug.trim()}
						type="submit"
					>
						{busy ? "Adding…" : "Add tag"}
					</Button>
				</div>
			</form>
		</section>
	);
}

function TagRow({
	tag,
	onChange,
}: {
	tag: TaxonomyTag;
	onChange: () => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [label, setLabel] = useState(tag.label);
	const [category, setCategory] = useState<TagCategory>(tag.category);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const patch = async (body: Record<string, unknown>, done?: string) => {
		setBusy(true);
		setError(null);
		try {
			await api<TaxonomyTag>(`/v1/admin/reference/tags/${tag.id}`, {
				method: "PATCH",
				body,
			});
			if (done) toast.success(done);
			setEditing(false);
			await onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await api(`/v1/admin/reference/tags/${tag.id}`, { method: "DELETE" });
			toast.success("Tag deleted");
			await onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Row>
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm">
					{tag.label}
					{tag.isActive ? null : (
						<span className="ml-2 text-muted-foreground text-xs">retired</span>
					)}
				</div>
				<div className="text-muted-foreground text-xs">
					{tag.slug} · on {tag.usageCount} item
					{tag.usageCount === 1 ? "" : "s"}
				</div>
				<ErrorNote message={error} />
			</div>

			{editing ? (
				<div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
					<Input
						maxLength={80}
						onChange={(event) => setLabel(event.target.value)}
						value={label}
					/>
					<select
						className="h-9 border bg-background px-2 text-sm"
						onChange={(event) => setCategory(event.target.value as TagCategory)}
						value={category}
					>
						{TAG_CATEGORIES.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
					<Button
						disabled={busy || !label.trim()}
						onClick={() => patch({ label: label.trim(), category }, "Saved")}
						size="sm"
						type="button"
					>
						Save
					</Button>
					<Button
						onClick={() => {
							setLabel(tag.label);
							setCategory(tag.category);
							setEditing(false);
						}}
						size="sm"
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
				</div>
			) : (
				<div className="flex flex-wrap gap-2">
					<Button
						disabled={busy}
						onClick={() => setEditing(true)}
						size="sm"
						type="button"
						variant="outline"
					>
						Edit
					</Button>
					<Button
						disabled={busy}
						onClick={() =>
							patch(
								{ isActive: !tag.isActive },
								tag.isActive ? "Tag retired" : "Tag restored",
							)
						}
						size="sm"
						type="button"
						variant="outline"
					>
						{tag.isActive ? "Retire" : "Restore"}
					</Button>
					{/* Offered only when it is actually possible. A Delete button that
					    always returns 409 teaches people to ignore error messages. */}
					{tag.usageCount === 0 ? (
						<Button
							disabled={busy}
							onClick={remove}
							size="sm"
							type="button"
							variant="ghost"
						>
							Delete
						</Button>
					) : null}
				</div>
			)}
		</Row>
	);
}

// -------------------------------------------------------------- languages

function Languages() {
	const { items, error, reload, setError } = useCollection<TaxonomyLanguage>(
		"/v1/admin/reference/languages",
	);

	if (error) return <ErrorNote message={error} />;
	if (!items) return <Empty>Loading…</Empty>;

	return (
		<>
			<NewLanguage onCreated={reload} onError={setError} />
			<List>
				{items.map((language) => (
					<CodedRow
						basePath="/v1/admin/reference/languages"
						count={language.contentCount}
						countNoun="item"
						extraField={{ key: "nativeName", label: "Native name" }}
						item={{
							code: language.code,
							name: language.name,
							isActive: language.isActive,
							nativeName: language.nativeName,
						}}
						key={language.code}
						onChange={reload}
						subtitle={`${language.code} · ${language.nativeName}`}
					/>
				))}
			</List>
		</>
	);
}

function NewLanguage({
	onCreated,
	onError,
}: {
	onCreated: () => Promise<void>;
	onError: (message: string | null) => void;
}) {
	const [code, setCode] = useState("");
	const [name, setName] = useState("");
	const [nativeName, setNativeName] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		onError(null);
		try {
			await api("/v1/admin/reference/languages", {
				method: "POST",
				body: {
					code: code.trim().toLowerCase(),
					name: name.trim(),
					nativeName: nativeName.trim(),
				},
			});
			toast.success(`Added ${name.trim()}`);
			setCode("");
			setName("");
			setNativeName("");
			await onCreated();
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="mb-8 border p-4">
			<h2 className="mb-3 font-medium text-sm">Add a language</h2>
			<form className="grid gap-3 sm:grid-cols-3" onSubmit={submit}>
				<Field label="Code">
					<Input
						onChange={(event) => setCode(event.target.value)}
						pattern="[a-z]{2,8}(-[a-z0-9]{2,8})?"
						placeholder="kok"
						required
						title="ISO 639-1 where one exists, lowercase"
						value={code}
					/>
				</Field>
				<Field label="Name">
					<Input
						maxLength={80}
						onChange={(event) => setName(event.target.value)}
						placeholder="Konkani"
						required
						value={name}
					/>
				</Field>
				<Field label="Native name">
					<Input
						maxLength={80}
						onChange={(event) => setNativeName(event.target.value)}
						placeholder="कोंकणी"
						required
						value={nativeName}
					/>
				</Field>
				<div className="sm:col-span-3">
					<p className="mb-2 text-muted-foreground text-xs">
						The code is permanent. Content and reader preferences point at it,
						so it cannot be corrected later — only retired.
					</p>
					<Button
						disabled={
							busy || !code.trim() || !name.trim() || !nativeName.trim()
						}
						type="submit"
					>
						{busy ? "Adding…" : "Add language"}
					</Button>
				</div>
			</form>
		</section>
	);
}

// ---------------------------------------------------------------- regions

function Regions() {
	const { items, error, reload, setError } = useCollection<TaxonomyRegion>(
		"/v1/admin/reference/regions",
	);

	if (error) return <ErrorNote message={error} />;
	if (!items) return <Empty>Loading…</Empty>;

	return (
		<>
			<NewRegion onCreated={reload} onError={setError} />
			<List>
				{items.map((region) => (
					<CodedRow
						basePath="/v1/admin/reference/regions"
						count={region.contentCount}
						countNoun="item"
						item={{
							code: region.code,
							name: region.name,
							isActive: region.isActive,
						}}
						key={region.code}
						onChange={reload}
						subtitle={region.code}
					/>
				))}
			</List>
		</>
	);
}

function NewRegion({
	onCreated,
	onError,
}: {
	onCreated: () => Promise<void>;
	onError: (message: string | null) => void;
}) {
	const [code, setCode] = useState("");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		onError(null);
		try {
			await api("/v1/admin/reference/regions", {
				method: "POST",
				body: { code: code.trim().toUpperCase(), name: name.trim() },
			});
			toast.success(`Added ${name.trim()}`);
			setCode("");
			setName("");
			await onCreated();
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="mb-8 border p-4">
			<h2 className="mb-3 font-medium text-sm">Add a region</h2>
			<form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
				<Field label="Code">
					<Input
						onChange={(event) => setCode(event.target.value.toUpperCase())}
						pattern="[A-Z]{2}-[A-Z0-9]{2,3}"
						placeholder="IN-MH"
						required
						title="ISO 3166-2 style, e.g. IN-MH"
						value={code}
					/>
				</Field>
				<Field label="Name">
					<Input
						maxLength={80}
						onChange={(event) => setName(event.target.value)}
						placeholder="Maharashtra"
						required
						value={name}
					/>
				</Field>
				<div className="sm:col-span-2">
					<p className="mb-2 text-muted-foreground text-xs">
						The code is permanent. It is stamped onto every download event, so
						changing it would rewrite analytics history.
					</p>
					<Button disabled={busy || !code.trim() || !name.trim()} type="submit">
						{busy ? "Adding…" : "Add region"}
					</Button>
				</div>
			</form>
		</section>
	);
}

/**
 * A row for the two code-keyed entities.
 *
 * Languages and regions differ only in whether they carry a native name, so one
 * component serves both rather than two that drift apart.
 */
function CodedRow({
	item,
	subtitle,
	count,
	countNoun,
	basePath,
	extraField,
	onChange,
}: {
	item: { code: string; name: string; isActive: boolean; nativeName?: string };
	subtitle: string;
	count: number;
	countNoun: string;
	basePath: string;
	extraField?: { key: "nativeName"; label: string };
	onChange: () => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(item.name);
	const [nativeName, setNativeName] = useState(item.nativeName ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const send = async (
		method: "PATCH" | "DELETE",
		body?: Record<string, unknown>,
		done?: string,
	) => {
		setBusy(true);
		setError(null);
		try {
			await api(`${basePath}/${item.code}`, { method, body });
			if (done) toast.success(done);
			setEditing(false);
			await onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Row>
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm">
					{item.name}
					{item.isActive ? null : (
						<span className="ml-2 text-muted-foreground text-xs">retired</span>
					)}
				</div>
				<div className="text-muted-foreground text-xs">
					{subtitle} · {count} {countNoun}
					{count === 1 ? "" : "s"}
				</div>
				<ErrorNote message={error} />
			</div>

			{editing ? (
				<div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
					<Input
						maxLength={80}
						onChange={(event) => setName(event.target.value)}
						value={name}
					/>
					{extraField ? (
						<Input
							maxLength={80}
							onChange={(event) => setNativeName(event.target.value)}
							value={nativeName}
						/>
					) : (
						<span />
					)}
					<Button
						disabled={busy || !name.trim()}
						onClick={() =>
							send(
								"PATCH",
								extraField
									? { name: name.trim(), nativeName: nativeName.trim() }
									: { name: name.trim() },
								"Saved",
							)
						}
						size="sm"
						type="button"
					>
						Save
					</Button>
					<Button
						onClick={() => {
							setName(item.name);
							setNativeName(item.nativeName ?? "");
							setEditing(false);
						}}
						size="sm"
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
				</div>
			) : (
				<div className="flex flex-wrap gap-2">
					<Button
						disabled={busy}
						onClick={() => setEditing(true)}
						size="sm"
						type="button"
						variant="outline"
					>
						Rename
					</Button>
					<Button
						disabled={busy}
						onClick={() =>
							send(
								"PATCH",
								{ isActive: !item.isActive },
								item.isActive ? "Retired" : "Restored",
							)
						}
						size="sm"
						type="button"
						variant="outline"
					>
						{item.isActive ? "Retire" : "Restore"}
					</Button>
					{count === 0 ? (
						<Button
							disabled={busy}
							onClick={() => send("DELETE", undefined, "Deleted")}
							size="sm"
							type="button"
							variant="ghost"
						>
							Delete
						</Button>
					) : null}
				</div>
			)}
		</Row>
	);
}

// ---------------------------------------------------------------- history

function History() {
	const { items, error } = useCollection<ReferenceChange>(
		"/v1/admin/reference/log?limit=100",
	);

	if (error) return <ErrorNote message={error} />;
	if (!items) return <Empty>Loading…</Empty>;
	if (items.length === 0) return <Empty>Nothing has been changed yet.</Empty>;

	return (
		<List>
			{items.map((entry) => (
				<Row key={entry.id}>
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm">
							{describeAction(entry.action)} {nameOf(entry) ?? entry.entityKey}
						</div>
						<div className="text-muted-foreground text-xs">
							{entry.entity} · {entry.entityKey} ·{" "}
							<When value={entry.createdAt} />
						</div>
						<div className="mt-2">
							<Diff entry={entry} />
						</div>
					</div>
				</Row>
			))}
		</List>
	);
}

/** Shows only the fields that actually changed, which is usually one. */
function Diff({ entry }: { entry: ReferenceChange }) {
	const before = entry.before ?? {};
	const after = entry.after ?? {};
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((key) => key !== "id" && key !== "code")
		.filter(
			(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
		);

	if (keys.length === 0) return null;

	return (
		<dl className="grid gap-1 text-xs">
			{keys.map((key) => (
				<div className="flex flex-wrap gap-2" key={key}>
					<dt className="text-muted-foreground">{key}</dt>
					<dd className="font-mono">
						{entry.action === "create" ? null : (
							<span className="text-muted-foreground line-through">
								{format(before[key])}
							</span>
						)}
						{entry.action === "create" || entry.action === "delete" ? null : (
							<span aria-hidden> → </span>
						)}
						{entry.action === "delete" ? null : (
							<span>{format(after[key])}</span>
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function format(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "boolean") return value ? "yes" : "no";
	return String(value);
}

function nameOf(entry: ReferenceChange): string | null {
	const source = entry.after ?? entry.before;
	const label = source?.label ?? source?.name;
	return typeof label === "string" ? label : null;
}

function describeAction(action: ReferenceChange["action"]): string {
	switch (action) {
		case "create":
			return "Added";
		case "update":
			return "Edited";
		case "activate":
			return "Restored";
		case "deactivate":
			return "Retired";
		case "delete":
			return "Deleted";
	}
}

/** Label to slug, matching the server's accepted shape. */
function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.normalize("NFD")
			// Strip combining marks by codepoint rather than by literal character,
			// so "Ganeśa" becomes "ganesa" instead of losing the letter to the
			// alphanumeric filter below. Written as escapes because the raw marks
			// are invisible in a diff and easy to mangle.
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
	);
}
