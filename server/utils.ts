export const errMsg = (e: unknown, fallback: string): string => {
	if (e instanceof Error) return e.message;
	if (typeof e === 'string') return e;
	return fallback;
};

/**
 * Stable compound key used to match emails to existing applications.
 * Both sides are lowercased and whitespace-collapsed so slight formatting
 * differences between emails (extra spaces, different casing) still resolve
 * to the same entry.
 *
 * Including the full role (with any reference/job codes) lets us distinguish
 * two applications for the same title at the same company:
 *   buildLookupKey("City of New York", "Java Developer (reference number: 779128)")
 *   → "city of new york::java developer (reference number: 779128)"
 */
export function buildLookupKey(company: string, role: string): string {
	const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
	return `${norm(company)}::${norm(role)}`;
}
