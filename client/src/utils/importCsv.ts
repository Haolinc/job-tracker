import type { Application, NewApplication, Status, InterviewStep, EmailRef } from '../types';
import { STATUS_LABELS, STEP_LABELS } from '../constants';
import { parseEmails, serializeEmails } from './emailRefs';

/** Thrown when a CSV can't be imported as a whole (e.g. no Company column, or a row missing a company). */
export class CsvImportError extends Error {}

// The application fields a CSV column can fill, plus 'id' (the exported application id — used only
// to match a re-imported row back to its application, never written). Everything else is server-assigned.
export type Field = 'id' | 'company' | 'role' | 'status' | 'interview_step' | 'reached_interview' | 'date_applied' | 'last_activity' | 'job_url' | 'notes' | 'company_domain' | 'external_id' | 'account' | 'emails';

// Map a NORMALIZED header (see normalizeHeader: lower-cased, underscores/hyphens → spaces) to the
// field it fills. Keys mirror exportCsv's column headers 1:1 (in normalized form) so a re-imported
// export lines up; the normalizer already absorbs case/underscore/hyphen/spacing variants. The
// "Source" column is intentionally absent — imports are always tagged source 'csv'.
const HEADER_TO_FIELD: Record<string, Field> = {
	'id': 'id',
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

/** A parsed CSV row: the importable fields plus the exported application id, if the file carried one. */
export type ParsedApplication = NewApplication & { id: string | null };

/** A parsed CSV: the applications plus which fields actually had a column in the file. */
export interface ParsedCsv {
	apps: ParsedApplication[];
	// Fields backed by a real column. Re-import only compares/updates these, so a partial
	// (hand-made) CSV can't blank out fields its columns don't cover.
	fields: Set<Field>;
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
export function parseApplicationsCsv(text: string): ParsedCsv {
	const rows = parseCsv(stripBom(text));
	if (rows.length < 2) return { apps: [], fields: new Set() };

	// Map each known field to its column index via the normalized header.
	const columnIndexByField = {} as Partial<Record<Field, number>>;
	rows[0].forEach((header, columnIndex) => {
		const field = HEADER_TO_FIELD[normalizeHeader(header)];
		if (field && columnIndexByField[field] === undefined) columnIndexByField[field] = columnIndex;   // first matching column wins
	});

	if (columnIndexByField.company === undefined) {
		throw new CsvImportError('The CSV needs a "Company" column.');
	}
	const cell = (row: string[], field: Field) => {
		const columnIndex = columnIndexByField[field];
		return columnIndex === undefined ? '' : (row[columnIndex] ?? '').trim();
	};

	const apps: ParsedApplication[] = rows.slice(1).map((row, rowIndex) => {
		const company = cell(row, 'company');
		if (!company) {
			throw new CsvImportError(`Row ${rowIndex + 2} is missing a company — nothing was imported.`);
		}
		let status = STATUS_BY_LABEL.get(cell(row, 'status').toLowerCase()) ?? 'applied';
		// Interview/offer always imply the app reached an interview; an explicit "Yes" covers the
		// rejected-after-interview case too.
		const reached = cell(row, 'reached_interview').toLowerCase() === 'yes' || status === 'interview' || status === 'offer';
		// …and the inverse: a row that reached an interview can't still be merely "applied" (you'd be
		// at interview/offer/rejected by then), so promote that contradiction to "interview".
		if (reached && status === 'applied') status = 'interview';
		const rawId = cell(row, 'id');
		return {
			// The exported application id — only a well-formed SQLite id (a positive integer) counts as
			// one; anything else (blank, text, a foreign format) is treated as no id, so the row falls
			// through to email / company+role matching instead.
			id: APPLICATION_ID_RE.test(rawId) ? rawId : null,
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
			// A message id repeated anywhere in the file — same cell or across rows — is a file error
			// caught by assertUniqueIds below, never silently collapsed.
			account: cell(row, 'account') || null,
			emails: parseEmails(cell(row, 'emails')),
		};
	});
	assertUniqueIds(apps);
	return { apps, fields: new Set(Object.keys(columnIndexByField) as Field[]) };
}

// A well-formed SQLite application id: positive integer, no leading zero.
const APPLICATION_ID_RE = /^[1-9]\d*$/;

/**
 * Reject the whole file when an application id or an email message id appears more than once — each is
 * the identity of exactly one thing, so a repeat makes the file ambiguous. The user resolves it in the
 * spreadsheet rather than the import guessing. Blank ids are exempt: they just mean "no id".
 */
function assertUniqueIds(apps: ParsedApplication[]): void {
	const rowIndexesByApplicationId = new Map<string, number[]>();
	const rowIndexesByMessageId = new Map<string, number[]>();
	apps.forEach((app, index) => {
		if (app.id) rowIndexesByApplicationId.set(app.id, [...(rowIndexesByApplicationId.get(app.id) ?? []), index]);
		for (const email of app.emails) {
			rowIndexesByMessageId.set(email.messageId, [...(rowIndexesByMessageId.get(email.messageId) ?? []), index]);
		}
	});
	// "rows 62 and 76 (Distyl, Distyl AI)" — 1-based data rows counted from under the header.
	const describeRows = (indexes: number[]) =>
		`rows ${indexes.map(index => index + 2).join(', ')} (${indexes.map(index => apps[index].company).join(', ')})`;
	const problems: string[] = [];
	for (const [applicationId, indexes] of rowIndexesByApplicationId) {
		if (indexes.length > 1) problems.push(`Application id ${applicationId} appears in ${describeRows(indexes)} — remove it from all but one row.`);
	}
	for (const [messageId, indexes] of rowIndexesByMessageId) {
		if (indexes.length < 2) continue;
		// Every hit in ONE row means that row's Emails cell lists the message twice — usually with a
		// different stage/date, so keeping either one would be the import picking a status for the user.
		// Hits across rows mean two applications claim the same email. Both are the human's call.
		const isRepeatedInOneCell = indexes.every(index => index === indexes[0]);
		problems.push(isRepeatedInOneCell
			? `Email ${messageId} is listed ${indexes.length} times in row ${indexes[0] + 2} (${apps[indexes[0]].company}) — remove the extra copies.`
			: `Email ${messageId} appears in ${describeRows(indexes)} — remove it from all but one row.`);
	}
	if (problems.length > 0) throw new CsvImportError(problems.join('\n'));
}

// Fields a re-import may write back to a matched application — the intersection of what the CSV
// carries and what PATCH /applications/:id accepts. `company_domain` and `source` are create-only:
// the server ignores them on PATCH (and an existing gmail-sourced app should stay 'gmail').
const PATCHABLE_FIELDS: Exclude<Field, 'id'>[] = ['company', 'role', 'status', 'interview_step', 'reached_interview', 'date_applied', 'last_activity', 'job_url', 'notes', 'external_id', 'account', 'emails'];

// The CSV-editable fields of `existing` that `parsed` would change, limited to columns actually
// present in the file. Empty object → the row is identical to what's on the board.
function diffApplication(existing: Application, parsed: NewApplication, fields: Set<Field>): Partial<Application> {
	const changes: Partial<Application> = {};
	for (const field of PATCHABLE_FIELDS) {
		if (!fields.has(field)) continue;
		if (field === 'emails') {
			if (serializeEmails(parsed.emails) !== serializeEmails(existing.emails)) changes.emails = parsed.emails;
		} else if (parsed[field] !== (existing[field] ?? null)) {   // optional server fields may be undefined — treat as null
			(changes as Record<string, unknown>)[field] = parsed[field];
		}
	}
	return changes;
}

// ── Import plan (docs/csv-reimport-spec.md) ─────────────────────────────────
// The file is the source of truth: each row resolves to exactly one mutation, every claimed email
// moves to its claiming row's application, and the whole plan is applied server-side in one
// transaction. No writes happen during planning.

/** One existing application the plan edits in place. */
export interface PlannedUpdate {
	id: string;
	company: string;   // current board values — shown in the confirm modal
	role: string;
	changes: Partial<Application>;
	// A free file id to move this application onto (email-match convergence): after adoption the
	// next re-import of the same file matches this row by id directly.
	adoptId: string | null;
	// An id match where neither the company nor any tracked email agrees with the target — the
	// signature of a file exported from a DIFFERENT database whose id landed on an unrelated app.
	suspicious: boolean;
}

/** One brand-new application the plan creates. */
export interface PlannedCreate {
	fields: NewApplication;
	// The file's id, kept on creation when no board application uses it — a re-import of the same
	// file then matches the created application by id instead of duplicating it.
	preservedId: string | null;
	// This row's match target was already claimed by an earlier row, so it fell through to CREATE.
	// Correct only alongside the updates (the claimed target's own row sheds the shared emails), so
	// the add-only path must exclude it.
	conflictFallback: boolean;
}

/** One email leaving an application no row matched, for the confirm modal and the server's strips. */
export interface PlannedEmailMove {
	messageId: string;
	fromId: string;
	fromCompany: string;
	toCompany: string;
}

/** An application merged away: every email it held moved to a claiming row, leaving it empty. */
export interface PlannedDelete {
	id: string;
	company: string;
	role: string;
}

export interface ImportPlan {
	creates: PlannedCreate[];
	updates: PlannedUpdate[];
	// Emails stripped off applications no row matched. (Matched applications shed claimed emails
	// through their own row's email-list replacement — pre-validation guarantees no other row still
	// lists them — so they never need an explicit strip.)
	moves: PlannedEmailMove[];
	deletes: PlannedDelete[];
	// Every email ref in the file — marked synced server-side so the next Gmail sync skips them all.
	syncEmails: EmailRef[];
	skipped: number;   // rows identical to their matched application (no-ops)
}

/**
 * Resolve the parsed file against the board into a mutation plan. One signal per row, strongest first:
 *   1. The exported application id — an id on the board is that application, full stop. (A foreign
 *      file whose id collides with an unrelated local app is flagged `suspicious` for the modal.)
 *   2. The tracked Gmail message ids — the row updates the PRIMARY HOLDER (the application holding
 *      the most of its emails; tie → oldest), and every other holder is stripped of them. If the row
 *      carries a free foreign id, the holder adopts it so the row converges to rule 1 next time.
 *   3. Company+role, only for rows with neither id nor emails (1.0.0 exports, hand-made CSVs), and
 *      only when unambiguous on BOTH sides — one candidate on the board, one such row in the file.
 *   4. Nothing matched → CREATE, keeping the file's id when it's free.
 *
 * `existing` should be the COMPLETE board (fetched fresh and unfiltered), since an active search filter
 * narrows the in-memory list and would let already-present applications slip back in as "new".
 */
export function buildImportPlan(parsed: ParsedCsv, existing: Application[]): ImportPlan {
	const companyRoleKey = (company: string, role: string) => `${company.trim().toLowerCase()}|||${role.trim().toLowerCase()}`;
	const existingById = new Map(existing.map(app => [app.id, app]));
	// EVERY holder per message id — legacy data can have one email on several applications, and the
	// claiming row must strip them all.
	const holdersByMessageId = new Map<string, Application[]>();
	existing.forEach(app => app.emails.forEach(email =>
		holdersByMessageId.set(email.messageId, [...(holdersByMessageId.get(email.messageId) ?? []), app]),
	));
	const boardByCompanyRole = new Map<string, Application[]>();
	existing.forEach(app => {
		const appKey = companyRoleKey(app.company, app.role);
		boardByCompanyRole.set(appKey, [...(boardByCompanyRole.get(appKey) ?? []), app]);
	});
	// File-side ambiguity for the company+role fallback: how many id-less, email-less rows share each key.
	const fallbackRowCountByKey = new Map<string, number>();
	for (const parsedRow of parsed.apps) {
		if (parsedRow.id || parsedRow.emails.length > 0) continue;
		const rowKey = companyRoleKey(parsedRow.company, parsedRow.role);
		fallbackRowCountByKey.set(rowKey, (fallbackRowCountByKey.get(rowKey) ?? 0) + 1);
	}

	const takenIds = new Set(existing.map(app => app.id));   // board ids + ids this plan reserves
	const claimedTargetIds = new Set<string>();              // board apps already matched by a row
	// Per-holder removal bookkeeping, finalized after all rows resolve (a later row may match a holder).
	const removalsByHolderId = new Map<string, { holder: Application; removedMessageIds: Set<string>; moves: PlannedEmailMove[] }>();

	const creates: PlannedCreate[] = [];
	const updates: PlannedUpdate[] = [];
	let skipped = 0;

	for (const parsedRow of parsed.apps) {
		// Split the match key off the importable fields — the id is identity, never data.
		const { id: fileId, ...rowFields } = parsedRow;
		let target: Application | undefined;
		let adoptId: string | null = null;
		let suspicious = false;

		if (fileId && existingById.has(fileId)) {
			// Rule 1 — id match. Flag it when the row actively contradicts the target: a different
			// company AND tracked emails none of which the target holds — the signature of a foreign
			// file's id collision. An email-less row can't contradict, so a plain company correction
			// (the common spreadsheet fix) is never flagged.
			target = existingById.get(fileId)!;
			const sharesAnEmail = rowFields.emails.some(email => target!.emails.some(heldEmail => heldEmail.messageId === email.messageId));
			suspicious = rowFields.emails.length > 0 && !sharesAnEmail
				&& rowFields.company.trim().toLowerCase() !== target.company.trim().toLowerCase();
		} else if (rowFields.emails.length > 0) {
			// Rule 2 — primary holder: most of the row's emails, tie → oldest (smallest id).
			const heldEmailCountByApplicationId = new Map<string, number>();
			for (const email of rowFields.emails) {
				for (const holder of holdersByMessageId.get(email.messageId) ?? []) {
					heldEmailCountByApplicationId.set(holder.id, (heldEmailCountByApplicationId.get(holder.id) ?? 0) + 1);
				}
			}
			if (heldEmailCountByApplicationId.size > 0) {
				const [primaryHolderId] = [...heldEmailCountByApplicationId.entries()]
					.sort(([applicationIdA, heldCountA], [applicationIdB, heldCountB]) => heldCountB - heldCountA || Number(applicationIdA) - Number(applicationIdB))[0];
				target = existingById.get(primaryHolderId);
				if (fileId && !takenIds.has(fileId)) adoptId = fileId;
			}
		} else if (!fileId) {
			// Rule 3 — company+role fallback, only when unambiguous on both sides.
			const rowKey = companyRoleKey(rowFields.company, rowFields.role);
			const candidates = boardByCompanyRole.get(rowKey) ?? [];
			if (candidates.length === 1 && fallbackRowCountByKey.get(rowKey) === 1) target = candidates[0];
		}

		// A target claimed by an earlier row can't be claimed twice — this row falls through to CREATE.
		const conflictFallback = target !== undefined && claimedTargetIds.has(target.id);
		if (conflictFallback) target = undefined;

		if (target) {
			claimedTargetIds.add(target.id);
			if (adoptId) takenIds.add(adoptId);
			const changes = diffApplication(target, rowFields, parsed.fields);
			if (Object.keys(changes).length === 0 && !adoptId) skipped++;
			else updates.push({ id: target.id, company: target.company, role: target.role, changes, adoptId, suspicious });
		} else {
			// Rule 4 — CREATE, keeping the file's id when free.
			const preservedId = fileId && !takenIds.has(fileId) ? fileId : null;
			if (preservedId) takenIds.add(preservedId);
			creates.push({ fields: rowFields, preservedId, conflictFallback });
		}

		// Email uniqueness: every board application other than this row's target loses the row's emails.
		for (const email of rowFields.emails) {
			for (const holder of holdersByMessageId.get(email.messageId) ?? []) {
				if (holder.id === target?.id) continue;
				const removal = removalsByHolderId.get(holder.id) ?? { holder, removedMessageIds: new Set<string>(), moves: [] };
				removal.removedMessageIds.add(email.messageId);
				removal.moves.push({ messageId: email.messageId, fromId: holder.id, fromCompany: holder.company, toCompany: rowFields.company });
				removalsByHolderId.set(holder.id, removal);
			}
		}
	}

	// Finalize strips and deletions now that every row has resolved. Holders matched by a row need no
	// explicit strip — their own row's email replacement excludes the claimed ids (pre-validation
	// guarantees no two rows list the same email). Deletion guard: only an UNMATCHED holder that HAD
	// emails and would end up with none is merged away; an already-email-less app is never deleted.
	const moves: PlannedEmailMove[] = [];
	const deletes: PlannedDelete[] = [];
	for (const { holder, removedMessageIds, moves: holderMoves } of removalsByHolderId.values()) {
		if (claimedTargetIds.has(holder.id)) continue;
		moves.push(...holderMoves);
		const remainingEmails = holder.emails.filter(email => !removedMessageIds.has(email.messageId));
		if (remainingEmails.length === 0 && holder.emails.length > 0) {
			deletes.push({ id: holder.id, company: holder.company, role: holder.role });
		}
	}

	// Every email id in the file, for the synced-email skip list (ids are file-unique after validation).
	const syncEmails = parsed.apps.flatMap(parsedRow => parsedRow.emails);

	return { creates, updates, moves, deletes, syncEmails, skipped };
}
