"use client";

import { useCallback, useEffect, useState } from "react";
import { Bars, RangePicker, Stat, useRange } from "@/components/analytics";
import {
	Empty,
	ErrorNote,
	List,
	PageHeader,
	PanelShell,
	Row,
} from "@/components/panel";
import { api, errorMessage } from "@/lib/api";
import { isDesigner } from "@/lib/session";

interface Summary {
	totalDownloads: number;
	contentWithDownloads: number;
	regionsReached: number;
}

export default function DesignerAnalytics() {
	return (
		<PanelShell allow={isDesigner}>
			<Body />
		</PanelShell>
	);
}

function Body() {
	const { from, to, setPreset, preset } = useRange();
	const [summary, setSummary] = useState<Summary | null>(null);
	const [byContent, setByContent] = useState<
		{ contentId: string; title: string; downloads: number; status: string }[]
	>([]);
	const [byRegion, setByRegion] = useState<
		{ regionCode: string; regionName: string | null; downloads: number }[]
	>([]);
	const [series, setSeries] = useState<{ date: string; downloads: number }[]>(
		[],
	);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		const query = `?from=${from}&to=${to}`;
		try {
			const [s, c, r, t] = await Promise.all([
				api<Summary>(`/v1/designer/analytics/summary${query}`),
				api<typeof byContent>(`/v1/designer/analytics/by-content${query}`),
				api<typeof byRegion>(`/v1/designer/analytics/by-region${query}`),
				api<typeof series>(`/v1/designer/analytics/timeseries${query}`),
			]);
			setSummary(s);
			setByContent(c);
			setByRegion(r);
			setSeries(t);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [from, to]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<>
			<PageHeader
				description="Downloads of your own content. Nobody else's numbers are visible here, and yours are not visible to other designers."
				title="Analytics"
			/>

			<RangePicker onChange={setPreset} value={preset} />
			<ErrorNote message={error} />

			{loading ? (
				<Empty>Loading…</Empty>
			) : (
				<>
					<div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
						<Stat label="Downloads" value={summary?.totalDownloads ?? 0} />
						<Stat
							label="Images downloaded"
							value={summary?.contentWithDownloads ?? 0}
						/>
						<Stat label="States reached" value={summary?.regionsReached ?? 0} />
					</div>

					<section className="mb-8">
						<h2 className="mb-3 font-medium text-sm">Downloads per day</h2>
						<Bars
							data={series.map((point) => ({
								label: point.date,
								value: point.downloads,
							}))}
						/>
					</section>

					<section className="mb-8">
						<h2 className="mb-3 font-medium text-sm">Most downloaded</h2>
						{byContent.length === 0 ? (
							<Empty>No downloads in this period.</Empty>
						) : (
							<List>
								{byContent.slice(0, 20).map((row) => (
									<Row key={row.contentId}>
										<span className="min-w-0 flex-1 truncate text-sm">
											{row.title}
										</span>
										<span className="font-medium text-sm tabular-nums">
											{row.downloads}
										</span>
									</Row>
								))}
							</List>
						)}
					</section>

					<section>
						<h2 className="mb-3 font-medium text-sm">Where they were saved</h2>
						{byRegion.length === 0 ? (
							<Empty>No downloads in this period.</Empty>
						) : (
							<List>
								{byRegion.map((row) => (
									<Row key={row.regionCode || "unknown"}>
										<span className="min-w-0 flex-1 truncate text-sm">
											{/* An empty region is a user who downloaded before
											    choosing one. Naming it beats an unexplained blank. */}
											{row.regionName ?? "Not yet onboarded"}
										</span>
										<span className="font-medium text-sm tabular-nums">
											{row.downloads}
										</span>
									</Row>
								))}
							</List>
						)}
					</section>
				</>
			)}
		</>
	);
}
