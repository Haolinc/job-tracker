import type { Application } from '../types';
import { STATUS_LABELS, STEP_LABELS } from '../constants';
import { serializeEmails } from './emailRefs';
import { todayLocalDateTime } from './localDate';

// RFC-4180 escaping: quote a cell if it contains a comma, quote, or newline; double any inner quotes.
function csvCell(value: unknown): string {
	const text = value == null ? '' : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const COLUMNS: { header: string; value: (app: Application) => string }[] = [
	// The application's own id — lets a re-import on the same machine find the exact row even when
	// company, role, and emails were all edited. Machine-local: on another install it can name an
	// unrelated application, so re-import confirms before overwriting anything it matched.
	{ header: 'ID',                value: app => app.id },
	{ header: 'Company',           value: app => app.company },
	{ header: 'Role',              value: app => app.role },
	{ header: 'Status',            value: app => STATUS_LABELS[app.status] ?? app.status },
	{ header: 'Stage',             value: app => (app.interview_step ? STEP_LABELS[app.interview_step] : '') },
	{ header: 'Reached Interview', value: app => (app.reached_interview ? 'Yes' : 'No') },
	{ header: 'Date Applied',      value: app => app.date_applied ?? '' },
	{ header: 'Last Response',     value: app => app.last_activity ?? '' },
	{ header: 'Job URL',           value: app => app.job_url ?? '' },
	{ header: 'Notes',             value: app => app.notes ?? '' },
	{ header: 'Source',            value: app => app.source },
	// Technical dedup keys — kept so a re-imported export still merges cleanly on the next Gmail sync
	// (employer domain = the company key; req/job id = the within-company posting key).
	{ header: 'Company Domain',    value: app => app.company_domain ?? '' },
	{ header: 'Job ID',            value: app => app.external_id ?? '' },
	// Email-link data: the application's Gmail account and the tracked messages (category|id|date; …),
	// so the "open in Gmail" links survive an export/import round-trip.
	{ header: 'Gmail Account',     value: app => app.account ?? '' },
	{ header: 'Emails',            value: app => serializeEmails(app.emails) },
];

/** Build a CSV (with header row) from a list of applications. */
export function applicationsToCsv(apps: Application[]): string {
	const headerRow = COLUMNS.map(column => csvCell(column.header)).join(',');
	const dataRows = apps.map(app => COLUMNS.map(column => csvCell(column.value(app))).join(','));
	return [headerRow, ...dataRows].join('\r\n');
}

/** Trigger a browser download of the applications as a CSV file. */
export function downloadApplicationsCsv(apps: Application[]): void {
	// Prepend a UTF-8 BOM so spreadsheet apps read accented company names correctly in many languages.
	const csvBlob = new Blob(['﻿' + applicationsToCsv(apps)], { type: 'text/csv;charset=utf-8;' });
	const blobUrl = URL.createObjectURL(csvBlob);
	const downloadLink = document.createElement('a');
	downloadLink.href = blobUrl;
	downloadLink.download = `job-applications-${todayLocalDateTime()}.csv`;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	downloadLink.remove();
	URL.revokeObjectURL(blobUrl);
}
