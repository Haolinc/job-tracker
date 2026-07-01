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
import { isFastApplyNotice } from '../utils';

let nextId = 1;
function app(p: Partial<Application>): Application {
	return {
		id: String(nextId++), company: 'Acme', role: null, status: 'applied',
		interview_step: null, reached_interview: false,
		date_applied: null, last_activity: null, last_activity_ts: 0,
		job_url: null, notes: null, notes_source: 'auto', external_id: null,
		edited: false, detected_by: 'parser', company_domain: null,
		awaiting_application: false, fast_apply: false, confirmed: false, source: 'gmail',
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

	it('a fast-apply confirmation with several same-title records pairs with the OLDEST (deterministic, not db order)', async () => {
		const newer = app({ id: 'NEW', role: 'Engineer', date_applied: '2026-03-01' });
		const older = app({ id: 'OLD', role: 'Engineer', date_applied: '2026-02-16' });
		setExisting([newer, older]);   // db returns the newer record first; the pick must not depend on that
		expect(await findExisting('Acme', 'Engineer', null, null, true, true, '2026-02-16')).toMatchObject({ id: 'OLD' });
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

	it('a role-bearing rejection claims the OLDEST predating role-less record (forward-order FIFO)', async () => {
		// The role lives on the rejection, not on the untitled applies, so there's no title to match. With
		// emails now processed oldest→newest, claim the oldest predating role-less record rather than giving
		// up. (The old `=== 1` guard split this into a separate rejected card whenever >1 role-less existed.)
		const older = app({ id: 'OLD', role: 'Unknown Role', status: 'applied', date_applied: '2026-02-10' });
		const newer = app({ id: 'NEW', role: 'Unknown Role', status: 'applied', date_applied: '2026-02-14' });
		setExisting([newer, older]);   // db order must not matter
		expect(await findExisting('Acme', 'Engineer', null, null, false, false, '2026-02-20')).toMatchObject({ id: 'OLD' });
	});

	it('two untitled applies + two role-bearing rejections pair FIFO oldest→newest', async () => {
		// The regression case end-to-end: older rejection → older application, newer rejection → newer one.
		// The first claim renames its record (no longer role-less), so the second claims the next-oldest.
		const store: Application[] = [];
		dbMock.findByCompanyFirstWord.mockImplementation(async () => [...store]);
		const seq: { role: string | null; cat: 'applied' | 'rejected'; date: string; conf: boolean }[] = [
			{ role: null,       cat: 'applied',  date: '2026-02-01', conf: true  },  // apply A (untitled)
			{ role: null,       cat: 'applied',  date: '2026-02-05', conf: true  },  // apply B (untitled)
			{ role: 'Engineer', cat: 'rejected', date: '2026-02-20', conf: false },  // reject A (older rejection)
			{ role: 'Analyst',  cat: 'rejected', date: '2026-02-25', conf: false },  // reject B (newer rejection)
		];
		let ts = 0;
		for (const e of seq) {
			ts++;
			const existing = await findExisting('Acme', e.role, null, null, e.conf, false, e.date);
			const ref = { messageId: `${e.cat}-${e.date}`, category: e.cat, date: e.date };
			if (existing) {
				if (ts >= existing.last_activity_ts) { existing.status = e.cat; existing.last_activity_ts = ts; }
				if (!existing.date_applied || e.date < existing.date_applied) existing.date_applied = e.date;
				if (existing.role === 'Unknown Role' && e.role) existing.role = e.role;
				existing.emails.push(ref);
			} else {
				store.push(app({ role: e.role ?? 'Unknown Role', status: e.cat, date_applied: e.date, last_activity_ts: ts, confirmed: e.conf, emails: [ref] }));
			}
		}
		const summary = store.map(a => `${a.role}/${a.status}:[${a.emails.map(x => x.category).join(',')}]`).sort();
		expect(store.length).toBe(2);
		expect(summary).toEqual(['Analyst/rejected:[applied,rejected]', 'Engineer/rejected:[applied,rejected]']);
	});

	it('cross-window: role-less applies backfill awaiting rejects oldest-first (FIFO)', async () => {
		// Two role-bearing rejections were stored as AWAITING records in an earlier (narrower) sync; their
		// applies only arrive now, in a wider sync. Processed oldest-first, each apply backfills the OLDEST
		// awaiting reject — older apply → older rejection.
		const store = [
			app({ id: 'RA', role: 'Engineer', status: 'rejected', date_applied: '2026-06-20', awaiting_application: true }),
			app({ id: 'RB', role: 'Analyst',  status: 'rejected', date_applied: '2026-06-22', awaiting_application: true }),
		];
		dbMock.findByCompanyFirstWord.mockImplementation(async () => [...store]);
		const applyA = await findExisting('Acme', null, null, null, true, false, '2026-05-10');
		expect(applyA).toMatchObject({ id: 'RA' });               // older apply → oldest awaiting reject
		applyA!.awaiting_application = false; applyA!.confirmed = true;   // route fills the slot
		expect(await findExisting('Acme', null, null, null, true, false, '2026-05-15')).toMatchObject({ id: 'RB' });
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

	it('a fast-apply re-application does NOT pair with a LATER application processed first (FanDuel)', async () => {
		// Emails sync newest-first, so the Mar record exists when an EARLIER Feb fast-apply for the same title
		// arrives. That Feb apply is a separate cycle, not the Mar one's other half — the old one-directional
		// guard (date <= date_applied) wrongly merged it, collapsing FanDuel's four applies into one record.
		setExisting([app({ role: 'Engineer', date_applied: '2026-03-07', fast_apply: true })]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, true, '2026-02-06')).toBeUndefined();
	});

	it('a fast-apply pairs with a company confirmation a few days late (system lag, still one apply)', async () => {
		// A non-fast confirmation delayed up to PAIR_WINDOW_DAYS still pairs — the empty 1–4 day band before
		// the 5-day re-application floor leaves room for system lag without merging a separate cycle.
		const root = app({ role: 'Engineer', date_applied: '2026-02-16', fast_apply: true });
		setExisting([root]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, false, '2026-02-19')).toMatchObject({ id: root.id });
	});

	it('a fast-apply root does NOT absorb a company confirmation a week later (a re-application, not the echo)', async () => {
		// Beyond the window the same-title confirmation is a new cycle, not the notice's echo.
		setExisting([app({ role: 'Engineer', date_applied: '2026-02-16', fast_apply: true })]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, false, '2026-02-23')).toBeUndefined();
	});

	it('two fast-apply notices for the same role on the SAME day stay separate (each is its own application)', async () => {
		// The notice slot is already filled, so a second notice can't pair in — each fast-apply is its own
		// application, even same day.
		setExisting([app({ role: 'Engineer', date_applied: '2026-02-16', fast_apply: true })]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, true, '2026-02-16')).toBeUndefined();
	});

	it('a second company confirmation does NOT merge into an already-confirmed record (confirmation slot full)', async () => {
		// The confirmation slot is taken, so a later same-title confirmation is a new application, not a second
		// echo — even within the pairing window.
		setExisting([app({ role: 'Engineer', date_applied: '2026-02-16', confirmed: true })]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, false, '2026-02-17')).toBeUndefined();
	});

	it('a fast-apply notice fills the open notice slot of a confirmation-only record (echo synced first)', async () => {
		// The company confirmation was processed first as a confirmation-only record; the LinkedIn notice then
		// fills its still-open notice slot (pairing works in either arrival order).
		const echo = app({ role: 'Engineer', date_applied: '2026-02-16', confirmed: true, fast_apply: false });
		setExisting([echo]);
		expect(await findExisting('Acme', 'Engineer', null, null, true, true, '2026-02-16')).toMatchObject({ id: echo.id });
	});

	it('a role-less confirmation does NOT fold into a roled application weeks earlier (Lila)', async () => {
		// A role=null "thanks for applying" must not merge into a same-company application far in the past — that
		// was the Lila over-merge. With no role to match and no nearby open slot, it starts a new application.
		setExisting([app({ role: 'Engineer I, Automation', date_applied: '2026-02-24', fast_apply: true })]);
		expect(await findExisting('Acme', null, null, null, true, false, '2026-03-31')).toBeUndefined();
	});

	it('a role-less confirmation pairs with a nearby notice (its own echo)', async () => {
		const notice = app({ role: 'Engineer I, Automation', date_applied: '2026-02-24', fast_apply: true });
		setExisting([notice]);
		expect(await findExisting('Acme', null, null, null, true, false, '2026-02-24')).toMatchObject({ id: notice.id });
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

	it('a status update merges into a lone title-drift variant of the same posting', async () => {
		// the rejection's role is a shorter variant of the application's title — same posting (Palantir).
		const applied = app({ id: 'P', role: 'Full Stack Software Engineer - Application Development', status: 'applied', date_applied: '2026-02-16' });
		setExisting([applied]);
		expect(await findExisting('Acme', 'Full Stack Software Engineer', null, null, false, false, '2026-02-18')).toMatchObject({ id: 'P' });
	});

	it('a bare-title status does NOT merge when several postings could contain it', async () => {
		// two distinct "Software Engineer N" postings — a bare "Software Engineer" is ambiguous → no merge.
		setExisting([
			app({ role: 'Software Engineer 1 (React)',   status: 'applied', date_applied: '2026-02-16' }),
			app({ role: 'Software Engineer 2 (Backend)', status: 'applied', date_applied: '2026-02-16' }),
		]);
		expect(await findExisting('Acme', 'Software Engineer', null, null, false, false, '2026-02-18')).toBeUndefined();
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
				if (e.isConfirmation && !existing.confirmed) existing.confirmed = true;
				existing.emails.push(ref);
			} else {
				store.push(app({ company: 'Palantir', role: e.role ?? 'Unknown Role', status: e.cat, date_applied: e.date,
					last_activity: e.date, last_activity_ts: e.ts, awaiting_application: !e.isConfirmation, confirmed: e.isConfirmation, emails: [ref] }));
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
				if (e.isConfirmation && !e.isFastApply && !existing.confirmed) existing.confirmed = true;
				existing.emails.push(ref);
			} else {
				store.push(app({ role: e.role, status: e.cat, date_applied: e.date, last_activity_ts: e.ts,
					reached_interview: e.cat === 'interview' || e.cat === 'offer',
					awaiting_application: !e.isConfirmation, fast_apply: e.isFastApply, confirmed: e.isConfirmation && !e.isFastApply, emails: [ref] }));
			}
		}
		expect(store).toHaveLength(1);
		expect(store[0]).toMatchObject({ status: 'rejected', reached_interview: true, date_applied: '2026-04-01' });
		expect(store[0].emails.map(e => e.category).sort()).toEqual(['applied', 'applied', 'interview', 'rejected']);
	});
});

// ── EarthCam: a fast-apply NOTICE + the company's own confirmation + two rejections = ONE record ───────
// Regression for the isFastApply bug. isFastApply is derived through the real isFastApplyNotice, so the
// classifier_code drives it exactly like the route does: the "linkedin_rejected" must NOT count as a fast-
// apply. If it did, the rejection that CREATES the record stamps fast_apply=true, and the real same-day
// notice then fails the fast⊕non-fast pairing (fast vs fast) and splits off — the observed two-record bug.
describe('findExisting — fast-apply notice + confirmation + rejections collapse (EarthCam)', () => {
	interface Em { cat: Exclude<Category, 'ignored'>; date: string; ts: number; isConfirmation: boolean; code: string }
	const R = 'QA Automation Engineer';
	const emails: Em[] = [   // newest-first, as Gmail streams
		{ cat: 'rejected', date: '2026-04-09', ts: 4, isConfirmation: false, code: 'linkedin_rejected' },
		{ cat: 'rejected', date: '2026-04-06', ts: 3, isConfirmation: false, code: 'general_template' },  // duplicate notice
		{ cat: 'applied',  date: '2026-04-01', ts: 2, isConfirmation: true,  code: 'general_template' },  // company echo
		{ cat: 'applied',  date: '2026-04-01', ts: 1, isConfirmation: true,  code: 'linkedin_applied' },  // fast-apply notice
	];

	it('→ one rejected record holding the notice, the echo, and both rejections', async () => {
		const store: Application[] = [];
		dbMock.findByCompanyFirstWord.mockImplementation(async () => [...store]);
		for (const e of emails) {
			const isFastApply = isFastApplyNotice(e.code);
			const existing = await findExisting('EarthCam', R, null, null, e.isConfirmation, isFastApply, e.date);
			const ref = { messageId: `${e.cat}-${e.date}`, category: e.cat, date: e.date };
			if (existing) {
				if (e.ts >= existing.last_activity_ts) { existing.status = e.cat; existing.last_activity_ts = e.ts; }
				if (!existing.date_applied || e.date < existing.date_applied) existing.date_applied = e.date;
				if (e.isConfirmation && existing.awaiting_application) existing.awaiting_application = false;
				if (isFastApply && !existing.fast_apply) existing.fast_apply = true;
				if (e.isConfirmation && !isFastApply && !existing.confirmed) existing.confirmed = true;
				existing.emails.push(ref);
			} else {
				store.push(app({ company: 'EarthCam', role: R, status: e.cat, date_applied: e.date, last_activity_ts: e.ts,
					awaiting_application: !e.isConfirmation, fast_apply: isFastApply, confirmed: e.isConfirmation && !isFastApply, emails: [ref] }));
			}
		}
		expect(store).toHaveLength(1);
		expect(store[0]).toMatchObject({ status: 'rejected', date_applied: '2026-04-01', fast_apply: true });
		expect(store[0].emails.map(e => e.category).sort()).toEqual(['applied', 'applied', 'rejected', 'rejected']);
	});
});

// ── FanDuel: four fast-apply cycles to the same role = four records (re-applications never merge) ──────
// Each cycle is a LinkedIn notice + the company's own confirmation on the same day. The slots keep them
// apart: once a record's notice slot is filled, the next cycle's notice can't pair into it, so it starts a
// new record and pulls its own echo. This is the headline over-merge the slot model fixes (was 1 record).
describe('findExisting — repeated fast-apply cycles stay separate (FanDuel)', () => {
	interface Em { date: string; ts: number; code: string }
	const R = 'Software Engineer';
	const emails: Em[] = [   // newest-first; notice + echo per day
		{ date: '2026-03-07', ts: 8, code: 'linkedin_applied' }, { date: '2026-03-07', ts: 7, code: 'general_template' },
		{ date: '2026-02-06', ts: 6, code: 'linkedin_applied' }, { date: '2026-02-06', ts: 5, code: 'general_template' },
		{ date: '2026-01-13', ts: 4, code: 'linkedin_applied' }, { date: '2026-01-13', ts: 3, code: 'general_template' },
		{ date: '2026-01-06', ts: 2, code: 'linkedin_applied' }, { date: '2026-01-06', ts: 1, code: 'general_template' },
	];

	it('→ four records, each holding one notice + one confirmation', async () => {
		const store: Application[] = [];
		dbMock.findByCompanyFirstWord.mockImplementation(async () => [...store]);
		for (const e of emails) {
			const isFastApply = isFastApplyNotice(e.code);
			const existing = await findExisting('FanDuel', R, null, null, true, isFastApply, e.date);
			const ref = { messageId: `${e.code}-${e.date}-${e.ts}`, category: 'applied' as const, date: e.date };
			if (existing) {
				if (!existing.date_applied || e.date < existing.date_applied) existing.date_applied = e.date;
				if (isFastApply && !existing.fast_apply) existing.fast_apply = true;
				if (!isFastApply && !existing.confirmed) existing.confirmed = true;
				existing.emails.push(ref);
			} else {
				store.push(app({ company: 'FanDuel', role: R, status: 'applied', date_applied: e.date, last_activity_ts: e.ts,
					fast_apply: isFastApply, confirmed: !isFastApply, emails: [ref] }));
			}
		}
		expect(store).toHaveLength(4);
		for (const a of store) expect(a.emails.map(e => e.category)).toEqual(['applied', 'applied']);
	});
});
