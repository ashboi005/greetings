/**
 * The facts the public legal pages (/privacy, /delete-account) depend on, in
 * one place.
 *
 * PLACEHOLDERS — fill these in before submitting to Google Play. Every value
 * in [square brackets] is shown on the live pages as-is until then, which is
 * deliberate: a half-filled policy should look unfinished, not plausible.
 */
export const LEGAL = {
	/** The person or company that publishes the app (the "data fiduciary"). */
	publisher: "[Publisher name — person or registered company]",
	/** Where privacy questions and deletion requests go. Must be monitored. */
	contactEmail: "[privacy contact email]",
	/** Postal address; required for an organisation, recommended either way. */
	postalAddress: "[Postal address]",
	/** India's DPDP Act asks for a named Grievance Officer. */
	grievanceOfficer: "[Grievance Officer name]",
	/** The date this version of the policy takes effect. */
	effectiveDate: "[Effective date]",
	/** How long a deletion request takes to complete. */
	deletionDays: 30,
} as const;
