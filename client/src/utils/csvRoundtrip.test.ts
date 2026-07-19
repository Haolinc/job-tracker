import { describe, it, expect } from 'vitest';
import { applicationsToCsv } from './exportCsv';
import { parseApplicationsCsv, reconcileApplications } from './importCsv';
import { makeApp } from '../test-utils';
import type { EmailRef } from '../types';

const emails: EmailRef[] = [
	{ messageId: 'm-app', category: 'applied',   date: '2026-02-01' },
	{ messageId: 'm-int', category: 'interview', date: '2026-03-10' },
];

describe('CSV export → import round-trip', () => {
	it('should preserve the Gmail account and tracked emails across an export/import', () => {
		const app = makeApp({ company: 'CVS Health', role: 'SWE', account: 'me@work.com', emails });
		const [imported] = parseApplicationsCsv(applicationsToCsv([app])).apps;
		expect(imported.account).toBe('me@work.com');
		expect(imported.emails).toEqual(emails);
	});

	it('should default account to null and emails to [] when those columns are blank', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', account: null, emails: [] });
		const [imported] = parseApplicationsCsv(applicationsToCsv([app])).apps;
		expect(imported.account).toBeNull();
		expect(imported.emails).toEqual([]);
	});
});

describe('CSV export → edit → re-import reconciliation', () => {
	it('should report an unedited export as fully unchanged (no adds, no updates)', () => {
		const apps = [makeApp({ emails }), makeApp({ company: 'Beta Corp', role: 'Backend Dev' })];
		const { toAdd, toUpdate, skipped } = reconcileApplications(parseApplicationsCsv(applicationsToCsv(apps)), apps);
		expect(toAdd).toEqual([]);
		expect(toUpdate).toEqual([]);
		expect(skipped).toBe(2);
	});

	it('should update the existing application when a company name is corrected on a row with tracked emails', () => {
		const app = makeApp({ company: 'Acme Inc', role: 'SWE', emails });
		const csv = applicationsToCsv([app]).replace('Acme Inc', 'Acme Corp');
		const { toAdd, toUpdate, skipped } = reconcileApplications(parseApplicationsCsv(csv), [app]);
		expect(toAdd).toEqual([]);
		expect(skipped).toBe(0);
		expect(toUpdate).toEqual([{ id: app.id, changes: { company: 'Acme Corp' } }]);
	});

	it('should match by the exported id even when company AND role were both edited on an email-less row', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', emails: [] });
		const csv = applicationsToCsv([app]).replace('Acme,SWE', 'Acme Corp,Senior SWE');
		const { toAdd, toUpdate } = reconcileApplications(parseApplicationsCsv(csv), [app]);
		expect(toAdd).toEqual([]);
		expect(toUpdate).toEqual([{ id: app.id, changes: { company: 'Acme Corp', role: 'Senior SWE' } }]);
	});

	it('should match an email-less row by company+role when the CSV has no ID column', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', notes: 'old note', emails: [] });
		const csv = 'Company,Role,Notes\r\nAcme,SWE,new note';
		const { toUpdate } = reconcileApplications(parseApplicationsCsv(csv), [app]);
		expect(toUpdate).toEqual([{ id: app.id, changes: { notes: 'new note' } }]);
	});

	it('should add a row whose exported id is unknown to this machine, without carrying the foreign id', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', emails });
		// Same export, imported on a machine whose board doesn't have this id (or these emails).
		const { toAdd, toUpdate } = reconcileApplications(parseApplicationsCsv(applicationsToCsv([app])), []);
		expect(toUpdate).toEqual([]);
		expect(toAdd.map(a => a.company)).toEqual(['Acme']);
		expect(toAdd[0]).not.toHaveProperty('id');   // the other machine's id must not reach the server
	});

	it('should trust a matching id even when the tracked emails differ (edits win; the UI confirms first)', () => {
		const local = makeApp({ company: 'Local Co', role: 'PM', emails: [{ messageId: 'm-local', category: 'applied', date: '2026-01-05' }] });
		const synced = makeApp({ company: 'Acme', role: 'SWE', emails });
		// A row carrying `local`'s id but `synced`'s content: the id wins and `local` gets the row's
		// values — the ImportConfirmModal is what stands between this and an accidental overwrite.
		const csv = applicationsToCsv([{ ...synced, id: local.id }]);
		const { toAdd, toUpdate, skipped } = reconcileApplications(parseApplicationsCsv(csv), [local, synced]);
		expect(toAdd).toEqual([]);
		expect(skipped).toBe(0);
		expect(toUpdate).toHaveLength(1);
		expect(toUpdate[0].id).toBe(local.id);
		expect(toUpdate[0].changes).toMatchObject({ company: 'Acme', role: 'SWE' });
		expect(toUpdate[0].changes.emails).toEqual(emails);
	});

	it('should still add rows that are not on the board', () => {
		const onBoard = makeApp({ company: 'Acme', role: 'SWE' });
		const notOnBoard = makeApp({ company: 'NewCo', role: 'Data Engineer' });
		const { toAdd, toUpdate, skipped } = reconcileApplications(
			parseApplicationsCsv(applicationsToCsv([onBoard, notOnBoard])),
			[onBoard],
		);
		expect(toAdd.map(a => a.company)).toEqual(['NewCo']);
		expect(toUpdate).toEqual([]);
		expect(skipped).toBe(1);
	});

	it('should not touch fields whose columns are absent from a partial hand-made CSV', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', status: 'offer', notes: 'keep me', date_applied: '2026-01-01' });
		// Only Company/Role/Status columns: status is edited, notes and dates must survive untouched.
		const csv = 'Company,Role,Status\r\nAcme,SWE,Rejected';
		const { toUpdate } = reconcileApplications(parseApplicationsCsv(csv), [app]);
		expect(toUpdate).toEqual([{ id: app.id, changes: { status: 'rejected' } }]);
	});

	it('should collapse an in-file duplicate row onto the first occurrence', () => {
		const app = makeApp({ company: 'Acme Inc', role: 'SWE', emails });
		const rows = applicationsToCsv([app, app]).replace('Acme Inc', 'Acme Corp');   // first row edited, second left as-is
		const { toAdd, toUpdate, skipped } = reconcileApplications(parseApplicationsCsv(rows), [app]);
		expect(toAdd).toEqual([]);
		expect(toUpdate).toEqual([{ id: app.id, changes: { company: 'Acme Corp' } }]);
		expect(skipped).toBe(1);
	});
});
