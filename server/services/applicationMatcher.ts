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

// Records from `candidates` that are the SAME job posting as `role`: first an exact normalized-title
// match; failing that — and only when there is exactly ONE — a title-drift variant whose normalized title
// contains or is contained by this one ("Full Stack Software Engineer" ↔ "Full Stack Software Engineer -
// Application Development"). The exactly-one guard keeps a bare "Software Engineer" from collapsing into
// one of several "Software Engineer N" postings.
function findPostingMatches(role: string | null, candidates: Application[]): Application[] {
	const targetTitle = normRole(role);
	if (!targetTitle) return [];
	const exactMatches = candidates.filter(candidate => normRole(candidate.role) === targetTitle);
	if (exactMatches.length) return exactMatches;
	const variantMatches = candidates.filter(candidate => {
		const candidateTitle = normRole(candidate.role);
		return !!candidateTitle && candidateTitle !== targetTitle
			&& (candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle));
	});
	return variantMatches.length === 1 ? variantMatches : [];
}

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
 * disambiguate, and whether the email is a CONFIRMATION vs a STATUS update decides intent:
 *
 *  - req number present         → the record with that req; a different req is a different posting
 *  - role present, match        → that posting (re-confirmation / status update for it)
 *  - role present, no match     → a STATUS email upgrades a single still-roleless record; a
 *                                  CONFIRMATION ("applied") is a new application → create new
 *  - no role, CONFIRMATION      → new application (so role-less confirmations don't all collapse —
 *                                  e.g. several Google "Thanks for applying" emails stay separate)
 *  - no role, STATUS update     → the company's original application (oldest)
 */
export async function findExisting(company: string, role: string | null, externalId: string | null, domain: string | null, isConfirmation: boolean, isFastApply: boolean, date: string): Promise<Application | undefined> {
	// Gather every record that could be THIS employer, then disambiguate by role below. Probe by DOMAIN
	// and by NAME and UNION both — not "domain, else name": one employer's records can be split, some
	// carrying the sender domain and some not (CSV imports, legacy entries, un-backfilled siblings).
	// Skipping the name probe whenever the domain matched would hide those siblings and spawn a duplicate.
	//   • DOMAIN — unique to one employer (job-board hosts excluded); bridges spellings ("JPMorgan" ↔ "JPMorganChase").
	//   • NAME   — first-word matches, kept only if the same entity ("Epic" ✗ "Epic Kids") and not carrying a different domain.
	const byDomain = domain ? await db.findByCompanyDomain(domain) : [];
	const byName = (await db.findByCompanyFirstWord(company.split(/\s+/)[0])).filter(app =>
		companiesSameEntity(app.company, company) && (!domain || !app.company_domain || app.company_domain === domain),
	);
	const seenIds = new Set(byDomain.map(app => app.id));
    // When domain and name are both found, then dedup the overlapping record
	let companyApps = [...byDomain, ...byName.filter(app => !seenIds.has(app.id))];

	// No candidate → new application. No global req-number fallback: req numbers are unique only WITHIN a
	// company, so a global match could merge a different employer.
	if (companyApps.length === 0) return undefined;

	// Within the company, the req/job number is the strongest disambiguator.
	if (externalId) {
		const sameReq = companyApps.find(app => app.external_id === externalId);
		if (sameReq) return sameReq;
		// No record shares this req → distinct posting. Records with a DIFFERENT req are dropped; only
		// req-less records can still be the same job (their number may just not be extracted yet).
		companyApps = companyApps.filter(app => !app.external_id);
		if (companyApps.length === 0) return undefined;
	}

	// Pure date checks against this email's `date`, one term in the larger conditions below. A record with
	// no date_applied yet counts as compatible. A confirmation can only originate a record applied ON OR
	// AFTER it; a status update can only land on one applied ON OR BEFORE it — opposite directions.
	const appliedAfter = (app: Application) => !app.date_applied || date <= app.date_applied;
	const appliedBefore = (app: Application) => !app.date_applied || app.date_applied <= date;

	// A CONFIRMATION ("applied") is a NEW application: it adopts an existing record by role ONLY to pair a
	// fast-apply with the company's own email — two plain confirmations with the same title stay separate
	// unless they share a req. A STATUS update belongs to an EXISTING application, so it matches by title
	// freely and can backfill the role an earlier role-less confirmation lacked.
	const incomingHasRole = !!role && role !== 'Unknown Role';
	if (incomingHasRole) {
		const postingMatches = findPostingMatches(role, companyApps);
		if (isConfirmation) {
			// Pair a fast-apply with the company's own confirmation of the SAME application — but not one it
			// postdates (a later fast-apply is a re-application → new cycle). When several same-title records
			// exist, pair with the oldest so the choice is deterministic, not whichever the db returned first.
			const posting = postingMatches.length ? oldest(postingMatches) : undefined;
			if (posting && (isFastApply || posting.fast_apply) && appliedAfter(posting)) return posting;
			// Claim a same-title record an earlier status email left awaiting — unless this confirmation
			// postdates it (then it's a new application, not the one that was waiting).
			const awaiting = postingMatches.find(app => app.awaiting_application && appliedAfter(app));
			if (awaiting) return awaiting;
		} else {
			// A status update joins its same-title application that predates it (or a still-awaiting record).
			// Duplicate notices (two rejections for one posting) collapse here; a real re-application splits
			// via the confirmation path. The status value itself is resolved on the route.
			const attachable = postingMatches.filter(app => appliedBefore(app) || app.awaiting_application);
			if (attachable.length) return attachable.reduce((a, b) => (b.date_applied ?? '') > (a.date_applied ?? '') ? b : a);
		}
		// Email's role matched no posting above — fall back to the company's roleless records.
		const roleless = companyApps.filter(app => !app.role || app.role === 'Unknown Role');
		// A STATUS update names the role on a lone roleless record — but only one that PREDATES it; a LATER
		// untitled application is a different posting an older rejection must not rename.
		if (!isConfirmation && roleless.length === 1 && appliedBefore(roleless[0])) return roleless[0];
		// A CONFIRMATION instead claims a roleless record an earlier status email left awaiting (its other
		// half), backfilling role/date instead of duplicating. Date-guarded against grabbing an unrelated rejection.
		if (isConfirmation) {
			const awaiting = roleless.filter(app => app.awaiting_application && appliedAfter(app));
			if (awaiting.length) return oldest(awaiting);
		}
		return undefined;
	}
	// Incoming email has NO role.
	if (isConfirmation) {
		// Backfill the oldest predating awaiting record (its missing confirmation), else fold into the oldest
		// predating ROLED application. Date-guarded — a confirmation that postdates every record is new.
		const awaiting = companyApps.filter(app => app.awaiting_application && appliedAfter(app));
		if (awaiting.length) return oldest(awaiting);
		const roled = companyApps.filter(app => app.role && app.role !== 'Unknown Role' && appliedAfter(app));
		if (roled.length) return oldest(roled);
		return undefined;
	}
	// A role-less status update attaches to the company's oldest application that PREDATES it — never a
	// LATER one (a different posting). With none predating, it waits for its own confirmation.
	const predating = companyApps.filter(app => appliedBefore(app) || app.awaiting_application);
	return predating.length ? oldest(predating) : undefined;
}
