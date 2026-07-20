import { describe, it, expect } from 'vitest';
import { applicationsToCsv } from './exportCsv';
import { parseApplicationsCsv, buildImportPlan, CsvImportError } from './importCsv';
import { makeApp } from '../test-utils';
import type { Application, EmailRef } from '../types';

const emails: EmailRef[] = [
	{ messageId: 'm-app', category: 'applied',   date: '2026-02-01' },
	{ messageId: 'm-int', category: 'interview', date: '2026-03-10' },
];

// Export → parse → plan against a board, in one step — most tests exercise exactly this pipeline.
const planFor = (csvApps: Application[], board: Application[]) =>
	buildImportPlan(parseApplicationsCsv(applicationsToCsv(csvApps)), board);

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

	it('should treat a malformed id cell (text, zero, negative, decimal) as no id', () => {
		const csv = 'ID,Company,Role\r\nabc,Acme,SWE\r\n0,Beta,PM\r\n-3,Gamma,DS\r\n1.5,Delta,QA';
		const { apps } = parseApplicationsCsv(csv);
		expect(apps.map(app => app.id)).toEqual([null, null, null, null]);
	});

	it('should reject a duplicate message id inside one Emails cell, naming the row', () => {
		// The two entries disagree on stage AND date — keeping either would be the import picking a
		// status for the user, so the file is rejected instead.
		const csv = 'Company,Role,Emails\r\nAcme,SWE,applied|m-dup|2026-01-01 ; rejected|m-dup|2026-02-01';
		expect(() => parseApplicationsCsv(csv)).toThrow(CsvImportError);
		expect(() => parseApplicationsCsv(csv)).toThrow(/m-dup is listed 2 times in row 2 \(Acme\)/);
	});
});

describe('CSV pre-validation (file rejection)', () => {
	it('should reject a file where an application id appears in more than one row', () => {
		const app = makeApp({ id: '7', company: 'Acme', role: 'SWE' });
		const csv = applicationsToCsv([app, { ...app, company: 'Acme Corp' }]);
		expect(() => parseApplicationsCsv(csv)).toThrow(CsvImportError);
		expect(() => parseApplicationsCsv(csv)).toThrow(/Application id 7 appears in rows 2, 3 \(Acme, Acme Corp\)/);
	});

	it('should reject a file where an email id appears in more than one row (legacy shared-email export)', () => {
		// The original Distyl case: one rejection email tracked by two applications. The user decides in
		// the spreadsheet which application keeps it — the import never guesses.
		const sharedRejection: EmailRef = { messageId: 'm-shared-rej', category: 'rejected', date: '2026-06-30' };
		const distyl = makeApp({ company: 'Distyl', role: 'SWE', emails: [sharedRejection] });
		const distylAi = makeApp({ company: 'Distyl AI', role: 'SWE', emails: [{ messageId: 'm-ai-applied', category: 'applied', date: '2026-06-28' }, sharedRejection] });
		expect(() => parseApplicationsCsv(applicationsToCsv([distyl, distylAi])))
			.toThrow(/Email m-shared-rej appears in rows 2, 3 \(Distyl, Distyl AI\)/);
	});

	it('should list every duplicate problem in one rejection, not just the first', () => {
		const first = makeApp({ id: '11', company: 'Acme', role: 'SWE' });
		const shared: EmailRef = { messageId: 'm-x', category: 'applied', date: '2026-01-01' };
		const second = makeApp({ id: '12', company: 'Beta', role: 'PM', emails: [shared] });
		const third = makeApp({ id: '13', company: 'Gamma', role: 'DS', emails: [shared] });
		const csv = applicationsToCsv([first, { ...first, company: 'Acme 2' }, second, third]);
		let message = '';
		try { parseApplicationsCsv(csv); } catch (error) { message = (error as Error).message; }
		expect(message).toMatch(/Application id 11/);
		expect(message).toMatch(/Email m-x/);
	});
});

describe('import plan — matching rules', () => {
	it('should report an unedited export as a complete no-op', () => {
		const board = [makeApp({ emails }), makeApp({ company: 'Beta Corp', role: 'Backend Dev' })];
		const plan = planFor(board, board);
		expect(plan.creates).toEqual([]);
		expect(plan.updates).toEqual([]);
		expect(plan.moves).toEqual([]);
		expect(plan.deletes).toEqual([]);
		expect(plan.skipped).toBe(2);
	});

	it('rule 1: should match by id even when company AND role were both edited on an email-less row', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', emails: [] });
		const plan = buildImportPlan(parseApplicationsCsv(applicationsToCsv([app]).replace('Acme,SWE', 'Acme Corp,Senior SWE')), [app]);
		expect(plan.creates).toEqual([]);
		expect(plan.updates).toHaveLength(1);
		expect(plan.updates[0].id).toBe(app.id);
		expect(plan.updates[0].changes).toEqual({ company: 'Acme Corp', role: 'Senior SWE' });
		expect(plan.updates[0].suspicious).toBe(false);   // an email-less row can't contradict its target's emails
	});

	it('rule 1: should trust a matching id over differing emails, but flag it suspicious when nothing else agrees', () => {
		const local = makeApp({ company: 'Local Co', role: 'PM', emails: [{ messageId: 'm-local', category: 'applied', date: '2026-01-05' }] });
		// A row carrying `local`'s id but a foreign file's content: the id wins, the modal warns.
		const foreignRow = makeApp({ company: 'Acme', role: 'SWE', emails });
		const plan = planFor([{ ...foreignRow, id: local.id }], [local]);
		expect(plan.updates).toHaveLength(1);
		expect(plan.updates[0].id).toBe(local.id);
		expect(plan.updates[0].changes).toMatchObject({ company: 'Acme', role: 'SWE' });
		expect(plan.updates[0].changes.emails).toEqual(emails);
		expect(plan.updates[0].suspicious).toBe(true);
	});

	it('rule 1: should not flag an id match as suspicious when the company still agrees', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', emails });
		// User replaced the tracked emails but kept the company — a normal edit, not a foreign file.
		const edited = { ...app, emails: [{ messageId: 'm-new', category: 'applied', date: '2026-04-01' } as EmailRef] };
		const plan = planFor([edited], [app]);
		expect(plan.updates[0].suspicious).toBe(false);
	});

	it('rule 2: should update the holder of the row emails when the id is foreign, adopting the free file id', () => {
		const holder = makeApp({ company: 'Acme', role: 'SWE', emails });
		// Same application exported from an older database under id 4210 — the emails find it anyway.
		const plan = planFor([{ ...holder, id: '4210' }], [holder]);
		expect(plan.creates).toEqual([]);
		expect(plan.updates).toHaveLength(1);
		expect(plan.updates[0].id).toBe(holder.id);
		expect(plan.updates[0].adoptId).toBe('4210');   // next re-import of this file matches by id
		expect(plan.updates[0].changes).toEqual({});    // nothing else differs — adoption is the only work
	});

	it('rule 2: should match by emails with no ID column at all (1.0.0 export) and update the holder', () => {
		const holder = makeApp({ company: 'Acme Inc', role: 'SWE', emails });
		const csv = 'Company,Role,Emails\r\nAcme Corp,SWE,applied|m-app|2026-02-01 ; interview|m-int|2026-03-10';
		const plan = buildImportPlan(parseApplicationsCsv(csv), [holder]);
		expect(plan.updates).toHaveLength(1);
		expect(plan.updates[0].id).toBe(holder.id);
		expect(plan.updates[0].adoptId).toBeNull();
		expect(plan.updates[0].changes).toEqual({ company: 'Acme Corp' });
	});

	it('rule 2: should pick the PRIMARY holder (most of the row emails) and strip the minority holder', () => {
		const majorityHolder = makeApp({ company: 'Acme', role: 'SWE', emails: [emails[0], emails[1]] });
		const minorityHolder = makeApp({ company: 'Acme Old', role: 'SWE', emails: [
			{ messageId: 'm-rej', category: 'rejected', date: '2026-04-01' },
			{ messageId: 'm-keep', category: 'applied', date: '2026-01-01' },
		] });
		// One row gathers m-app + m-int (majority holder) and m-rej (minority holder) — no id.
		const csv = 'Company,Role,Emails\r\nAcme,SWE,applied|m-app|2026-02-01 ; interview|m-int|2026-03-10 ; rejected|m-rej|2026-04-01';
		const plan = buildImportPlan(parseApplicationsCsv(csv), [majorityHolder, minorityHolder]);
		expect(plan.updates).toHaveLength(1);
		expect(plan.updates[0].id).toBe(majorityHolder.id);
		expect(plan.moves).toEqual([{ messageId: 'm-rej', fromId: minorityHolder.id, fromCompany: 'Acme Old', toCompany: 'Acme' }]);
		expect(plan.deletes).toEqual([]);   // the minority holder still has m-keep
	});

	it('rule 2: should break a holder tie toward the oldest application (smallest id)', () => {
		const older = makeApp({ company: 'Acme', role: 'SWE', emails: [emails[0]] });
		const newer = makeApp({ company: 'Acme', role: 'SWE 2', emails: [emails[1]] });
		const csv = 'Company,Role,Emails\r\nAcme,SWE,applied|m-app|2026-02-01 ; interview|m-int|2026-03-10';
		const plan = buildImportPlan(parseApplicationsCsv(csv), [older, newer]);
		expect(plan.updates[0].id).toBe(older.id);
	});

	it('rule 3: should match an id-less email-less row by company+role when unambiguous on both sides', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', notes: 'old note', emails: [] });
		const plan = buildImportPlan(parseApplicationsCsv('Company,Role,Notes\r\nAcme,SWE,new note'), [app]);
		expect(plan.updates).toEqual([{ id: app.id, company: 'Acme', role: 'SWE', changes: { notes: 'new note' }, adoptId: null, suspicious: false }]);
	});

	it('rule 3: should CREATE instead when the board has two candidates with the same company+role', () => {
		const first = makeApp({ company: 'Acme', role: 'SWE', emails: [] });
		const second = makeApp({ company: 'Acme', role: 'SWE', emails: [] });
		const plan = buildImportPlan(parseApplicationsCsv('Company,Role,Notes\r\nAcme,SWE,who am I'), [first, second]);
		expect(plan.updates).toEqual([]);
		expect(plan.creates).toHaveLength(1);   // ambiguous → visible duplicate, never a guessed update
	});

	it('rule 3: should CREATE both when the file has two id-less email-less rows with the same company+role', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', emails: [] });
		const plan = buildImportPlan(parseApplicationsCsv('Company,Role\r\nAcme,SWE\r\nAcme,SWE'), [app]);
		expect(plan.updates).toEqual([]);
		expect(plan.creates).toHaveLength(2);
	});

	it('rule 4: should CREATE a row whose id is unknown, preserving the file id for the next import', () => {
		const foreign = makeApp({ id: '4210', company: 'NewCo', role: 'Data Engineer', emails });
		const plan = planFor([foreign], []);
		expect(plan.updates).toEqual([]);
		expect(plan.creates).toHaveLength(1);
		expect(plan.creates[0].preservedId).toBe('4210');
		expect(plan.creates[0].conflictFallback).toBe(false);
		expect(plan.creates[0].fields).not.toHaveProperty('id');   // identity travels via preservedId, never as data
	});

	it('rule 4: should CREATE an id-less unmatched row with no preserved id', () => {
		const plan = buildImportPlan(parseApplicationsCsv('Company,Role\r\nNewCo,DS'), []);
		expect(plan.creates).toHaveLength(1);
		expect(plan.creates[0].preservedId).toBeNull();
	});

	it('should not touch fields whose columns are absent from a partial hand-made CSV', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', status: 'offer', notes: 'keep me', date_applied: '2026-01-01', emails: [] });
		const plan = buildImportPlan(parseApplicationsCsv('Company,Role,Status\r\nAcme,SWE,Rejected'), [app]);
		expect(plan.updates).toHaveLength(1);
		expect(plan.updates[0].changes).toEqual({ status: 'rejected' });
	});
});

describe('import plan — email uniqueness and merging', () => {
	it('should strip a claimed email off an unmatched holder without deleting it (other emails remain)', () => {
		const target = makeApp({ company: 'Acme', role: 'SWE', emails: [emails[0]] });
		const otherHolder = makeApp({ company: 'Beta', role: 'PM', emails: [
			{ messageId: 'm-claimed', category: 'rejected', date: '2026-05-01' },
			{ messageId: 'm-stays', category: 'applied', date: '2026-04-01' },
		] });
		// Target's row also claims m-claimed; Beta has no row in the file.
		const editedTarget = { ...target, emails: [emails[0], { messageId: 'm-claimed', category: 'rejected', date: '2026-05-01' } as EmailRef] };
		const plan = planFor([editedTarget], [target, otherHolder]);
		expect(plan.updates.map(update => update.id)).toEqual([target.id]);
		expect(plan.moves).toEqual([{ messageId: 'm-claimed', fromId: otherHolder.id, fromCompany: 'Beta', toCompany: 'Acme' }]);
		expect(plan.deletes).toEqual([]);
	});

	it('should delete an unmatched holder whose LAST email was claimed away (merged into the row)', () => {
		const target = makeApp({ company: 'Acme', role: 'SWE', emails: [emails[0]] });
		const absorbedHolder = makeApp({ company: 'Acme Dup', role: 'SWE', emails: [{ messageId: 'm-only', category: 'rejected', date: '2026-05-01' }] });
		const editedTarget = { ...target, emails: [emails[0], { messageId: 'm-only', category: 'rejected', date: '2026-05-01' } as EmailRef] };
		const plan = planFor([editedTarget], [target, absorbedHolder]);
		expect(plan.moves).toHaveLength(1);
		expect(plan.deletes).toEqual([{ id: absorbedHolder.id, company: 'Acme Dup', role: 'SWE' }]);
	});

	it('should never delete a holder that is itself matched by a row, even when stripped to empty', () => {
		const claimer = makeApp({ company: 'Acme', role: 'SWE', emails: [emails[0]] });
		const emptiedHolder = makeApp({ company: 'Beta', role: 'PM', emails: [{ messageId: 'm-moving', category: 'applied', date: '2026-03-01' }] });
		// The file: claimer's row takes m-moving; emptiedHolder's own row clears its Emails cell.
		const plan = planFor([
			{ ...claimer, emails: [emails[0], { messageId: 'm-moving', category: 'applied', date: '2026-03-01' } as EmailRef] },
			{ ...emptiedHolder, emails: [] },
		], [claimer, emptiedHolder]);
		expect(plan.deletes).toEqual([]);   // matched → protected; its email list empties via its own update
		expect(plan.moves).toEqual([]);     // no explicit strip needed — the holder's own row replaces its list
		const emptiedUpdate = plan.updates.find(update => update.id === emptiedHolder.id);
		expect(emptiedUpdate?.changes.emails).toEqual([]);
	});

	it('should send a row to CREATE as a conflict fallback when its target was claimed by an earlier row', () => {
		const target = makeApp({ company: 'Acme', role: 'SWE', emails: [emails[0]] });
		// Row 1 claims the target by id (and drops m-app from its list); row 2 has no id but its email
		// lives on the same target — the target is taken, so row 2 becomes a create.
		const plan = planFor([
			{ ...target, emails: [] },
			{ ...target, id: '', company: 'Acme Second', emails: [emails[0]] },
		], [target]);
		expect(plan.updates.map(update => update.id)).toEqual([target.id]);
		expect(plan.creates).toHaveLength(1);
		expect(plan.creates[0].conflictFallback).toBe(true);
		expect(plan.creates[0].fields.company).toBe('Acme Second');
	});

	it('should collect every email in the file for the synced-email skip list', () => {
		const first = makeApp({ company: 'Acme', role: 'SWE', emails: [emails[0]] });
		const second = makeApp({ company: 'Beta', role: 'PM', emails: [emails[1]] });
		const plan = planFor([first, second], []);
		expect(plan.syncEmails.map(email => email.messageId).sort()).toEqual(['m-app', 'm-int']);
	});
});
