import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Application, Category } from '../types';

// Stub the db so findExisting runs against a controlled set of "existing" applications. Only the two
// lookup helpers it calls need mocking; companiesSameEntity (real) still does the entity matching.
const dbMock = vi.hoisted(() => ({
	findByCompanyDomain: vi.fn(async (_d: string) => [] as Application[]),
	findByCompanyFirstWord: vi.fn(async (_w: string) => [] as Application[]),
}));
vi.mock('./db', () => dbMock);

import { findExisting } from './applicationMatcher';

let nextId = 1;
function app(p: Partial<Application>): Application {
	return {
		id: String(nextId++), company: 'Acme', role: null, status: 'applied',
		interview_step: null, reached_interview: false,
		date_applied: null, last_activity: null, last_activity_ts: 0,
		job_url: null, notes: null, notes_source: 'auto', external_id: null,
		edited: false, detected_by: 'parser', company_domain: null,
		awaiting_application: false, fast_apply: false, source: 'gmail',
		gmail_thread_id: null, account: null, emails: [], created_at: '', updated_at: '',
		...p,
	} as Application;
}
// All tests use domain=null, so matching flows through the name probe.
const setExisting = (apps: Application[]) => dbMock.findByCompanyFirstWord.mockImplementation(async () => apps);

beforeEach(() => { nextId = 1; vi.clearAllMocks(); dbMock.findByCompanyDomain.mockResolvedValue([]); });

describe('findExisting', () => {
	it('no candidates → undefined (new application)', async () => {
		setExisting([]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, false, '2026-02-16')).toBeUndefined();
	});

	it('two direct confirmations of the same title stay separate', async () => {
		setExisting([app({ role: 'Engineer', date_applied: '2026-02-16' })]);
		// isConfirmation=true, not fast-apply, existing not fast/awaiting → new record
		expect(await findExisting('Acme', 'Engineer', null, null, true, false, '2026-03-01')).toBeUndefined();
	});

	it('a fast-apply confirmation pairs with the company\'s same-title record', async () => {
		const existing = app({ role: 'Engineer', date_applied: '2026-02-16' });
		setExisting([existing]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, true, '2026-02-16')).toMatchObject({ id: existing.id });
	});

	it('a rejection attaches to a same-title application that PREDATES it', async () => {
		const applied = app({ role: 'Engineer', status: 'applied', date_applied: '2026-02-16' });
		setExisting([applied]);
		expect(await findExisting('Acme', 'Engineer', null, null, false, false, '2026-02-18')).toMatchObject({ id: applied.id });
	});

	// ── The Palantir bug ──────────────────────────────────────────────────────
	it('a rejection does NOT attach to a LATER application (creates its own record)', async () => {
		const june = app({ role: 'Engineer', status: 'applied', date_applied: '2026-06-07' });
		setExisting([june]);
		// rejected@Feb-18 must not latch onto the June application → undefined (→ awaiting record)
		expect(await findExisting('Acme', 'Engineer', null, null, false, false, '2026-02-18')).toBeUndefined();
	});

	it('a confirmation claims the same-title record an earlier rejection left awaiting', async () => {
		const june    = app({ id: 'A', role: 'Engineer', status: 'applied',  date_applied: '2026-06-07' });
		const awaiting = app({ id: 'C', role: 'Engineer', status: 'rejected', date_applied: '2026-02-18', awaiting_application: true });
		setExisting([june, awaiting]);                                  // June app sorts ahead of the awaiting record
		// applied@Feb-16 is the rejection's missing confirmation → claims C, not a new record, not June
		expect(await findExisting('Acme', 'Engineer', null, null, true, false, '2026-02-16')).toMatchObject({ id: 'C' });
	});

	it('a LATER confirmation does NOT claim an awaiting rejection (the recent application stays separate)', async () => {
		// rejected@Feb-18 created this awaiting record; a Jun-7 "application received" is a NEW application,
		// not the rejection's missing confirmation — it must not swallow it (the original Palantir bug).
		setExisting([app({ id: 'C', role: 'Engineer', status: 'rejected', date_applied: '2026-02-18', awaiting_application: true })]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, false, '2026-06-07')).toBeUndefined();
	});

	it('a different req number is a distinct posting', async () => {
		setExisting([app({ role: 'Engineer', external_id: '111', date_applied: '2026-02-16' })]);
		expect(await findExisting('Acme', 'Engineer', '999', null, false, false, '2026-03-01')).toBeUndefined();
	});

	it('a status update fills the role on a lone still-roleless record that PREDATES it', async () => {
		const roleless = app({ role: 'Unknown Role', status: 'applied', date_applied: '2026-02-16' });
		setExisting([roleless]);
		expect(await findExisting('Acme', 'Engineer', null, null, false, false, '2026-02-20')).toMatchObject({ id: roleless.id });
	});

	it('a rejection does NOT upgrade a LATER roleless application (different posting)', async () => {
		// a Jun untitled "application received" the model couldn't title is a different posting — an older
		// Feb rejection must not latch onto and rename it (the actual Palantir / Forward Deployed bug).
		setExisting([app({ id: 'R', role: 'Unknown Role', status: 'applied', date_applied: '2026-06-07' })]);
		expect(await findExisting('Acme', 'Engineer', null, null, false, false, '2026-02-18')).toBeUndefined();
	});

	it('an interview joins a same-title awaiting record even when that record postdates it', async () => {
		// rejected@Feb-18 created an awaiting record; an older interview@Feb-16 is still a round of THAT
		// application — it merges in rather than stranding as a separate record (the route keeps status rejected).
		setExisting([app({ id: 'C', role: 'Engineer', status: 'rejected', date_applied: '2026-02-18', awaiting_application: true })]);
		expect(await findExisting('Acme', 'Engineer', null, null, false, false, '2026-02-16')).toMatchObject({ id: 'C' });
	});

	it('a fast-apply re-application does NOT pair with an earlier application it postdates', async () => {
		// applying again via LinkedIn months after a rejection is a NEW application, not the company-side
		// confirmation of the old one — the fast-apply pairing must not merge it (Wealthfront / CyberCoders).
		setExisting([app({ role: 'Engineer', status: 'rejected', date_applied: '2026-02-10' })]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, true, '2026-04-01')).toBeUndefined();
	});

	it('a role-less status update does NOT attach to a LATER application', async () => {
		// a Jan-8 roleless rejection with only a Feb-9 application present must not latch onto it (CyberCoders).
		setExisting([app({ role: 'Engineer', status: 'applied', date_applied: '2026-02-09' })]);
		expect(await findExisting('Acme', null, null, null, false, false, '2026-01-08')).toBeUndefined();
	});

	it('a role-less status update attaches to the oldest application that PREDATES it', async () => {
		const old1  = app({ id: 'O', role: 'A', status: 'applied', date_applied: '2025-12-29' });
		const mid   = app({ id: 'M', role: 'B', status: 'applied', date_applied: '2026-01-05' });
		const later = app({ id: 'L', role: 'C', status: 'applied', date_applied: '2026-02-09' });
		setExisting([later, mid, old1]);
		// roleless rejection@Jan-8: predating = {O, M}; oldest = O. The later Feb-9 record is excluded.
		expect(await findExisting('Acme', null, null, null, false, false, '2026-01-08')).toMatchObject({ id: 'O' });
	});

	it('a duplicate rejection for one posting collapses onto the same record (resent notice)', async () => {
		// Some employers send two rejection emails for one posting ("not moving forward" + "position filled").
		// They share identity, so the second attaches to the existing record instead of spawning a duplicate.
		setExisting([app({ id: 'C', role: 'Engineer', status: 'rejected', date_applied: '2026-02-18', awaiting_application: true })]);
		expect(await findExisting('Acme', 'Engineer', null, null, false, false, '2026-02-25')).toMatchObject({ id: 'C' });
	});
});

// ── Full Palantir sequence (findExisting + the route's create/update, every order) ────────────────
// Drives the real findExisting through a faithful mini-version of the sync route so the END grouping is
// asserted, not just one decision. Mirrors the actual emails: a Feb Full Stack application + its Feb
// rejection, plus a SEPARATE Jun application the model couldn't title (role=null → roleless). The Feb
// rejection must NOT attach to the later untitled Jun application. Correct outcome, any order:
//   { applied@Feb-16, rejected@Feb-18 } = rejected   and   { applied@Jun-7 (untitled) } = applied
describe('findExisting — full Palantir grouping (order-independent)', () => {
	interface Em { cat: 'applied' | 'rejected'; role: string | null; date: string; ts: number; isConfirmation: boolean }
	const FS = 'Full Stack Software Engineer - Application Development';
	const feb16: Em = { cat: 'applied',  role: FS,   date: '2026-02-16', ts: 1, isConfirmation: true };
	const feb18: Em = { cat: 'rejected', role: FS,   date: '2026-02-18', ts: 2, isConfirmation: false };
	const jun07: Em = { cat: 'applied',  role: null, date: '2026-06-07', ts: 3, isConfirmation: true };  // untitled (Forward Deployed)

	async function run(order: Em[]) {
		const store: Application[] = [];
		dbMock.findByCompanyFirstWord.mockImplementation(async () => [...store]);
		for (const e of order) {
			const existing = await findExisting('Palantir', e.role, null, null, e.isConfirmation, false, e.date);
			const ref = { messageId: `${e.cat}-${e.date}`, category: e.cat, date: e.date };
			if (existing) {
				if (e.ts >= existing.last_activity_ts) { existing.status = e.cat; existing.last_activity = e.date; existing.last_activity_ts = e.ts; }
				if (!existing.date_applied || e.date < existing.date_applied) existing.date_applied = e.date;
				if (existing.role === 'Unknown Role' && e.role) existing.role = e.role;
				if (e.isConfirmation && existing.awaiting_application) existing.awaiting_application = false;
				existing.emails.push(ref);
			} else {
				store.push(app({ company: 'Palantir', role: e.role ?? 'Unknown Role', status: e.cat, date_applied: e.date,
					last_activity: e.date, last_activity_ts: e.ts, awaiting_application: !e.isConfirmation, emails: [ref] }));
			}
		}
		return store;
	}

	const permutations: Em[][] = [
		[jun07, feb18, feb16], [feb18, jun07, feb16], [feb18, feb16, jun07],
		[feb16, feb18, jun07], [jun07, feb16, feb18], [feb16, jun07, feb18],
	];
	for (const order of permutations) {
		it(`→ {Feb} rejected + {Jun} applied for order [${order.map(e => e.date.slice(5)).join(', ')}]`, async () => {
			const store = await run(order);
			const summary = store.map(a => `${a.status}:[${a.emails.map(e => e.category).sort().join(',')}]`).sort();
			expect(summary).toEqual(['applied:[applied]', 'rejected:[applied,rejected]']);
		});
	}
});

// ── One posting: fast-apply + confirmation + interview + rejection, processed newest-first ─────────
// The interview (older than the rejection) must NOT strand as a separate record — it joins the one
// application, status stays rejected (newest wins), reached_interview stays true.
describe('findExisting — out-of-order rounds collapse into one application', () => {
	interface Em { cat: Exclude<Category, 'ignored'>; role: string; date: string; ts: number; isConfirmation: boolean; isFastApply: boolean }
	const R = 'Engineer';
	const emails: Em[] = [   // newest-first
		{ cat: 'rejected',  role: R, date: '2026-04-04', ts: 4, isConfirmation: false, isFastApply: false },
		{ cat: 'interview', role: R, date: '2026-04-03', ts: 3, isConfirmation: false, isFastApply: false },
		{ cat: 'applied',   role: R, date: '2026-04-02', ts: 2, isConfirmation: true,  isFastApply: false },
		{ cat: 'applied',   role: R, date: '2026-04-01', ts: 1, isConfirmation: true,  isFastApply: true  },
	];

	it('→ one rejected application holding all four emails, reached_interview true', async () => {
		const store: Application[] = [];
		dbMock.findByCompanyFirstWord.mockImplementation(async () => [...store]);
		for (const e of emails) {
			const existing = await findExisting('Acme', e.role, null, null, e.isConfirmation, e.isFastApply, e.date);
			const ref = { messageId: `${e.cat}-${e.date}`, category: e.cat, date: e.date };
			if (existing) {
				if (e.ts >= existing.last_activity_ts) { existing.status = e.cat; existing.last_activity_ts = e.ts; }
				if (!existing.date_applied || e.date < existing.date_applied) existing.date_applied = e.date;
				if (e.cat === 'interview' || e.cat === 'offer') existing.reached_interview = true;
				if (e.isConfirmation && existing.awaiting_application) existing.awaiting_application = false;
				if (e.isFastApply) existing.fast_apply = true;
				existing.emails.push(ref);
			} else {
				store.push(app({ role: e.role, status: e.cat, date_applied: e.date, last_activity_ts: e.ts,
					reached_interview: e.cat === 'interview' || e.cat === 'offer',
					awaiting_application: !e.isConfirmation, fast_apply: e.isFastApply, emails: [ref] }));
			}
		}
		expect(store).toHaveLength(1);
		expect(store[0]).toMatchObject({ status: 'rejected', reached_interview: true, date_applied: '2026-04-01' });
		expect(store[0].emails.map(e => e.category).sort()).toEqual(['applied', 'applied', 'interview', 'rejected']);
	});
});
