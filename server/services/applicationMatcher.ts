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
		// Same title = same posting.
		const sameRole = matches.filter(m => normRole(m.role) === normRole(role));
		if (isConfirmation) {
			const exact = sameRole[0];  //TODO: why is role[0]?
			// Pair a fast-apply notice with the company's own confirmation of the SAME application — but not
			// with an EARLIER application it postdates (a later fast-apply is a re-application → new cycle).
			if (exact && (isFastApply || exact.fast_apply) && (!exact.date_applied || date <= exact.date_applied)) return exact;
			// Claim a same-title record an earlier (newer-processed) status email left awaiting — unless this
			// confirmation postdates it, in which case it's a new application, not the one that was waiting.
			const awaiting = sameRole.find(m => m.awaiting_application && (!m.date_applied || date <= m.date_applied));
			if (awaiting) return awaiting;
		} else {
			// A status update joins its same-title application — one that predates it, or a still-awaiting record
			// (placeholder date). Duplicate notices (e.g. two rejection emails for one posting) collapse here;
			// a genuine re-application splits via the confirmation path. Status itself is resolved on the route.
			const candidates = sameRole.filter(m => !m.date_applied || m.date_applied <= date || m.awaiting_application);
			if (candidates.length) return candidates.reduce((a, b) => (b.date_applied ?? '') > (a.date_applied ?? '') ? b : a);
		}
        // When same company but no role in the application
		const roleless = matches.filter(m => !m.role || m.role === 'Unknown Role');
		// A STATUS update names the role on a lone still-roleless record — but only one that PREDATES it. A
		// LATER untitled application is a different posting, so an older rejection must not rename it.
		if (!isConfirmation && roleless.length === 1 && (!roleless[0].date_applied || roleless[0].date_applied <= date)) return roleless[0];
		// A CONFIRMATION otherwise stays separate, but claims a roleless record an earlier status email left
		// awaiting (its other half) — backfilling role/date instead of spawning a duplicate. Date-guarded so a
		// confirmation that postdates the awaiting record doesn't grab an unrelated rejection.
		if (isConfirmation) {
			const awaiting = roleless.filter(m => m.awaiting_application && (!m.date_applied || date <= m.date_applied));
			if (awaiting.length) return oldest(awaiting);
		}
		return undefined;
	}
	// Incoming email has NO role.
	if (isConfirmation) {
		// Backfill the oldest predating awaiting record (its missing confirmation); else fold into the oldest
		// predating ROLED application (the company's own confirmation of it). Both date-guarded — a confirmation
		// that postdates the existing record is a new application; with no match it stays a fresh record.
		const awaiting = matches.filter(m => m.awaiting_application && (!m.date_applied || date <= m.date_applied));
		if (awaiting.length) return oldest(awaiting);
		const roled = matches.filter(m => m.role && m.role !== 'Unknown Role' && (!m.date_applied || date <= m.date_applied));
		if (roled.length) return oldest(roled);
		return undefined;
	}
	// A role-less status update attaches to the company's oldest application that PREDATES it — never a
	// LATER one (that's a different posting). With none predating, it waits for its own confirmation.
	const predating = matches.filter(m => !m.date_applied || m.date_applied <= date || m.awaiting_application);
	return predating.length ? oldest(predating) : undefined;
}
