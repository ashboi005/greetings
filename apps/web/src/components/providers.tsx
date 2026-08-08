"use client";

import { Toaster } from "@greetings/ui/components/sonner";

import { SessionProvider } from "@/lib/session";
import { ThemeProvider } from "./theme-provider";

export default function Providers({ children }: { children: React.ReactNode }) {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="system"
			enableSystem
			disableTransitionOnChange
		>
			<SessionProvider>{children}</SessionProvider>
			<Toaster richColors />
		</ThemeProvider>
	);
}
