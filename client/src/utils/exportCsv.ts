import type { Application } from '../types';
import { STATUS_LABELS, STEP_LABELS } from '../constants';

// RFC-4180 escaping: quote a cell if it contains a comma, quote, or newline; double any inner quotes.
function csvCell(value: unknown): string {
	const s = value == null ? '' : String(value);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS: { header: string; value: (a: Application) => string }[] = [
	{ header: 'Company',           value: a => a.company },
	{ header: 'Role',              value: a => a.role },
	{ header: 'Status',            value: a => STATUS_LABELS[a.status] ?? a.status },
	{ header: 'Stage',             value: a => (a.interview_step ? STEP_LABELS[a.interview_step] : '') },
	{ header: 'Reached Interview', value: a => (a.reached_interview ? 'Yes' : 'No') },
	{ header: 'Date Applied',      value: a => a.date_applied ?? '' },
	{ header: 'Last Response',     value: a => a.last_activity ?? '' },
	{ header: 'Job URL',           value: a => a.job_url ?? '' },
	{ header: 'Notes',             value: a => a.notes ?? '' },
	{ header: 'Source',            value: a => a.source },
];

/** Build a CSV (with header row) from a list of applications. */
export function applicationsToCsv(apps: Application[]): string {
	const head = COLUMNS.map(c => csvCell(c.header)).join(',');
	const rows = apps.map(a => COLUMNS.map(c => csvCell(c.value(a))).join(','));
	return [head, ...rows].join('\r\n');
}

/** Trigger a browser download of the applications as a CSV file. */
export function downloadApplicationsCsv(apps: Application[]): void {
	// Prepend a UTF-8 BOM so spreadsheet apps read accented company names correctly in many languages.
	const blob = new Blob(['﻿' + applicationsToCsv(apps)], { type: 'text/csv;charset=utf-8;' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `job-applications-${new Date().toISOString().slice(0, 10)}.csv`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
