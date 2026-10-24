import type { Metadata } from "next";
import Link from "next/link";

import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
	title: "Delete your account — Greetings",
	description: "How to delete your Greetings account and data.",
};

/**
 * The account-deletion page Google Play requires alongside the in-app option,
 * for people who no longer have the app installed. Its URL goes in the Play
 * Console's Data safety form.
 *
 * Bilingual because the app is: someone who uses it in Hindi must be able to
 * read how to leave it.
 */
export default function DeleteAccountPage() {
	return (
		<main className="mx-auto w-full max-w-3xl space-y-10 px-4 py-10 leading-relaxed">
			<header>
				<h1 className="mb-2 font-semibold text-3xl">Delete your account</h1>
				<p className="text-muted-foreground">Greetings app · अपना अकाउंट हटाएँ</p>
			</header>

			<section className="space-y-3">
				<h2 className="font-semibold text-xl">In the app (quickest)</h2>
				<ol className="ml-5 list-decimal space-y-1">
					<li>Open Greetings and go to the Profile tab.</li>
					<li>Scroll to the bottom and tap “Delete my account”.</li>
					<li>Tap “Yes, delete my account”.</li>
				</ol>
				<p>Your account is deleted straight away.</p>
			</section>

			<section className="space-y-3">
				<h2 className="font-semibold text-xl">Without the app</h2>
				<p>
					Email {LEGAL.contactEmail} from the email address you signed in with,
					or tell us the phone number you signed in with, and ask us to delete
					your account. We may ask you to confirm it is your account. We delete
					it within {LEGAL.deletionDays} days and reply when it is done.
				</p>
			</section>

			<section className="space-y-3">
				<h2 className="font-semibold text-xl">What is deleted</h2>
				<ul className="ml-5 list-disc space-y-1">
					<li>Your account and sign-in details.</li>
					<li>
						Your profile: name, work or title, the phone number you print on
						greetings, your logo, languages and state.
					</li>
					<li>Your designs and the pictures in them.</li>
					<li>The list of greetings you saved, and reports you sent.</li>
				</ul>
				<h2 className="pt-2 font-semibold text-xl">What is kept</h2>
				<p>
					A record that a greeting was saved, with the state and language it was
					saved for, so designers’ counts stay correct. It is no longer linked
					to you. Greetings you already sent to others stay wherever you sent
					them. See the{" "}
					<Link className="underline" href="/privacy">
						privacy policy
					</Link>{" "}
					for details.
				</p>
			</section>

			<section className="space-y-3 border-t pt-8" lang="hi">
				<h2 className="font-semibold text-xl">हिन्दी में</h2>
				<p>
					<strong>ऐप में:</strong> प्रोफ़ाइल टैब खोलें → सबसे नीचे “मेरा अकाउंट हटाएँ” →
					“हाँ, मेरा अकाउंट हटाएँ”। आपका अकाउंट तुरंत हट जाएगा।
				</p>
				<p>
					<strong>ऐप के बिना:</strong> {LEGAL.contactEmail} पर उसी ईमेल से लिखें जिससे
					आपने साइन इन किया था, या वह फ़ोन नंबर बताएँ जिससे साइन इन किया था। हम{" "}
					{LEGAL.deletionDays} दिनों के अंदर अकाउंट हटा देंगे।
				</p>
				<p>
					आपकी प्रोफ़ाइल, लोगो, डिज़ाइन और सेव की गई ग्रीटिंग्स की सूची हट जाएगी।
					डिज़ाइनरों की गिनती सही रहे, इसलिए किसी ग्रीटिंग के सेव होने का रिकॉर्ड रहता है,
					पर वह आपसे जुड़ा नहीं रहता।
				</p>
			</section>
		</main>
	);
}
