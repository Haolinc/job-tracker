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

// A fast-apply NOTICE and the company's own CONFIRMATION of one apply event land close in time; a same-
// posting applied email further out is a separate cycle. Slots do the heavy lifting (a filled slot can't
// take another, so re-applications never merge regardless of this bound) — the bound is just a loose
// backstop so a confirmation with no nearby notice doesn't grab an old echo-less one. The DB shows real
// pairs land same-day and the next applied gap is 5+ days, so ~4 days covers system lag / a next-day
// cross-channel apply while staying under that floor. Tunable; precision is no longer load-bearing.
const PAIR_WINDOW_DAYS = 4;
const withinPairWindow = (a: string, b: string | null) =>
	!b || Math.abs(Date.parse(a) - Date.parse(b)) <= PAIR_WINDOW_DAYS * 86_400_000;
// Among candidates, the one nearest in time to `date` — EITHER direction, since a fast-apply notice can
// arrive slightly after the company's own reply. Deterministic: ties break on the lower id.
const nearestByDate = (apps: Application[], date: string): Application =>
	apps.reduce((a, b) => {
		const ga = a.date_applied ? Math.abs(Date.parse(date) - Date.parse(a.date_applied)) : 0;
		const gb = b.date_applied ? Math.abs(Date.parse(date) - Date.parse(b.date_applied)) : 0;
		return ga !== gb ? (ga < gb ? a : b) : (a.id < b.id ? a : b);
	});

/**
 * Match an incoming email to an existing application, or undefined to create a new one. COMPANY is the
 * primary key (gathered by domain ∪ name above); within a company, req number then ROLE narrow to a
 * posting, and the email's kind decides intent:
 *
 *  - req number present  → the record with that req; a different req is a different posting
 *  - APPLY email (a fast-apply notice OR the company's confirmation) → fills its slot on the NEAREST same-
 *                          posting record whose matching slot is open, within a loose time bound; else new
 *  - STATUS update (interview/offer/rejected) → joins the same-posting application that predates it
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

	// A STATUS update can only land on a record applied ON OR BEFORE it (you can't be rejected before you
	// applied); a record with no date_applied yet counts as compatible.
	const appliedBefore = (app: Application) => !app.date_applied || app.date_applied <= date;
	const isRoleless = (app: Application) => !app.role || app.role === 'Unknown Role';
	// An APPLY email (a fast-apply NOTICE fills `fast_apply`, the company CONFIRMATION fills `confirmed`) can
	// fill a record's matching slot when that slot is OPEN, and either:
	//  • the record is a real apply event near in time — the notice↔echo pair (proximity bound), or
	//  • it's an AWAITING record seeded by a status email — whose date is a placeholder, so we use the causal
	//    guard "the apply is on/before the seeding status" instead of the bound (a later apply is a new cycle).
	const slotOpen = (app: Application) => isFastApply ? !app.fast_apply : !app.confirmed;
	const claimable = (app: Application) => slotOpen(app) && (
		app.awaiting_application
			? (!app.date_applied || date <= app.date_applied)
			: withinPairWindow(date, app.date_applied)
	);

	const incomingHasRole = !!role && role !== 'Unknown Role';
	if (incomingHasRole) {
		const postingMatches = findPostingMatches(role, companyApps);
		if (isConfirmation) {
			// Apply-side slot pairing: pair this notice/confirmation into the NEAREST same-posting record it can
			// fill (slot open + near in time, or an awaiting record it predates). Opposite-slot-open ⇒ two notices
			// never merge and two confirmations never merge. Failing a posting match (role drift, or all slots
			// full), fall back to a role-less record the same way — an awaiting status record, or a role-less echo.
			const open = postingMatches.filter(claimable);
			if (open.length) return nearestByDate(open, date);
			const rolelessOpen = companyApps.filter(app => isRoleless(app) && claimable(app));
			if (rolelessOpen.length) return nearestByDate(rolelessOpen, date);
			return undefined;
		}
		// A STATUS update joins its same-title application that predates it (or a still-awaiting record). The
		// status value itself is resolved on the route; duplicate notices collapse onto the same record.
		const attachable = postingMatches.filter(app => appliedBefore(app) || app.awaiting_application);
		if (attachable.length) return attachable.reduce((a, b) => (b.date_applied ?? '') > (a.date_applied ?? '') ? b : a);
		// …or it names the role on a still-role-less record that PREDATES it. Emails are now processed
		// oldest→newest, so any earlier role-less apply already exists when this status arrives; claim the
		// OLDEST predating one. Merging renames it (no longer role-less), so the NEXT rejection claims the
		// next-oldest — pairing an older rejection to the older application (FIFO). `appliedBefore` still
		// bars renaming a LATER application, and the strong req/role matches above always win first.
		const stillRoleless = companyApps.filter(app => isRoleless(app) && appliedBefore(app));
		if (stillRoleless.length) return oldest(stillRoleless);
		return undefined;
	}
	// Incoming email has NO role.
	if (isConfirmation) {
		// A role-less applied email (untitled notice, or a confirmation that didn't name the role) fills the
		// matching slot of the NEAREST same-company record it can fill — with no role to match a posting it can
		// only attach to its near-in-time notice/echo (or an awaiting record), else it starts a new root.
		const open = companyApps.filter(claimable);
		return open.length ? nearestByDate(open, date) : undefined;
	}
	// A role-less status update attaches to the company's oldest application that PREDATES it (or awaiting).
	const predating = companyApps.filter(app => appliedBefore(app) || app.awaiting_application);
	return predating.length ? oldest(predating) : undefined;
}
