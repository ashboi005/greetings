"use client";

import { Button } from "@greetings/ui/components/button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useSession } from "@/lib/session";
import { ModeToggle } from "./mode-toggle";

const ROLE_LABELS: Record<string, string> = {
	designer: "Designer",
	admin: "Admin",
	super_admin: "Super admin",
	user: "User",
};

export default function Header() {
	const { user, loading, refresh } = useSession();
	const router = useRouter();

	const signOut = async () => {
		await authClient.signOut();
		await refresh();
		router.push("/login");
	};

	return (
		<header className="border-b">
			<div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-2">
				<Link className="font-semibold text-sm tracking-tight" href="/">
					Greetings
				</Link>

				<div className="flex items-center gap-2">
					{!loading && user ? (
						<>
							{/* The role is shown because it decides what the person can
							    do here, and "why can I not see the queue" is otherwise a
							    support conversation. */}
							<span className="hidden text-muted-foreground text-xs sm:inline">
								{user.name} · {ROLE_LABELS[user.role] ?? user.role}
							</span>
							<Button onClick={signOut} size="sm" variant="ghost">
								Sign out
							</Button>
						</>
					) : null}
					<ModeToggle />
				</div>
			</div>
		</header>
	);
}
