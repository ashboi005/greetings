"use client";

/**
 * Who is signed in, and what they may see.
 *
 * The role comes from `/v1/auth/me`, which reads it from the session — the same
 * source the server authorises against. Deliberately not from a separate user
 * lookup: two sources for one fact means a screen can show a designer's
 * navigation to someone the API will refuse.
 *
 * This gates *navigation*, not access. Every endpoint enforces its own role
 * server-side; hiding a link the API would refuse anyway is a courtesy, and
 * treating it as security would be a mistake.
 */

import { createContext, useContext, useEffect, useState } from "react";
import {
	api,
	type CurrentUser,
	setUnauthenticatedHandler,
	type UserRole,
} from "./api";

interface SessionState {
	user: CurrentUser | null;
	loading: boolean;
	refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState>({
	user: null,
	loading: true,
	refresh: async () => {},
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
	const [user, setUser] = useState<CurrentUser | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = async () => {
		try {
			setUser(await api<CurrentUser>("/v1/auth/me"));
		} catch {
			// A 401 here is the normal signed-out case, not an error worth
			// surfacing — the router sends them to the sign-in screen.
			setUser(null);
		} finally {
			setLoading(false);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: this establishes the session once, on mount; refresh is exposed for callers that need to re-check it
	useEffect(() => {
		void refresh();

		// Any 401 from anywhere in the app means the session this provider is
		// holding is gone. Clearing it is enough: PanelShell watches `user` and
		// sends them to sign in.
		setUnauthenticatedHandler(() => setUser(null));
		return () => setUnauthenticatedHandler(null);
	}, []);

	return (
		<SessionContext.Provider value={{ user, loading, refresh }}>
			{children}
		</SessionContext.Provider>
	);
}

export function useSession() {
	return useContext(SessionContext);
}

/** Roles allowed into the web panels at all. End users are mobile-only. */
export const PANEL_ROLES: UserRole[] = ["designer", "admin", "super_admin"];

export function canModerate(role: UserRole | undefined): boolean {
	return role === "admin" || role === "super_admin";
}

export function isSuperAdmin(role: UserRole | undefined): boolean {
	return role === "super_admin";
}

export function isDesigner(role: UserRole | undefined): boolean {
	return role === "designer";
}
