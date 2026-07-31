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
	const totalSeconds = Math.round(ms / 1000);
	const hours   = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (seconds || !parts.length) parts.push(`${seconds}s`);
	return parts.join(' ');
}

// ── Local date/time formatting ───────────────────────────────────────────────
// The desktop app runs on the user's own machine, so LOCAL time IS the user's day and clock. toISOString()
// would format in UTC, which for a timezone behind UTC turns an evening instant into the next calendar day —
// the bug these helpers exist to avoid. One home for all of it so every caller formats identically.

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/** A calendar day as YYYY-MM-DD in the machine's local timezone. Used for date_applied/last_activity and
 *  the dated log filenames, so an evening email keeps its local day instead of rolling to the next. */
export function localDateString(instant: Date = new Date()): string {
	return `${instant.getFullYear()}-${twoDigits(instant.getMonth() + 1)}-${twoDigits(instant.getDate())}`;
}

/** A local wall-clock timestamp "YYYY-MM-DD HH:mm:ss ABBR (UTC±HH:MM)": the date matches localDateString,
 *  the time is the local clock, and the timezone (short name when the runtime supplies one, plus the numeric
 *  offset) makes the instant unambiguous to a reader in any timezone. Used for in-file log timestamps. */
export function localTimestamp(instant: Date = new Date()): string {
	const wallClockTime = `${localDateString(instant)} ${twoDigits(instant.getHours())}:${twoDigits(instant.getMinutes())}:${twoDigits(instant.getSeconds())}`;

	// getTimezoneOffset is minutes from local TO UTC: +240 => UTC-4 (behind UTC), -480 => UTC+8 (ahead).
	const minutesFromLocalToUtc = instant.getTimezoneOffset();
	const offsetSign = minutesFromLocalToUtc <= 0 ? '+' : '-';
	const utcOffsetLabel = `UTC${offsetSign}${twoDigits(Math.floor(Math.abs(minutesFromLocalToUtc) / 60))}:${twoDigits(Math.abs(minutesFromLocalToUtc) % 60)}`;

	// A short zone name ("EDT", "PST") is friendlier than the offset alone; skip a "GMT-4"-style name (the
	// numeric offset already covers it) and tolerate a runtime without full ICU data.
	let zoneAbbreviation = '';
	try {
		const shortZoneName = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
			.formatToParts(instant).find(part => part.type === 'timeZoneName')?.value;
		if (shortZoneName && !/^(?:UTC|GMT)/i.test(shortZoneName)) zoneAbbreviation = `${shortZoneName} `;
	} catch { /* Intl without full ICU — the numeric offset is enough */ }

	return `${wallClockTime} ${zoneAbbreviation}(${utcOffsetLabel})`;
}
