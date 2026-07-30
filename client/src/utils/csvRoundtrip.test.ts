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

// A release-1.0.0 export had no ID column. Drop the first cell of every line to turn a current export
// into a 1.0.0-shaped file. The id is always first and is a bare integer (never quoted, no comma), so
// slicing past the first comma is safe even when later cells (Notes) are quoted and contain commas.
const dropIdColumn = (csv: string) =>
	csv.split(/\r?\n/).map(line => line.slice(line.indexOf(',') + 1)).join('\n');

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

	it('should round-trip a valid ID column so a re-import matches purely by id (rule 1, no-op)', () => {
		const board = [
			makeApp({ id: '4374', company: 'Distyl', role: 'SWE', emails }),
			makeApp({ id: '4210', company: 'Beta Corp', role: 'PM', emails: [] }),
		];
		const parsed = parseApplicationsCsv(applicationsToCsv(board));
		expect(parsed.apps.map(app => app.id)).toEqual(['4374', '4210']);   // the ID survives export → parse verbatim
		const plan = buildImportPlan(parsed, board);
		expect(plan.creates).toEqual([]);
		expect(plan.updates).toEqual([]);   // every field round-trips → no diff
		expect(plan.skipped).toBe(2);
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

	it('should name every row when an application id repeats across three rows', () => {
		const app = makeApp({ id: '5', company: 'Acme', role: 'SWE' });
		const csv = applicationsToCsv([app, { ...app, company: 'Acme Two' }, { ...app, company: 'Acme Three' }]);
		expect(() => parseApplicationsCsv(csv))
			.toThrow(/Application id 5 appears in rows 2, 3, 4 \(Acme, Acme Two, Acme Three\)/);
	});

	it('should NOT reject a file whose rows have blank ids and unique emails', () => {
		// Blank ids are exempt (they just mean "no id"); a clean file must pass pre-validation untouched.
		const csv = 'Company,Role,Emails\r\nAcme,SWE,applied|m-1|2026-01-01\r\nBeta,PM,applied|m-2|2026-01-02';
		expect(() => parseApplicationsCsv(csv)).not.toThrow();
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
		// The board has never held these ids, so they arrive as new refs — hence origin 'imported'.
		expect(plan.updates[0].changes.emails).toEqual(emails.map(emailRef => ({ ...emailRef, origin: 'imported' })));
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

describe('import plan — 1.0.0 fallback (no ID column)', () => {
	it('should re-import a whole ID-less export of the board as a no-op (never duplicates the board)', () => {
		const board = [
			makeApp({ company: 'Acme', role: 'SWE', emails }),                    // has emails → matches by rule 2
			makeApp({ company: 'Beta Corp', role: 'Backend Dev', emails: [] }),   // email-less → matches by rule 3
		];
		const legacyCsv = dropIdColumn(applicationsToCsv(board));
		const plan = buildImportPlan(parseApplicationsCsv(legacyCsv), board);
		expect(plan.creates).toEqual([]);   // the upgrade path must not re-add applications already on the board
		expect(plan.updates).toEqual([]);
		expect(plan.moves).toEqual([]);
		expect(plan.deletes).toEqual([]);
		expect(plan.skipped).toBe(2);
	});

	it('should add only the genuinely new manual row from a 1.0.0 file, matching the rest', () => {
		const board = [
			makeApp({ company: 'Acme', role: 'SWE', emails }),
			makeApp({ company: 'Beta Corp', role: 'Backend Dev', emails: [] }),
		];
		// The legacy file also carries a brand-new manual application — no id, no emails, new company+role.
		const legacyCsv = `${dropIdColumn(applicationsToCsv(board))}\nGamma LLC,Designer,Applied`;
		const plan = buildImportPlan(parseApplicationsCsv(legacyCsv), board);
		expect(plan.creates).toHaveLength(1);
		expect(plan.creates[0].fields.company).toBe('Gamma LLC');
		expect(plan.creates[0].preservedId).toBeNull();   // 1.0.0 rows carry no id to preserve
		expect(plan.skipped).toBe(2);                      // the two existing rows matched, unchanged
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

// ── Email origin: the import procedure's tagging rule ───────────────────────
// An import tags a ref 'imported' ONLY when the messageId is new to this database. A ref the board
// already holds keeps the origin it has there, so 'synced' and 'manual' both survive a re-import — the
// board is the authority on provenance, never the file's own origin cell.
describe('import plan — email origin', () => {
	const syncedRef   = (messageId: string): EmailRef => ({ messageId, category: 'applied',   date: '2026-02-01', origin: 'synced' });
	const manualRef   = (messageId: string): EmailRef => ({ messageId, category: 'interview', date: '2026-03-10', origin: 'manual' });
	const untaggedRef = (messageId: string): EmailRef => ({ messageId, category: 'applied',   date: '2026-02-01' });
	// The origin each message id ends up with, across every ref the plan would write.
	const plannedOrigins = (plan: ReturnType<typeof buildImportPlan>) => {
		const refsThePlanWouldWrite = [
			...plan.creates.flatMap(plannedCreate => plannedCreate.fields.emails),
			...plan.updates.flatMap(plannedUpdate => plannedUpdate.changes.emails ?? []),
		];
		return Object.fromEntries(refsThePlanWouldWrite.map(emailRef => [emailRef.messageId, emailRef.origin]));
	};

	it('should tag a message id the board has never held as imported', () => {
		const plan = planFor([makeApp({ company: 'Acme', role: 'SWE', emails: [untaggedRef('19f0000000000001')] })], []);
		expect(plan.creates).toHaveLength(1);
		expect(plan.creates[0].fields.emails[0].origin).toBe('imported');
	});

	it('should NOT relabel a synced ref — an import never overwrites provenance the board already has', () => {
		const board = [makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [syncedRef('19f0000000000001')] })];
		// The row also carries a genuinely new id, so the update is not skipped as a no-op.
		const fileRows = [makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [syncedRef('19f0000000000001'), untaggedRef('19f0000000000002')] })];
		expect(plannedOrigins(planFor(fileRows, board))).toEqual({ '19f0000000000001': 'synced', '19f0000000000002': 'imported' });
	});

	it('should NOT relabel a manual ref — manual survives an import that lists it again', () => {
		const board = [makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [manualRef('19f0000000000003')] })];
		const fileRows = [makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [manualRef('19f0000000000003'), untaggedRef('19f0000000000004')] })];
		expect(plannedOrigins(planFor(fileRows, board))).toEqual({ '19f0000000000003': 'manual', '19f0000000000004': 'imported' });
	});

	it('should tag an id EDITED in the file as imported, whatever the ref it replaced was', () => {
		// Editing an id in the spreadsheet does not edit a ref — it names one the board has never held, so
		// the result is a new ref, and every new ref an import brings in is 'imported'.
		const board = [
			makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [syncedRef('19f0000000000001')] }),
			makeApp({ id: '11', company: 'Beta', role: 'PM',  emails: [manualRef('19f0000000000003')] }),
		];
		const fileRows = [
			makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [syncedRef('19f00000000000ff')] }),   // was ...0001, synced
			makeApp({ id: '11', company: 'Beta', role: 'PM',  emails: [manualRef('19f00000000000ee')] }),   // was ...0003, manual
		];
		expect(plannedOrigins(planFor(fileRows, board))).toEqual({ '19f00000000000ff': 'imported', '19f00000000000ee': 'imported' });
	});

	it('should ignore the origin the FILE claims for an id the board does not hold', () => {
		// A hand-edited cell claiming 'synced'/'manual' must not be able to forge provenance: no sync and no
		// UI attach ever produced this ref in THIS database, so it is 'imported' either way.
		const fileRows = [makeApp({ company: 'Acme', role: 'SWE', emails: [syncedRef('19f0000000000005'), manualRef('19f0000000000006')] })];
		expect(plannedOrigins(planFor(fileRows, []))).toEqual({ '19f0000000000005': 'imported', '19f0000000000006': 'imported' });
	});

	it('should leave a legacy untagged ref untagged rather than inventing a provenance for it', () => {
		const board = [makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [untaggedRef('19f0000000000007')] })];
		const fileRows = [makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [untaggedRef('19f0000000000007'), untaggedRef('19f0000000000008')] })];
		expect(plannedOrigins(planFor(fileRows, board))).toEqual({ '19f0000000000007': undefined, '19f0000000000008': 'imported' });
	});

	it('should re-import an untouched export as a pure no-op — inheriting origins creates no email diff', () => {
		// The guard against churn: if inheritance were even slightly off, every re-import would look like an
		// email change on every row and rewrite the whole board.
		const board = [
			makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [syncedRef('19f0000000000001'), manualRef('19f0000000000003')] }),
			makeApp({ id: '11', company: 'Beta', role: 'PM',  emails: [untaggedRef('19f0000000000007')] }),
		];
		const plan = planFor(board, board);
		expect(plan.updates).toEqual([]);
		expect(plan.creates).toEqual([]);
		expect(plan.skipped).toBe(2);
	});

	it('should not touch the email list at all when a row only edits other fields', () => {
		// A spreadsheet edit to the company/status must not put `emails` in the plan's changes — if it did,
		// ordinary editing would rewrite every ref (and every origin) on the row for no reason.
		const board = [makeApp({ id: '10', company: 'Acme', role: 'SWE', status: 'applied', emails: [syncedRef('19f0000000000001'), manualRef('19f0000000000003')] })];
		const editedRow = [{ ...board[0], company: 'Acme Corp', status: 'rejected' as const }];
		const plan = planFor(editedRow, board);
		expect(plan.updates).toHaveLength(1);
		expect(plan.updates[0].changes).toEqual({ company: 'Acme Corp', status: 'rejected' });
		expect(plan.updates[0].changes.emails).toBeUndefined();
	});

	// Merging two applications in the spreadsheet is the case where refs CHANGE APPLICATION. A ref's origin
	// says how that email entered the database, not which row currently holds it, so moving one leaves its
	// origin alone — the merge is not a re-discovery. Only ids the board has never held are the import's own
	// doing, and those become 'imported'.
	it('should keep every moved ref\'s origin through a merge, and only tag genuinely new ids imported', () => {
		const board = [
			makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [syncedRef('19f0000000000001')] }),
			makeApp({ id: '11', company: 'Acme', role: 'SWE', emails: [manualRef('19f0000000000003')] }),
		];
		// One row claims both applications' emails and adds a third the board has never seen — the shape of a
		// hand-merge: row 11 deleted in the spreadsheet, its email folded into row 10.
		const mergedRow = [{ ...board[0], emails: [syncedRef('19f0000000000001'), manualRef('19f0000000000003'), untaggedRef('19f0000000000009')] }];
		const plan = planFor(mergedRow, board);

		expect(plannedOrigins(plan)).toEqual({
			'19f0000000000001': 'synced',     // stayed put, still the sync's find
			'19f0000000000003': 'manual',     // MOVED off application 11, still hand-attached
			'19f0000000000009': 'imported',   // never on the board before → the import's own
		});
		// …and the merge really happened: the ref left application 11, which is then merged away.
		expect(plan.moves.map(move => [move.messageId, move.fromId])).toEqual([['19f0000000000003', '11']]);
		expect(plan.deletes.map(deleted => deleted.id)).toEqual(['11']);
	});

	it('should keep the origin out of the exported file, and restore it from the board on the way back in', () => {
		const app = makeApp({ id: '10', company: 'Acme', role: 'SWE', emails: [syncedRef('19f0000000000001'), manualRef('19f0000000000003')] });
		const exported = applicationsToCsv([app]);
		expect(exported).not.toContain('synced');    // the export is unchanged by origins existing…
		expect(exported).not.toContain('manual');

		const parsed = parseApplicationsCsv(exported);
		expect(parsed.apps[0].emails.map(emailRef => emailRef.origin)).toEqual([undefined, undefined]);

		// …and nothing is lost, because the board — not the file — is what the origins are read from. The row
		// also carries a new id so the update is not skipped as a no-op, proving the inherited values are what
		// would actually be written.
		const rowWithOneNewEmail = [{ ...app, emails: [...app.emails, untaggedRef('19f0000000000009')] }];
		expect(plannedOrigins(planFor(rowWithOneNewEmail, [app]))).toEqual({
			'19f0000000000001': 'synced',
			'19f0000000000003': 'manual',
			'19f0000000000009': 'imported',
		});
	});
});
