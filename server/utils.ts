import type { Status } from './types';

// Status only moves FORWARD: applied → interview → offer/rejected. A later email never rolls it back (a
// stray "we received your application" can't undo an interview), and a terminal state is final — an offer
// never becomes rejected. reached_interview stickiness is handled separately by the caller.
const STAGE: Record<Status, number> = { applied: 0, interview: 1, offer: 2, rejected: 2 };
export function resolveStatus(current: Status, incoming: Status): Status {
	if (current === 'offer' || current === 'rejected') return current;   // terminal — never moves
	return STAGE[incoming] >= STAGE[current] ? incoming : current;       // forward-only
}

// A LinkedIn/Indeed fast-apply NOTICE ("your application was sent"). Excludes "_rejected" — stamping
// fast_apply from a rejection wrongly splits the real notice off later (the EarthCam bug).
export const isFastApplyNotice = (classifierCode: string | undefined): boolean =>
	/^(?:linkedin|indeed)_applied$/.test(classifierCode ?? '');

// Subject reads as a later STATUS PING, not a fresh confirmation. Only DEMOTES — a genuine confirmation
// overrides it (see looksLikeConfirmation), so a mis-titled "Employment Update" isn't demoted.
export const looksLikeStatusUpdate = (subject: string): boolean => /\bupdate\b/i.test(subject);

// A category-'applied' email carrying confirmation language. Decisions are already routed elsewhere, so
// within 'applied' this reliably means a confirmation even when the subject is mis-titled "…Update".
const CONFIRMATION_RE = /received your (?:job )?application|application (?:has been|was) (?:received|sent)|thank(?:s| you) for (?:applying|submitting)|we will (?:contact|be in touch|review)/i;
export const looksLikeConfirmation = (subject: string, body: string): boolean =>
	CONFIRMATION_RE.test(`${subject}\n${body}`);

export const errMsg = (e: unknown, fallback: string): string => {
	if (e instanceof Error) return e.message;
	if (typeof e === 'string') return e;
	return fallback;
};

/** A millisecond duration as compact h/m/s ("5m 41s", "1h 2m", "8s"). Zero-value units are dropped. */
export function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const parts: string[] = [];
	if (h) parts.push(`${h}h`);
	if (m) parts.push(`${m}m`);
	if (s || !parts.length) parts.push(`${s}s`);
	return parts.join(' ');
}
