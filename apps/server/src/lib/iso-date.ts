import { badRequest } from "./errors";

/** Accepts only real Gregorian calendar dates in canonical YYYY-MM-DD form. */
export function assertIsoDate(value: string, field: string): void {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw invalidDate(field);
	}

	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (
		Number.isNaN(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== value
	) {
		throw invalidDate(field);
	}
}

function invalidDate(field: string) {
	return badRequest(`\`${field}\` must be a date in YYYY-MM-DD form.`);
}
