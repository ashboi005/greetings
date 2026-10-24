import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
	title: "Privacy policy — Greetings",
	description: "How the Greetings app collects, uses and protects your data.",
};

/**
 * The app's privacy policy, linked from the Play listing, AdMob and the app's
 * Profile screen.
 *
 * A DRAFT written from what the app actually does (see docs/mobile-app.md and
 * lib/analytics.ts in the app). It is not legal advice: have it reviewed, fill
 * the placeholders in src/lib/legal.ts, and remove the banner, before launch.
 * Keep it in step with the app — a new SDK or a new field is a policy change.
 */
export default function PrivacyPolicyPage() {
	return (
		<main className="mx-auto w-full max-w-3xl px-4 py-10">
			<p className="mb-8 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
				Draft for review. Not yet final: details in [square brackets] are still
				to be filled in.
			</p>

			<h1 className="mb-2 font-semibold text-3xl">Privacy policy</h1>
			<p className="mb-8 text-muted-foreground text-sm">
				Effective {LEGAL.effectiveDate}. Applies to the Greetings mobile app.
			</p>

			<Section title="Who we are">
				<p>
					Greetings is published by {LEGAL.publisher} (“we”, “us”). For anything
					in this policy, write to {LEGAL.contactEmail}. Our Grievance Officer
					is {LEGAL.grievanceOfficer}, at the same address or by post to{" "}
					{LEGAL.postalAddress}.
				</p>
			</Section>

			<Section title="What we collect">
				<h3 className="font-medium">When you sign in</h3>
				<ul>
					<li>
						Your phone number (sign-in by SMS code), or your email address
						(email or Google sign-in), and your name from Google if you use it.
						Sign-in is handled by Google Firebase Authentication.
					</li>
				</ul>

				<h3 className="font-medium">What you tell us</h3>
				<ul>
					<li>The languages you want greetings in, and your state.</li>
					<li>
						Optional details you choose to print on greetings: your name, your
						work or title, a phone number to show, and a logo or photo. The
						phone number shown on greetings is whatever you type; it is not
						checked or called.
					</li>
					<li>Designs you create, including any photo you add to them.</li>
					<li>Reports you send about a greeting.</li>
				</ul>

				<h3 className="font-medium">When you use the app</h3>
				<ul>
					<li>
						Which greetings you save or share, when, from where in the app, and
						whether you added your details. Each record also stores the state
						and language from your profile.
					</li>
					<li>
						Usage and device information collected by the services listed below:
						screens viewed and taps, device model and operating system, app
						version, approximate location derived from your IP address, crash
						reports, and, for ads, your device’s advertising identifier.
					</li>
				</ul>

				<h3 className="font-medium">Photos</h3>
				<p>
					The app asks for access to your photos only to save a greeting you
					chose to save, and opens your photo picker only when you choose a logo
					or a picture for a design. It does not read your photo library
					otherwise.
				</p>
			</Section>

			<Section title="How we use it">
				<ul>
					<li>To sign you in and keep your account and designs.</li>
					<li>To show greetings in your languages and for your state first.</li>
					<li>To print your details on greetings, only when you choose to.</li>
					<li>
						To show designers how often their greetings are saved, by state and
						language. Designers never see who you are.
					</li>
					<li>To show ads, which keep the app free.</li>
					<li>To find and fix problems, and to improve the app.</li>
					<li>To act on reports and keep the app safe.</li>
				</ul>
			</Section>

			<Section title="Who we share it with">
				<p>
					We do not sell your data. We use these providers, who process data on
					our behalf or as described in their own policies:
				</p>
				<ul>
					<li>
						<strong>Google</strong>: Firebase Authentication (sign-in), Google
						Analytics for Firebase (usage), Firebase Crashlytics (crash
						reports), and AdMob (ads).
					</li>
					<li>
						<strong>Microsoft Clarity</strong>: how the app is used (screens,
						taps). Text on screen is masked.
					</li>
					<li>
						<strong>Cloudflare</strong>: storing and delivering images,
						including your logo and design pictures.
					</li>
					<li>
						<strong>[Server hosting provider]</strong>: where our servers and
						database run.
					</li>
				</ul>
				<p>
					Some of these providers store data outside India. Greetings you send
					to others, for example on WhatsApp, are outside our control once sent,
					including any details you chose to print on them.
				</p>
			</Section>

			<Section title="Ads and your choices">
				<p>
					Ads are served by Google AdMob, which may use your device’s
					advertising identifier to show more relevant ads. Where the law
					requires it, the app asks for your consent first, and you can change
					it later under Profile → Privacy choices. On iPhone, the app asks
					before tracking. You can also reset or limit your advertising
					identifier in your phone’s settings.
				</p>
			</Section>

			<Section title="How long we keep it">
				<p>
					We keep your account and what you created while your account exists.
					When you delete your account, your profile, details, logo, designs and
					their pictures are deleted, normally at once and in any case within{" "}
					{LEGAL.deletionDays} days. Records that a greeting was saved are kept
					for designers’ counts, but are no longer linked to you. Backups are
					overwritten on a rolling basis within [backup retention period].
				</p>
			</Section>

			<Section title="Your rights">
				<p>
					Under India’s Digital Personal Data Protection Act, 2023, you can ask
					to see the data we hold about you, to correct it, and to delete it;
					withdraw consent you gave; nominate someone to act for you; and raise
					a grievance with us. You can edit most details yourself in the app’s
					Profile screen, and delete your account there or as described on our{" "}
					<Link className="underline" href="/delete-account">
						account deletion page
					</Link>
					. If you are not satisfied with our answer to a grievance, you may
					complain to the Data Protection Board of India.
				</p>
			</Section>

			<Section title="Children">
				<p>
					Greetings is not meant for anyone under 18, and we do not knowingly
					collect data from them. If you believe a child has given us their
					data, write to {LEGAL.contactEmail} and we will delete it.
				</p>
			</Section>

			<Section title="Security">
				<p>
					Data is sent over encrypted connections, sign-in uses verified codes
					rather than passwords we store, and access to our systems is limited
					to the people who need it.
				</p>
			</Section>

			<Section title="Changes">
				<p>
					If we change this policy, we will update the date above, and tell you
					in the app when the change matters.
				</p>
			</Section>
		</main>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="mb-8 space-y-3 leading-relaxed [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-2">
			<h2 className="font-semibold text-xl">{title}</h2>
			{children}
		</section>
	);
}
