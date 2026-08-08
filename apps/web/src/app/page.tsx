"use client";

import { Button } from "@greetings/ui/components/button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
	canModerate,
	isDesigner,
	isSuperAdmin,
	useSession,
} from "@/lib/session";

/**
 * The front door.
 *
 * Nobody should ever look at this page for long: it works out where the signed-
 * in person belongs and sends them there. It exists at all for the case where
 * someone holds an account with no panel role — an end user who found the web
 * address — who needs a plain explanation rather than a redirect loop.
 */
export default function Home() {
	const { user, loading } = useSession();
	const router = useRouter();

	useEffect(() => {
		if (loading) return;
		if (!user) {
			router.replace("/login");
			return;
		}
		// Super admins land on the overview; the moderation and designer links
		// are in the navigation from there.
		if (isSuperAdmin(user.role)) router.replace("/admin");
		else if (canModerate(user.role)) router.replace("/moderation");
		else if (isDesigner(user.role)) router.replace("/designer");
	}, [loading, user, router]);

	if (loading || !user) {
		return (
			<div className="px-4 py-10 text-muted-foreground text-sm">Loading…</div>
		);
	}

	if (isDesigner(user.role) || canModerate(user.role)) return null;

	return (
		<div className="mx-auto w-full max-w-md px-4 py-16">
			<h1 className="font-semibold text-xl tracking-tight">
				Nothing here for you yet
			</h1>
			<p className="mt-2 text-muted-foreground text-sm">
				You are signed in as {user.email}, but this account has no designer or
				administrator role. These panels are for the people who make and review
				content.
			</p>
			<p className="mt-4 text-muted-foreground text-sm">
				If you are looking for greeting images to share, they are in the mobile
				app. If you were expecting access here, ask an administrator to grant
				your role — they will need this address.
			</p>
			<Button
				render={<Link href="/login" />}
				className="mt-6"
				variant="outline"
			>
				Sign in as someone else
			</Button>
		</div>
	);
}
