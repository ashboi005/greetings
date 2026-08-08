"use client";

import { Button } from "@greetings/ui/components/button";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorNote } from "@/components/panel";
import { authClient } from "@/lib/auth-client";
import { useSession } from "@/lib/session";

/**
 * Sign in.
 *
 * Google only. The server has email and password switched off deliberately —
 * the product has no password flow, and leaving one enabled would be a second,
 * weaker route into an admin account.
 */
export default function LoginPage() {
	const router = useRouter();
	const { user, loading } = useSession();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!loading && user) router.replace("/");
	}, [loading, user, router]);

	const signIn = async () => {
		setBusy(true);
		setError(null);
		try {
			await authClient.signIn.social({
				provider: "google",
				callbackURL: `${window.location.origin}/`,
			});
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not reach Google. Try again.",
			);
			setBusy(false);
		}
	};

	return (
		<div className="mx-auto flex w-full max-w-sm flex-col justify-center px-4 py-16">
			<h1 className="font-semibold text-xl tracking-tight">Greetings</h1>
			<p className="mt-1 mb-6 text-muted-foreground text-sm">
				Sign in to the designer and admin panels.
			</p>

			<ErrorNote message={error} />

			<Button disabled={busy} onClick={signIn} size="lg">
				{busy ? "Redirecting…" : "Continue with Google"}
			</Button>

			<p className="mt-6 text-muted-foreground text-xs">
				These panels are for designers and administrators. If you are here to
				find greeting images, use the mobile app.
			</p>
		</div>
	);
}
