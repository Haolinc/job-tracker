import type { Status } from './types';

// Status only moves FORWARD: applied → interview → offer/rejected. A later email never rolls it back (a
// stray "we received your application" can't undo an interview), and a terminal state is final — an offer
// never becomes rejected. reached_interview stickiness is handled separately by the caller.
const STAGE: Record<Status, number> = { applied: 0, interview: 1, offer: 2, rejected: 2 };
export function resolveStatus(current: Status, incoming: Status): Status {
	if (current === 'offer' || current === 'rejected') return current;   // terminal — never moves
	return STAGE[incoming] >= STAGE[current] ? incoming : current;       // forward-only
}

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
