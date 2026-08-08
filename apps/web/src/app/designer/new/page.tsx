"use client";

import { Button } from "@greetings/ui/components/button";
import { Input } from "@greetings/ui/components/input";
import { Textarea } from "@greetings/ui/components/textarea";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorNote, Field, PageHeader, PanelShell } from "@/components/panel";
import { api, errorMessage } from "@/lib/api";
import { isDesigner } from "@/lib/session";

interface Reference {
	code: string;
	name: string;
	nativeName?: string;
}

export default function NewContentPage() {
	return (
		<PanelShell allow={isDesigner}>
			<NewContentForm />
		</PanelShell>
	);
}

function NewContentForm() {
	const router = useRouter();
	const [languages, setLanguages] = useState<Reference[]>([]);
	const [regions, setRegions] = useState<Reference[]>([]);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [language, setLanguage] = useState("");
	const [region, setRegion] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		void (async () => {
			try {
				const [langs, regs] = await Promise.all([
					api<Reference[]>("/v1/languages"),
					api<Reference[]>("/v1/regions"),
				]);
				setLanguages(langs);
				setRegions(regs);
				setLanguage((current) => current || (langs[0]?.code ?? ""));
			} catch (cause) {
				setError(errorMessage(cause));
			}
		})();
	}, []);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const created = await api<{ id: string }>("/v1/designer/content", {
				method: "POST",
				body: {
					title: title.trim(),
					description: description.trim() || undefined,
					primaryLanguage: language,
					// Empty means everywhere. The API distinguishes "no region" from
					// "a region I did not name", so the empty string must not be sent.
					regionCode: region || undefined,
				},
			});
			// Straight to the editor: a draft with no image cannot be submitted, so
			// leaving someone on a "created!" screen would strand them one step from
			// the thing they actually came to do.
			router.push(`/designer/content/${created.id}`);
		} catch (cause) {
			setError(errorMessage(cause));
			setSaving(false);
		}
	};

	return (
		<>
			<PageHeader
				description="Details first, then the image on the next screen."
				title="New image"
			/>

			<ErrorNote message={error} />

			<form className="max-w-xl space-y-4" onSubmit={submit}>
				<Field
					hint="What a user will read under the picture. Write it in the language of the image."
					label="Title"
				>
					<Input
						maxLength={200}
						onChange={(event) => setTitle(event.target.value)}
						placeholder="शुभ प्रभात"
						required
						value={title}
					/>
				</Field>

				<Field label="Description (optional)">
					<Textarea
						maxLength={2000}
						onChange={(event) => setDescription(event.target.value)}
						rows={3}
						value={description}
					/>
				</Field>

				<Field label="Language">
					<select
						className="h-8 w-full border bg-background px-2 text-sm"
						onChange={(event) => setLanguage(event.target.value)}
						required
						value={language}
					>
						{languages.map((item) => (
							<option key={item.code} value={item.code}>
								{item.nativeName
									? `${item.name} (${item.nativeName})`
									: item.name}
							</option>
						))}
					</select>
				</Field>

				<Field
					hint="Leave as All India unless the image only makes sense in one state. Region-specific content still reaches everyone, it just ranks higher where it belongs."
					label="Region"
				>
					<select
						className="h-8 w-full border bg-background px-2 text-sm"
						onChange={(event) => setRegion(event.target.value)}
						value={region}
					>
						<option value="">All India</option>
						{regions.map((item) => (
							<option key={item.code} value={item.code}>
								{item.name}
							</option>
						))}
					</select>
				</Field>

				<Button disabled={saving || !title.trim() || !language} type="submit">
					{saving ? "Creating…" : "Create draft"}
				</Button>
			</form>
		</>
	);
}
