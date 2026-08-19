"use client";

import { Button } from "@greetings/ui/components/button";
import { Input } from "@greetings/ui/components/input";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorNote, Field } from "@/components/panel";
import { authClient } from "@/lib/auth-client";
import { useSession } from "@/lib/session";

/**
 * Sign in.
 *
 * Email and password, with no sign-up link — deliberately. Panel accounts are
 * created by a super admin, so there is nothing here for someone without one to
 * do, and offering a form that always fails would be worse than offering none.
 */
export default function LoginPage() {
	const router = useRouter();
	const { user, loading, refresh } = useSession();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!loading && user) router.replace("/");
	}, [loading, user, router]);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);

		const { error: failure } = await authClient.signIn.email({
			email: email.trim(),
			password,
		});

		if (failure) {
			// Deliberately vague, and the same for a wrong address as a wrong
			// password: a message that distinguishes them tells someone probing
			// which addresses have accounts.
			setError("That email and password did not match an account.");
			setBusy(false);
			return;
		}

		// The provider holds the session, so it has to re-check before the router
		// moves — otherwise the destination sees a signed-out state and bounces
		// straight back here.
		await refresh();
		router.replace("/");
	};

	return (
		<div className="mx-auto flex w-full max-w-sm flex-col justify-center px-4 py-16">
			<h1 className="font-semibold text-xl tracking-tight">Greetings</h1>
			<p className="mt-1 mb-6 text-muted-foreground text-sm">
				Sign in to the designer and admin panels.
			</p>

			<ErrorNote message={error} />

			<form className="space-y-4" onSubmit={submit}>
				<Field label="Email">
					<Input
						autoComplete="username"
						onChange={(event) => setEmail(event.target.value)}
						required
						type="email"
						value={email}
					/>
				</Field>

				<Field label="Password">
					<Input
						autoComplete="current-password"
						onChange={(event) => setPassword(event.target.value)}
						required
						type="password"
						value={password}
					/>
				</Field>

				<Button
					className="w-full"
					disabled={busy || !email.trim() || !password}
					size="lg"
					type="submit"
				>
					{busy ? "Signing in…" : "Sign in"}
				</Button>
			</form>

			<p className="mt-6 text-muted-foreground text-xs">
				Accounts are created by an administrator. If you have forgotten your
				password, ask one to set a new one — there is no self-service reset.
			</p>
			<p className="mt-2 text-muted-foreground text-xs">
				If you are here to find greeting images, use the mobile app.
			</p>
		</div>
	);
}
