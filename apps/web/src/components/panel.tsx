"use client";

/**
 * Shared furniture for every panel screen.
 *
 * Small, plain pieces rather than a component library: these screens are read
 * by three people who work here, and the thing that makes them usable is
 * consistent spacing and honest labels, not novelty.
 */

import { Button } from "@greetings/ui/components/button";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect } from "react";
import type { ContentStatus, UserRole } from "@/lib/api";
import {
	canModerate,
	isDesigner,
	isSuperAdmin,
	useSession,
} from "@/lib/session";

export function PageHeader({
	title,
	description,
	action,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div className="mb-6 flex flex-wrap items-start justify-between gap-3">
			<div>
				<h1 className="font-semibold text-xl tracking-tight">{title}</h1>
				{description ? (
					<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
						{description}
					</p>
				) : null}
			</div>
			{action}
		</div>
	);
}

const STATUS_STYLES: Record<ContentStatus, string> = {
	draft: "bg-muted text-muted-foreground",
	pending_review: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
	published: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
	rejected: "bg-destructive/15 text-destructive",
	removed: "bg-destructive/15 text-destructive",
};

const STATUS_LABELS: Record<ContentStatus, string> = {
	draft: "Draft",
	pending_review: "In review",
	published: "Published",
	rejected: "Rejected",
	removed: "Removed",
};

export function StatusBadge({
	status,
	held,
}: {
	status: ContentStatus;
	held?: boolean;
}) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span
				className={`inline-flex items-center px-2 py-0.5 font-medium text-xs ${STATUS_STYLES[status]}`}
			>
				{STATUS_LABELS[status]}
			</span>
			{held ? (
				// Held content is still `published`, so the status alone would say it
				// is live when nobody can see it. Two facts, two badges.
				<span className="inline-flex items-center bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 text-xs dark:text-amber-400">
					Hidden pending review
				</span>
			) : null}
		</span>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return (
		<div className="border border-dashed px-6 py-10 text-center text-muted-foreground text-sm">
			{children}
		</div>
	);
}

export function ErrorNote({ message }: { message: string | null }) {
	if (!message) return null;
	return (
		<p
			className="mb-4 border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm"
			role="alert"
		>
			{message}
		</p>
	);
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children and wrapped by this label, which associates them implicitly — the rule cannot see through the prop
		<label className="block">
			<span className="mb-1 block font-medium text-sm">{label}</span>
			{children}
			{hint ? (
				<span className="mt-1 block text-muted-foreground text-xs">{hint}</span>
			) : null}
		</label>
	);
}

/** Consistent date rendering. Absolute, because an audit trail needs to be. */
export function When({ value }: { value: string | null | undefined }) {
	if (!value) return <span className="text-muted-foreground">—</span>;
	const date = new Date(value);
	return (
		<time dateTime={date.toISOString()} title={date.toISOString()}>
			{date.toLocaleString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			})}
		</time>
	);
}

/**
 * A responsive list.
 *
 * A table would be the obvious choice and is the wrong one here: the designer
 * panel is used on a phone, and a table with six columns on a 360px screen is
 * either a horizontal scroll or unreadable. Stacked cards read the same at
 * every width.
 */
export function List({ children }: { children: ReactNode }) {
	return <div className="divide-y border">{children}</div>;
}

export function Row({
	href,
	children,
}: {
	// Next's typed routes cannot check a template string built at runtime. The
	// cast is honest about that rather than turning the checking off globally,
	// which would give up the guarantee on every static link in the app too.
	href?: string;
	children: ReactNode;
}) {
	const inner = (
		<div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
			{children}
		</div>
	);

	return href ? (
		<Link className="block hover:bg-muted/50" href={href as Route}>
			{inner}
		</Link>
	) : (
		inner
	);
}

interface NavLink {
	href: Route;
	label: string;
}

/**
 * Navigation, role-aware.
 *
 * A super admin sees the moderation links as well as their own: the product
 * asks for one person who can do everything, and making them switch accounts
 * to approve a post would be absurd.
 */
function linksFor(role: UserRole | undefined): NavLink[] {
	const links: NavLink[] = [];

	if (isDesigner(role)) {
		links.push(
			{ href: "/designer" as Route, label: "My content" },
			{ href: "/designer/analytics" as Route, label: "Analytics" },
		);
	}

	if (canModerate(role)) {
		links.push(
			{ href: "/moderation" as Route, label: "Review queue" },
			{ href: "/moderation/reports" as Route, label: "Reports" },
		);
	}

	if (isSuperAdmin(role)) {
		links.push(
			{ href: "/admin" as Route, label: "Overview" },
			{ href: "/admin/content" as Route, label: "All content" },
			{ href: "/admin/people" as Route, label: "People" },
			{ href: "/admin/audit" as Route, label: "Audit" },
		);
	}

	return links;
}

/**
 * Wraps a panel screen: waits for the session, sends the wrong people away,
 * and renders the navigation.
 *
 * `allow` states which roles the screen is for. It is a convenience, not a
 * control — the API refuses the request regardless.
 */
export function PanelShell({
	allow,
	children,
}: {
	allow: (role: UserRole) => boolean;
	children: ReactNode;
}) {
	const { user, loading } = useSession();
	const router = useRouter();
	const pathname = usePathname();

	useEffect(() => {
		if (loading) return;
		if (!user) router.replace("/login");
		else if (!allow(user.role)) router.replace("/");
	}, [loading, user, allow, router]);

	if (loading) {
		return (
			<div className="px-4 py-10 text-muted-foreground text-sm">Loading…</div>
		);
	}

	if (!user || !allow(user.role)) return null;

	const links = linksFor(user.role);

	return (
		<div className="mx-auto w-full max-w-5xl px-4 py-6">
			<nav className="-mx-1 mb-6 flex flex-wrap gap-1 overflow-x-auto border-b pb-2">
				{links.map((link) => {
					const active =
						pathname === link.href || pathname.startsWith(`${link.href}/`);
					return (
						<Button
							render={<Link href={link.href} />}
							key={link.href}
							size="sm"
							variant={active ? "secondary" : "ghost"}
						>
							{link.label}
						</Button>
					);
				})}
			</nav>
			{children}
		</div>
	);
}
