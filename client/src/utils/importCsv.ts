import type { NewApplication, Status, InterviewStep } from '../types';
import { STATUS_LABELS, STEP_LABELS } from '../constants';
import { parseEmails } from './emailRefs';

/** The shape `createApplication` accepts — an application minus its server-assigned fields. */
export type ImportableApplication = NewApplication;

/** Thrown when a CSV can't be imported as a whole (e.g. no Company column, or a row missing a company). */
export class CsvImportError extends Error {}

// The application fields a CSV column can fill. Everything else is server-assigned.
type Field = 'company' | 'role' | 'status' | 'interview_step' | 'reached_interview' | 'date_applied' | 'last_activity' | 'job_url' | 'notes' | 'company_domain' | 'external_id' | 'account' | 'emails';

// Map a NORMALIZED header (see normalizeHeader: lower-cased, underscores/hyphens → spaces) to the
// field it fills. Keys mirror exportCsv's column headers 1:1 (in normalized form) so a re-imported
// export lines up; the normalizer already absorbs case/underscore/hyphen/spacing variants. The
// "Source" column is intentionally absent — imports are always tagged source 'csv'.
const HEADER_TO_FIELD: Record<string, Field> = {
	'company': 'company',
	'role': 'role',
	'status': 'status',
	'stage': 'interview_step',
	'reached interview': 'reached_interview',
	'date applied': 'date_applied',
	'last response': 'last_activity',
	'job url': 'job_url',
	'notes': 'notes',
	'company domain': 'company_domain',
	'job id': 'external_id',
	'gmail account': 'account',
	'emails': 'emails',
};

// Accept either the human label ("Applied") or the raw value ("applied"), case-insensitively.
const STATUS_BY_LABEL = new Map<string, Status>(
	(Object.entries(STATUS_LABELS) as [Status, string][]).flatMap(([k, v]) => [[k, k], [v.toLowerCase(), k]]),
);
const STEP_BY_LABEL = new Map<string, InterviewStep>(
	(Object.entries(STEP_LABELS) as [InterviewStep, string][]).flatMap(([k, v]) => [[k, k], [v.toLowerCase(), k]]),
);

// Normalize a header for matching: drop the surrounding whitespace, lower-case, and treat
// underscores/hyphens as spaces so "Date_Applied", "date-applied", "DATE APPLIED" all collapse.
const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

// Drop a leading UTF-8 BOM (0xFEFF) — the export prepends one for Excel's sake.
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const pad2 = (n: number) => String(n).padStart(2, '0');

// Coerce a date cell to ISO "yyyy-MM-dd" — the format the DB stores and that <input type="date">
// (the edit window) can display. The app's own export is already ISO, but a spreadsheet round-trip
// often rewrites dates into locale form (Excel turns "2026-05-01" into "5/1/2026"), which the date
// input shows as blank. Handles ISO, year-first and day/month-first slash forms, plus a Date.parse
// fallback for things like "May 1, 2026". Returns null for blank/unparseable cells.
function toIsoDate(raw: string): string | null {
	const s = raw.trim();
	if (!s) return null;

	const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);             // already ISO (drop any time part)
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

	let m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);      // yyyy/M/d
	if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;

	m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);        // M/d/yyyy (or d/M/yyyy)
	if (m) {
		const a = +m[1], b = +m[2];
		const [month, day] = a > 12 ? [b, a] : [a, b];          // first field >12 ⇒ it's the day
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${m[3]}-${pad2(month)}-${pad2(day)}`;
	}

	const d = new Date(s);                                       // last resort: "May 1, 2026", etc.
	return isNaN(d.getTime()) ? null : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// RFC-4180 parser: splits CSV text into rows of cells, honouring quoted fields that contain
// commas, quotes (escaped as ""), or newlines. Tolerates both \n and \r\n line endings.
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
			} else {
				cell += c;
			}
		} else if (c === '"') {
			quoted = true;
		} else if (c === ',') {
			row.push(cell); cell = '';
		} else if (c === '\n') {
			row.push(cell); cell = ''; rows.push(row); row = [];
		} else if (c !== '\r') {
			cell += c;
		}
	}
	if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
	return rows.filter(r => r.some(c => c.trim() !== ''));
}

/**
 * Parse a CSV (as produced by the Export button, or hand-edited in a spreadsheet) into importable
 * applications. Columns are matched by normalized header name, so reordered, re-cased, or
 * underscore/space variants still line up with the right field; unknown columns are ignored.
 *
 * Company is mandatory: if there's no Company column, the whole sheet is rejected (a CsvImportError
 * is thrown and nothing is imported). Every other field falls back to empty, and a missing/unknown
 * status defaults to "applied".
 */
export function parseApplicationsCsv(text: string): ImportableApplication[] {
	const rows = parseCsv(stripBom(text));
	if (rows.length < 2) return [];

	// Map each known field to its column index via the normalized header.
	const colOf = {} as Partial<Record<Field, number>>;
	rows[0].forEach((header, i) => {
		const field = HEADER_TO_FIELD[normalizeHeader(header)];
		if (field && colOf[field] === undefined) colOf[field] = i;   // first matching column wins
	});

	if (colOf.company === undefined) {
		throw new CsvImportError('The CSV needs a "Company" column.');
	}
	const cell = (row: string[], field: Field) => {
		const i = colOf[field];
		return i === undefined ? '' : (row[i] ?? '').trim();
	};

	return rows.slice(1).map((row, n) => {
		const company = cell(row, 'company');
		if (!company) {
			throw new CsvImportError(`Row ${n + 2} is missing a company — nothing was imported.`);
		}
		let status = STATUS_BY_LABEL.get(cell(row, 'status').toLowerCase()) ?? 'applied';
		// Interview/offer always imply the app reached an interview; an explicit "Yes" covers the
		// rejected-after-interview case too.
		const reached = cell(row, 'reached_interview').toLowerCase() === 'yes' || status === 'interview' || status === 'offer';
		// …and the inverse: a row that reached an interview can't still be merely "applied" (you'd be
		// at interview/offer/rejected by then), so promote that contradiction to "interview".
		if (reached && status === 'applied') status = 'interview';
		return {
			company,
			role: cell(row, 'role') || 'Unknown Role',
			status,
			interview_step: STEP_BY_LABEL.get(cell(row, 'interview_step').toLowerCase()) ?? null,
			reached_interview: reached,
			date_applied: toIsoDate(cell(row, 'date_applied')),
			last_activity: toIsoDate(cell(row, 'last_activity')),
			job_url: cell(row, 'job_url') || null,
			notes: cell(row, 'notes') || null,
			// Dedup keys carried over from a prior export, so the next sync re-merges instead of
			// duplicating. Absent in a hand-made CSV → null (sync falls back to name + role).
			company_domain: cell(row, 'company_domain') || null,
			external_id: cell(row, 'external_id') || null,
			source: 'csv',
			gmail_thread_id: null,
			// Email-link data round-tripped from a prior export (the Gmail account + tracked messages).
			account: cell(row, 'account') || null,
			emails: parseEmails(cell(row, 'emails')),
		};
	});
}
