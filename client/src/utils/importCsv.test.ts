import { describe, it, expect } from 'vitest';
import { parseApplicationsCsv } from './importCsv';

// Parser-level tests for the spreadsheet-tolerance paths — the ones a clean app export never exercises,
// because the export always emits canonical headers and ISO dates. These feed the messy shapes a user's
// Excel round-trip actually produces.
describe('parseApplicationsCsv — date coercion', () => {
	const dateOf = (cell: string) => parseApplicationsCsv(`Company,Date Applied\r\nAcme,${cell}`).apps[0].date_applied;

	it('should coerce an Excel month-first date (M/d/yyyy) back to ISO', () => {
		expect(dateOf('5/1/2026')).toBe('2026-05-01');
	});

	it('should read a date as day-first when the first field exceeds 12', () => {
		expect(dateOf('13/2/2026')).toBe('2026-02-13');
	});

	it('should parse a written-out date via the Date fallback', () => {
		expect(dateOf('"May 1, 2026"')).toBe('2026-05-01');   // quoted: the comma is part of the value
	});

	it('should return null for a blank or unparseable date cell', () => {
		expect(dateOf('')).toBeNull();
		expect(dateOf('not a date')).toBeNull();
	});
});

describe('parseApplicationsCsv — header normalization', () => {
	it('should match headers regardless of case, underscores/hyphens, and column order', () => {
		const csv = 'date-applied,COMPANY,Job_URL,role\r\n2026-01-02,Acme,https://x.test,SWE';
		const [app] = parseApplicationsCsv(csv).apps;
		expect(app).toMatchObject({ company: 'Acme', role: 'SWE', date_applied: '2026-01-02', job_url: 'https://x.test' });
	});
});

describe('parseApplicationsCsv — RFC-4180 quoting', () => {
	it('should honour commas, escaped quotes, and newlines inside a quoted cell', () => {
		const csv = 'Company,Notes\r\n"Acme, Inc.","He said ""hi""\nsee you"';
		const [app] = parseApplicationsCsv(csv).apps;
		expect(app.company).toBe('Acme, Inc.');
		expect(app.notes).toBe('He said "hi"\nsee you');
	});
});

describe('parseApplicationsCsv — status, defaults, and empties', () => {
	const parseOne = (csv: string) => parseApplicationsCsv(csv).apps[0];

	it('should accept a human status label or the raw value, defaulting the unknown to applied', () => {
		expect(parseOne('Company,Role,Status\r\nAcme,SWE,Offer').status).toBe('offer');
		expect(parseOne('Company,Role,Status\r\nAcme,SWE,offer').status).toBe('offer');
		expect(parseOne('Company,Role,Status\r\nAcme,SWE,Bogus').status).toBe('applied');
	});

	it('should promote a reached-interview row that is still marked applied', () => {
		const app = parseOne('Company,Role,Status,Reached Interview\r\nAcme,SWE,Applied,Yes');
		expect(app.status).toBe('interview');
		expect(app.reached_interview).toBe(true);
	});

	it('should default a blank role to "Unknown Role"', () => {
		expect(parseOne('Company,Role\r\nAcme,').role).toBe('Unknown Role');
	});

	it('should return no applications for a header-only file', () => {
		const parsed = parseApplicationsCsv('Company,Role');
		expect(parsed.apps).toEqual([]);
		expect(parsed.fields.size).toBe(0);
	});
});
