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
	type CreatedAccount,
	type DirectoryUser,
	errorMessage,
	type RoleInvite,
	type UserRole,
} from "@/lib/api";
import { isSuperAdmin, useSession } from "@/lib/session";

const ROLES: { value: UserRole; label: string }[] = [
	{ value: "user", label: "User" },
	{ value: "designer", label: "Designer" },
	{ value: "admin", label: "Admin" },
	{ value: "super_admin", label: "Super admin" },
];

export default function PeoplePage() {
	return (
		<PanelShell allow={isSuperAdmin}>
			<People />
		</PanelShell>
	);
}

function People() {
	const [refreshKey, setRefreshKey] = useState(0);
	const bump = () => setRefreshKey((value) => value + 1);

	return (
		<>
			<PageHeader
				description="Panel accounts are created here — there is no sign-up. Every change is recorded, and it signs the person out so a new role or password takes effect on their next request rather than whenever their session happens to expire."
				title="People"
			/>
			<CreateAccountForm onCreated={bump} />
			<GrantForm onGranted={bump} />
			<Invites key={`invites-${refreshKey}`} onChange={bump} />
			<Directory key={`directory-${refreshKey}`} />
		</>
	);
}

/**
 * Creating a panel account.
 *
 * The password is shown back once, because nothing here can email it. Whoever
 * creates the account has to pass it on themselves, so it has to be visible at
 * least once — and only once, since there is no reason to keep it on screen.
 */
function CreateAccountForm({ onCreated }: { onCreated: () => void }) {
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [role, setRole] = useState<UserRole>("designer");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [handover, setHandover] = useState<{
		email: string;
		password: string;
	} | null>(null);

	const suggest = () => setPassword(suggestPassword());

	const create = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api<CreatedAccount>("/v1/admin/accounts", {
				method: "POST",
				body: { email: email.trim(), name: name.trim(), role, password },
			});
			setHandover({ email: email.trim(), password });
			setEmail("");
			setName("");
			setPassword("");
			onCreated();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="mb-8 border p-4">
			<h2 className="mb-3 font-medium text-sm">Create a panel account</h2>
			<ErrorNote message={error} />

			{handover ? (
				<div className="mb-4 border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
					<p className="font-medium">Account created — pass these on now.</p>
					<p className="mt-1 break-all font-mono text-xs">
						{handover.email} / {handover.password}
					</p>
					<p className="mt-1 text-muted-foreground text-xs">
						This is the only time the password is shown. If it is lost, set a
						new one from the directory below.
					</p>
					<Button
						className="mt-2"
						onClick={() => setHandover(null)}
						size="xs"
						variant="outline"
					>
						Done
					</Button>
				</div>
			) : null}

			<form className="grid gap-3 sm:grid-cols-2" onSubmit={create}>
				<Field label="Email">
					<Input
						onChange={(event) => setEmail(event.target.value)}
						placeholder="priya@example.com"
						required
						type="email"
						value={email}
					/>
				</Field>
				<Field label="Name">
					<Input
						maxLength={80}
						onChange={(event) => setName(event.target.value)}
						placeholder="Priya Sharma"
						required
						value={name}
					/>
				</Field>
				<Field label="Role">
					<select
						className="h-8 w-full border bg-background px-2 text-sm"
						onChange={(event) => setRole(event.target.value as UserRole)}
						value={role}
					>
						{ROLES.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
				<Field
					hint="At least 12 characters. Generate one rather than inventing it."
					label="Password"
				>
					<div className="flex gap-2">
						<Input
							minLength={12}
							onChange={(event) => setPassword(event.target.value)}
							required
							value={password}
						/>
						<Button onClick={suggest} type="button" variant="outline">
							Generate
						</Button>
					</div>
				</Field>
				<div className="sm:col-span-2">
					<Button
						disabled={
							busy || !email.trim() || !name.trim() || password.length < 12
						}
						type="submit"
					>
						{busy ? "Creating…" : "Create account"}
					</Button>
				</div>
			</form>
		</section>
	);
}

/**
 * Setting someone's password for them.
 *
 * This stands in for a self-service reset, which is impossible without an email
 * transport. Accounts that sign in another way — a mobile user through Firebase
 * — have no password to replace, and the server says so rather than pretending.
 */
function ResetPassword({ person }: { person: DirectoryUser }) {
	const [busy, setBusy] = useState(false);
	const [issued, setIssued] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reset = async () => {
		const next = suggestPassword();
		if (
			!window.confirm(
				`Set a new password for ${person.email}? This signs them out everywhere.`,
			)
		) {
			return;
		}

		setBusy(true);
		setError(null);
		try {
			await api(`/v1/admin/accounts/${person.id}/password`, {
				method: "POST",
				body: { password: next },
			});
			setIssued(next);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	if (issued) {
		return (
			<div className="text-right">
				<div className="break-all font-mono text-xs">{issued}</div>
				<button
					className="text-muted-foreground text-xs underline"
					onClick={() => setIssued(null)}
					type="button"
				>
					hide
				</button>
			</div>
		);
	}

	return (
		<div className="text-right">
			<Button disabled={busy} onClick={reset} size="xs" variant="ghost">
				{busy ? "…" : "Reset password"}
			</Button>
			{error ? <div className="text-destructive text-xs">{error}</div> : null}
		</div>
	);
}

/**
 * A passphrase from the browser's CSPRNG.
 *
 * Words rather than symbol soup: this gets read aloud or typed from a note, and
 * a password someone mistypes twice gets replaced with a weak one they can
 * remember.
 */
function suggestPassword(): string {
	const words = [
		"harbour",
		"lantern",
		"meadow",
		"cobalt",
		"thistle",
		"marble",
		"juniper",
		"saffron",
		"quarry",
		"willow",
		"cinder",
		"pelican",
	];
	const picks = Array.from(
		crypto.getRandomValues(new Uint32Array(4)),
		(n) => words[n % words.length],
	);
	const digits = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
	return `${picks.join("-")}-${digits % 1000}`;
}

function GrantForm({ onGranted }: { onGranted: () => void }) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<UserRole>("designer");
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const grant = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const result = await api<{ applied: boolean; invited: boolean }>(
				"/v1/admin/roles/assign",
				{
					method: "POST",
					body: {
						email: email.trim(),
						role,
						reason: reason.trim() || undefined,
					},
				},
			);
			toast.success(
				result.invited
					? "No account with that address yet — the role will apply when they first sign in."
					: result.applied
						? "Role granted."
						: "They already have that role.",
			);
			setEmail("");
			setReason("");
			onGranted();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="mb-8 border p-4">
			<h2 className="mb-3 font-medium text-sm">Grant a role</h2>
			<ErrorNote message={error} />
			<form
				className="grid gap-3 sm:grid-cols-[1fr_auto_auto]"
				onSubmit={grant}
			>
				<Field
					hint="The address they sign in to Google with. If they have no account yet the grant waits for them."
					label="Email"
				>
					<Input
						onChange={(event) => setEmail(event.target.value)}
						placeholder="person@example.com"
						required
						type="email"
						value={email}
					/>
				</Field>
				<Field label="Role">
					<select
						className="h-8 border bg-background px-2 text-sm"
						onChange={(event) => setRole(event.target.value as UserRole)}
						value={role}
					>
						{ROLES.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</Field>
				<div className="flex items-end">
					<Button disabled={busy || !email.trim()} type="submit">
						{busy ? "Working…" : "Grant"}
					</Button>
				</div>
				<div className="sm:col-span-3">
					<Field label="Reason (optional, kept on the record)">
						<Input
							maxLength={500}
							onChange={(event) => setReason(event.target.value)}
							placeholder="Joined the content team"
							value={reason}
						/>
					</Field>
				</div>
			</form>
		</section>
	);
}

function Invites({ onChange }: { onChange: () => void }) {
	const [invites, setInvites] = useState<RoleInvite[]>([]);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setInvites(await api<RoleInvite[]>("/v1/admin/roles/invites"));
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const revoke = async (id: string) => {
		try {
			await api(`/v1/admin/roles/invites/${id}`, { method: "DELETE" });
			toast.success("Withdrawn");
			await load();
			onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	if (invites.length === 0) return null;

	return (
		<section className="mb-8">
			<h2 className="mb-3 font-medium text-sm">Waiting for first sign-in</h2>
			<ErrorNote message={error} />
			<List>
				{invites.map((invite) => (
					<Row key={invite.id}>
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm">
								{invite.email ?? invite.phone}
							</div>
							<div className="text-muted-foreground text-xs">
								{invite.role} · offered <When value={invite.createdAt} />
							</div>
						</div>
						<Button onClick={() => revoke(invite.id)} size="sm" variant="ghost">
							Withdraw
						</Button>
					</Row>
				))}
			</List>
		</section>
	);
}

function Directory() {
	const { user } = useSession();
	const [query, setQuery] = useState("");
	const [roleFilter, setRoleFilter] = useState<UserRole | "">("");
	const [people, setPeople] = useState<DirectoryUser[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		const params = new URLSearchParams();
		if (query.trim()) params.set("q", query.trim());
		if (roleFilter) params.set("role", roleFilter);
		try {
			setPeople(await api<DirectoryUser[]>(`/v1/admin/users?${params}`));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [query, roleFilter]);

	useEffect(() => {
		// Debounced: this searches on every keystroke otherwise, and the query
		// matches with a leading wildcard across the largest table in the system.
		const timer = setTimeout(() => void load(), 250);
		return () => clearTimeout(timer);
	}, [load]);

	return (
		<section>
			<h2 className="mb-3 font-medium text-sm">Directory</h2>

			<div className="mb-3 flex flex-wrap gap-2">
				<Input
					className="max-w-xs"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Name, email or phone"
					value={query}
				/>
				<select
					className="h-8 border bg-background px-2 text-sm"
					onChange={(event) =>
						setRoleFilter(event.target.value as UserRole | "")
					}
					value={roleFilter}
				>
					<option value="">Any role</option>
					{ROLES.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>

			<ErrorNote message={error} />

			{loading ? (
				<Empty>Loading…</Empty>
			) : people.length === 0 ? (
				<Empty>Nobody matches.</Empty>
			) : (
				<List>
					{people.map((person) => (
						<Row key={person.id}>
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm">
									{person.name}
									{person.id === user?.id ? (
										<span className="ml-2 text-muted-foreground text-xs">
											you
										</span>
									) : null}
								</div>
								<div className="truncate text-muted-foreground text-xs">
									{person.email}
									{person.phone ? ` · ${person.phone}` : ""}
								</div>
							</div>
							<div className="text-right text-xs">
								<div className="font-medium">{person.role}</div>
								<div className="text-muted-foreground">
									{person.contentCount > 0
										? `${person.contentCount} items`
										: person.regionCode || "—"}
								</div>
							</div>
						</Row>
					))}
				</List>
			)}
		</section>
	);
}
