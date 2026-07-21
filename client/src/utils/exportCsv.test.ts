import { describe, it, expect } from 'vitest';
import { applicationsToCsv } from './exportCsv';
import { makeApp } from '../test-utils';
import type { EmailRef } from '../types';

// Direct tests for the export side. The round-trip suite proves export+import agree; these pin the
// exact wire shape a spreadsheet (or another tool) sees, independent of the parser.
describe('applicationsToCsv', () => {
	it('should lead every row with the ID column, using CRLF line endings', () => {
		const csv = applicationsToCsv([makeApp({ id: '4374', company: 'Acme', role: 'SWE' })]);
		const [header, firstRow] = csv.split('\r\n');
		expect(header.startsWith('ID,Company,Role,')).toBe(true);
		expect(firstRow.startsWith('4374,Acme,SWE,')).toBe(true);
	});

	it('should RFC-4180 escape cells containing commas, quotes, or newlines', () => {
		const csv = applicationsToCsv([makeApp({ company: 'Acme, Inc.', notes: 'He said "hi"\nbye' })]);
		expect(csv).toContain('"Acme, Inc."');        // comma → quoted
		expect(csv).toContain('"He said ""hi""\nbye"'); // inner quotes doubled, newline kept inside quotes
	});

	it('should render human labels for status/stage and Yes/No for reached_interview', () => {
		const csv = applicationsToCsv([makeApp({ status: 'interview', interview_step: 'onsite', reached_interview: true })]);
		const cells = csv.split('\r\n')[1].split(',');
		expect(cells).toEqual(expect.arrayContaining(['Interview', 'Onsite', 'Yes']));
	});

	it('should emit blank cells (not "null") for absent optional fields', () => {
		const csv = applicationsToCsv([makeApp({ date_applied: null, job_url: null, notes: null, account: null, emails: [] })]);
		expect(csv).not.toContain('null');
	});

	it('should serialize tracked emails so they survive a round-trip', () => {
		const emails: EmailRef[] = [{ messageId: 'm-1', category: 'applied', date: '2026-02-01' }];
		const csv = applicationsToCsv([makeApp({ emails })]);
		expect(csv).toContain('applied|m-1|2026-02-01');
	});

	it('should output only a header row for an empty list', () => {
		const csv = applicationsToCsv([]);
		expect(csv.split('\r\n')).toHaveLength(1);
		expect(csv).toMatch(/^ID,Company,Role,/);
	});
});
