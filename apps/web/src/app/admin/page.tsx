"use client";

import { Button } from "@greetings/ui/components/button";
import Link from "next/link";
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
import { isSuperAdmin } from "@/lib/session";

interface Overview {
	totalUsers: number;
	totalDesigners: number;
	publishedContent: number;
	awaitingReview: number;
	openReports: number;
	downloadsInRange: number;
}

export default function AdminOverview() {
	return (
		<PanelShell allow={isSuperAdmin}>
			<Body />
		</PanelShell>
	);
}

function Body() {
	const { from, to, preset, setPreset } = useRange();
	const [overview, setOverview] = useState<Overview | null>(null);
	const [series, setSeries] = useState<{ date: string; downloads: number }[]>(
		[],
	);
	const [designers, setDesigners] = useState<
		{ designerId: string; designerName: string; downloads: number }[]
	>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		const query = `?from=${from}&to=${to}`;
		try {
			const [o, t, d] = await Promise.all([
				api<Overview>(`/v1/admin/analytics/overview${query}`),
				api<typeof series>(`/v1/admin/analytics/timeseries${query}`),
				api<typeof designers>(`/v1/admin/analytics/by-designer${query}`),
			]);
			setOverview(o);
			setSeries(t);
			setDesigners(d);
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
			<PageHeader description="The whole platform." title="Overview" />

			<RangePicker onChange={setPreset} value={preset} />
			<ErrorNote message={error} />

			{loading ? (
				<Empty>Loading…</Empty>
			) : (
				<>
					{/* The two counts that mean somebody needs to do something are
					    first, and link to the screen where they would do it. */}
					<div className="mb-6 flex flex-wrap gap-2">
						<Button
							render={<Link href="/moderation" />}
							size="sm"
							variant={overview?.awaitingReview ? "default" : "outline"}
						>
							{overview?.awaitingReview ?? 0} awaiting review
						</Button>
						<Button
							render={<Link href="/moderation/reports" />}
							size="sm"
							variant={overview?.openReports ? "destructive" : "outline"}
						>
							{overview?.openReports ?? 0} open reports
						</Button>
					</div>

					<div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
						<Stat label="Users" value={overview?.totalUsers ?? 0} />
						<Stat label="Designers" value={overview?.totalDesigners ?? 0} />
						<Stat label="Published" value={overview?.publishedContent ?? 0} />
						<Stat
							hint="in this period"
							label="Downloads"
							value={overview?.downloadsInRange ?? 0}
						/>
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

					<section>
						<h2 className="mb-3 font-medium text-sm">Designers by reach</h2>
						{designers.length === 0 ? (
							<Empty>No downloads in this period.</Empty>
						) : (
							<List>
								{designers.slice(0, 20).map((row) => (
									<Row key={row.designerId}>
										<span className="min-w-0 flex-1 truncate text-sm">
											{row.designerName}
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
