// ── The matching engine ─────────────────────────────────────────────────────
// Picks which existing application an incoming email belongs to — or none (create a new one).
// Extracted from the sync route so the app's trickiest logic is testable against a stubbed db.

import * as db from './db';
import { companiesSameEntity } from './companyIdentity';
import type { Application } from '../types';

// Normalize a role for comparison: lower-case, strip everything but letters/digits. So "Software
// Engineer 2 (Backend)" and "software engineer 2 - backend" compare equal, but "Software Engineer"
// and "Software Engineer 2 (Backend)" do NOT — they're distinct postings.
const normRole = (r: string | null) => (r ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The original application for a company: earliest date_applied, id as tiebreak. */
function oldest(apps: Application[]): Application {
	return apps.reduce((a, b) => {
		const da = a.date_applied ?? '', db_ = b.date_applied ?? '';
		if (da !== db_) return da < db_ ? a : b;
		return a.id < b.id ? a : b;
	});
}

/**
 * Match an incoming email to an existing application, or undefined to create a new one. COMPANY is
 * the primary key (gathered by domain ∪ name above); within a company the req number then the ROLE
 * disambiguate, and the email's CATEGORY decides intent:
 *
 *  - req number present         → the record with that req; a different req is a different posting
 *  - role present, exact match  → that posting (re-confirmation / status update for it)
 *  - role present, no exact     → a STATUS email upgrades a single still-roleless record; a
 *                                  CONFIRMATION ("applied") is a new application → create new
 *  - no role, CONFIRMATION      → new application (so role-less confirmations don't all collapse —
 *                                  e.g. several Google "Thanks for applying" emails stay separate)
 *  - no role, STATUS update     → the company's original application (oldest)
 */
export async function findExisting(company: string, role: string | null, externalId: string | null, domain: string | null, isConfirmation: boolean, isFastApply: boolean, date: string): Promise<Application | undefined> {
	// COMPANY FIRST — gather every record that could be THIS employer, then disambiguate by role below.
	// We probe two ways and UNION the results, rather than "domain, else name":
	//   • by DOMAIN — a real company domain (ATS/job-board hosts already excluded) is unique to one
	//     employer, and bridges name spellings for free ("JPMorgan" ↔ "JPMorganChase").
	//   • by NAME   — first-word candidates, kept only when they're the same entity ("Epic" ✗ "Epic
	//     Kids") and don't carry a DIFFERENT real domain (a known other employer the name resembles).
	// Both are needed because one employer's records can be split across them: some carry the sender
	// domain, others don't yet (CSV imports, manual/legacy entries, or siblings whose domain hasn't been
	// backfilled). If the name probe were skipped whenever the domain probe found even one record, those
	// domain-less siblings would stay invisible and the email would spawn a DUPLICATE of the same employer.
	const byDomain = domain ? await db.findByCompanyDomain(domain) : [];
	const byName = (await db.findByCompanyFirstWord(company.split(/\s+/)[0])).filter(m =>
		companiesSameEntity(m.company, company) && (!domain || !m.company_domain || m.company_domain === domain),
	);
	const seen = new Set(byDomain.map(m => m.id));
	let matches = [...byDomain, ...byName.filter(m => !seen.has(m.id))];

	// No candidate → new application. We deliberately do NOT fall back to a global req-number lookup: req
	// numbers are only unique WITHIN a company, so a global match could wrongly merge a different employer.
	if (matches.length === 0) return undefined;

	// Within the company, the req/job number is the strongest disambiguator.
	if (externalId) {
		const byId = matches.find(m => m.external_id === externalId);
		if (byId) return byId;
		// This email names a req number none of the existing records share → a DISTINCT posting. Only
		// records that carry no req of their own can still be the same job (their number may simply not
		// have been extracted yet); a record with a DIFFERENT req is a different job, so drop it.
		matches = matches.filter(m => !m.external_id);
		if (matches.length === 0) return undefined;
	}

	// Resolve the role. A CONFIRMATION ("applied") is a NEW application: it adopts an existing record by
	// exact role ONLY to pair a LinkedIn/Indeed fast-apply with the company's own email — two regular
	// confirmations with the same title stay separate unless they share a req number. A STATUS update
	// (interview/offer/rejected) is about an EXISTING application, so it matches by title freely and may
	// also carry the role an earlier role-less confirmation lacked and upgrade it.
	const incomingHasRole = !!role && role !== 'Unknown Role';
	if (incomingHasRole) {
		// Exact title = same posting. But a CONFIRMATION ("applied") only merges by title when one side is a
		// LinkedIn/Indeed FAST-APPLY: that's the job-board email pairing with the company's own confirmation.
		// Two REGULAR confirmations with the same title are DISTINCT applications (a shared req number, handled
		// above, is the only thing that merges them) — so applying to two like-named postings directly stays
		// as two records. A STATUS update (rejection/interview/offer) always matches its application by title.
		// EXCEPTION: an AWAITING exact-title record is a status email (e.g. a rejection processed first, since
		// the sync runs newest-first) explicitly waiting for its own confirmation — that confirmation always
		// claims it, fast-apply or not, so an application and its rejection don't end up as two records.
		const exact = matches.find(m => normRole(m.role) === normRole(role));
		if (exact && (!isConfirmation || isFastApply || exact.fast_apply || exact.awaiting_application)) return exact;
		const roleless = matches.filter(m => !m.role || m.role === 'Unknown Role');
		// A STATUS update (interview/rejected/…) fills in the role on a lone still-roleless record.
		if (!isConfirmation && roleless.length === 1) return roleless[0];
		// A CONFIRMATION normally stays separate (so distinct postings don't collapse) — but it DOES claim
		// a roleless record that an earlier status update left AWAITING its application. That record is this
		// posting's other half: the status email (e.g. a rejection) arrived and created the record before
		// its confirmation was processed (the sync runs newest-first, so a later rejection lands before its
		// own older confirmation). Claiming it backfills the role + application date and clears the wait,
		// instead of spawning a second record. The date guard keeps a confirmation that POSTDATES the
		// awaiting record's activity from grabbing an unrelated rejection.
		if (isConfirmation) {
			const awaiting = roleless.filter(m => m.awaiting_application && (!m.date_applied || date <= m.date_applied));
			if (awaiting.length) return oldest(awaiting);
		}
		return undefined;
	}
	// Incoming email has NO role.
	if (isConfirmation) {
		// A role-less confirmation first backfills an "awaiting" record: a status update that arrived before
		// its (older, out-of-window) confirmation. Its role came from that update; this confirmation just
		// supplies the application date and clears the flag.
		// DATE GUARD: only backfill a record whose status update is NOT older than this application — an
		// application that POSTDATES a rejection is a NEW application to the company, not the confirmation
		// that rejection was waiting for, so it must keep its own record.
		const awaiting = matches.filter(m => m.awaiting_application && (!m.date_applied || date <= m.date_applied));
		if (awaiting.length) return oldest(awaiting);
		// No awaiting record to claim. If a ROLED application to this company already exists, this title-less
		// email is the company's own confirmation of one of them (the company-side of a LinkedIn/Indeed
		// fast-apply, or the confirmation paired with a rejection that already created the record) — fold it
		// in to backfill the application date/domain instead of spawning a blank "Unknown Role" duplicate.
		// Only ROLED records are eligible, so several genuinely title-less applications to one company
		// (e.g. multiple "Thanks for applying to Google" with no role anywhere) still stay separate. Same
		// DATE GUARD as above: a title-less confirmation that POSTDATES the existing application is a NEW
		// application to the company, not that one's confirmation, so it keeps its own record.
		const roled = matches.filter(m => m.role && m.role !== 'Unknown Role' && (!m.date_applied || date <= m.date_applied));
		if (roled.length) return oldest(roled);
		return undefined;
	}
	// A role-less status update attaches to the company's original application (oldest).
	return oldest(matches);
}
