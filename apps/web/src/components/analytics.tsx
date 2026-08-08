"use client";

/**
 * The analytics furniture, shared by the designer and super-admin screens.
 *
 * No charting library. The only chart either screen needs is "downloads per
 * day", and a bar chart of thirty numbers is a flex container — pulling in a
 * charting dependency to draw it would cost more to load than the page.
 */

import { Button } from "@greetings/ui/components/button";
import { useState } from "react";

export type RangePreset = "7d" | "30d" | "90d" | "365d";

const PRESET_DAYS: Record<RangePreset, number> = {
	"7d": 7,
	"30d": 30,
	"90d": 90,
	"365d": 365,
};

const PRESET_LABELS: Record<RangePreset, string> = {
	"7d": "7 days",
	"30d": "30 days",
	"90d": "90 days",
	"365d": "1 year",
};

function isoDay(offsetDays: number): string {
	const date = new Date(Date.now() - offsetDays * 86_400_000);
	// The API buckets by UTC calendar day, so the range must be expressed the
	// same way or the first and last day of a range are silently wrong.
	return date.toISOString().slice(0, 10);
}

export function useRange(initial: RangePreset = "30d") {
	const [preset, setPreset] = useState<RangePreset>(initial);
	return {
		preset,
		setPreset,
		from: isoDay(PRESET_DAYS[preset] - 1),
		to: isoDay(0),
	};
}

export function RangePicker({
	value,
	onChange,
}: {
	value: RangePreset;
	onChange: (preset: RangePreset) => void;
}) {
	return (
		<div className="mb-6 flex flex-wrap gap-1">
			{(Object.keys(PRESET_LABELS) as RangePreset[]).map((preset) => (
				<Button
					key={preset}
					onClick={() => onChange(preset)}
					size="sm"
					variant={value === preset ? "secondary" : "ghost"}
				>
					{PRESET_LABELS[preset]}
				</Button>
			))}
		</div>
	);
}

export function Stat({
	label,
	value,
	hint,
}: {
	label: string;
	value: number | string;
	hint?: string;
}) {
	return (
		<div className="border px-3 py-2.5">
			<div className="font-semibold text-xl tabular-nums">{value}</div>
			<div className="text-muted-foreground text-xs">{label}</div>
			{hint ? (
				<div className="mt-0.5 text-muted-foreground text-xs">{hint}</div>
			) : null}
		</div>
	);
}

export function Bars({ data }: { data: { label: string; value: number }[] }) {
	if (data.length === 0) {
		return (
			<div className="border border-dashed px-6 py-8 text-center text-muted-foreground text-sm">
				No downloads in this period.
			</div>
		);
	}

	const max = Math.max(...data.map((point) => point.value), 1);

	return (
		<div className="border p-3">
			<div className="flex h-32 items-end gap-px">
				{data.map((point) => (
					<div
						className="group relative flex-1 bg-primary/20 hover:bg-primary/40"
						key={point.label}
						// A zero-download day still gets a sliver, so the axis reads as a
						// continuous run of days rather than a gap that looks like missing
						// data.
						style={{ height: `${Math.max((point.value / max) * 100, 2)}%` }}
						title={`${point.label}: ${point.value}`}
					/>
				))}
			</div>
			<div className="mt-2 flex justify-between text-muted-foreground text-xs">
				<span>{data[0]?.label}</span>
				<span>peak {max}</span>
				<span>{data.at(-1)?.label}</span>
			</div>
		</div>
	);
}
