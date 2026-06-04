import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { listJobMessageIds, streamJobMessages } from '../services/gmailService';
import { classifyEmail } from '../services/classifier';
import { parseEmail, extractGeneralCompanyRole, extractJobNumber, recoverRoleFromBody, tidyRole } from '../services/parser';
import * as db from '../services/db';
import { errMsg, buildLookupKey } from '../utils';
import type { Application } from '../types';

const router = Router();

// Patterns that identify automated / non-application emails.
// Matched before calling the LLM to avoid unnecessary inference.
const AUTOMATED_SUBJECT = new RegExp(
	[
		'^automatic reply',
		'^auto:',
		'^out of office',
		'interview confirmation',
		'interview confirmed',
		'your interview (is|has been) (confirmed|scheduled)',
		'has been scheduled',
		'calendar invite',
		'meeting confirmed',
		'reminder',
		'jobs? alert',
		'new jobs? for you',
		'\\d+ new jobs?',
		'your career opportunities at',       // recruitment marketing, not application confirmation
		// Account-activation / email-verification emails from ATS portals — the application is NOT yet
		// submitted (e.g. Siemens "Email address validation request"), so this isn't an application event.
		'email address validation',
		'verify your email',
		'confirm your email',
		'activate your account',
		// Glassdoor post-application feedback survey — runtime backstop; Gmail query
		// already excludes by subject, but these emails DO match the keywordFilter
		// ("your application"), so a fetched straggler would still be skipped here.
		'quick question about your application at',
		// Jacobs generic portal-reminder emails — subject is exactly "Jacobs - Application Update"
		// with no role after it. The valid Jacobs emails always have ", [Role]" after "Update".
		'jacobs - application update(?!,)',
	].join('|'),
	'i',
);
const AUTOMATED_FROM = /calendly\./i;

// ATS platforms and generic mail providers — never treat their domain as a company name.
const ATS_DOMAINS = new Set([
	'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'icims.com', 'taleo.net', 'bamboohr.com',
	'smartrecruiters.com', 'jobvite.com', 'jazz.co', 'breezy.hr',
	'workday.com', 'myworkday.com', 'successfactors.com', 'applytojob.com',
	'recruitingbypaycor.com', 'paylocity.com', 'adp.com', 'ultipro.com',
	'indeed.com', 'linkedin.com', 'glassdoor.com', 'ziprecruiter.com',
	// More ATS / applicant-mail platforms that send "on behalf of" the employer — the platform
	// domain is never the company, so the body/sender-name must supply the real name instead.
	'rippling.com', 'brassring.com', 'ashbyhq.com', 'applyresponse.com', 'workablemail.com', 'kula.ai',
	'candidatecare.com',   // iCIMS Candidate Care portal — a shared ATS host, never the employer's own domain
	'governmentjobs.com', 'clearcompany.com',   // NEOGOV gov-jobs board & ClearCompany ATS — shared hosts, not the employer
	// Coding-assessment platforms — they send "on behalf of" an employer; the platform is never the company.
	'hackerrank.com', 'hackerrankforwork.com', 'codility.com', 'codesignal.com', 'hackerearth.com',
	'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
]);

// Strips trailing legal suffixes so e.g. "Sun West Mortgage Company" and
// "Sun West Mortgage" resolve to the same dedup key.
// The lookbehind (?<=\w) prevents matching " Co." in "Foo & Co." (which would
// leave a broken trailing "&") — only strip when preceded by a word character.
const COMPANY_SUFFIX_RE = /(?<=\w)[,.]?\s+(?:company|incorporated|inc\.?|llc|ltd\.?|corp\.?|corporation|co\.)$/i;

// LinkedIn company-page qualifiers appended after a spaced dash ("CLEAR - Corporate" → "CLEAR").
const LINKEDIN_QUALIFIER_RE = /\s+[-–]\s+(?:Corporate|Corp|HQ|Headquarters|Global|US|USA|U\.S\.A?\.?|North America|EMEA|APAC|Worldwide)\.?$/i;

function normalizeCompany(name: string): string {
	// "X dba Y" / "X d/b/a Y" → Y, the trade name people actually use ("CP Payroll, LLC dba ConnectPay" → "ConnectPay").
	name = name.replace(/^.*?\bd\/?b\/?a\b\s*/i, '').trim();
	name = name.replace(LINKEDIN_QUALIFIER_RE, '').trim();
	return name.replace(COMPANY_SUFFIX_RE, '').trim();
}

// Generic local-part prefixes that identify the ATS or HR function, not the employer.
// "globalhr" is RTX's shared HR Workday address — not a company slug.
const GENERIC_LOCAL = /^(no.?reply|noreply|donotreply|workday|notifications?|info|support|careers|talent|hr|recruiting|jobs?|globalhr)$/i;

/**
 * Last-resort fallback: parse the employer name from the sender domain.
 * e.g. "noreply@walmart.com" → "Walmart", "careers@stripe.com" → "Stripe".
 * Returns null for ATS platforms, generic providers, and unrecognised senders.
 *
 * Special case: Workday branded subdomains use the local part as the company
 * slug (e.g. "cableone@myworkday.com" → "CableONE"). The LLM already knows
 * this rule but fails when the email body contains no company name.
 */
function extractCompanyFromSender(from: string): string | null {
	const rawEmail = from.match(/<([^>]+)>/)?.[1] ?? from.match(/\S+@\S+/)?.[0];
	if (!rawEmail) return null;
	const [localPart, domain] = rawEmail.toLowerCase().split('@');
	if (!domain) return null;

	// Workday branded subdomains: "cableone@myworkday.com" → company slug is "cableone".
	// Slugs ≤ 2 chars (e.g. "ms" for Morgan Stanley) are abbreviations the fallback
	// can't meaningfully expand — return null and let the LLM extract from the body.
	if (domain === 'myworkday.com') {
		if (!localPart || GENERIC_LOCAL.test(localPart) || localPart.length <= 2) return null;
		return localPart.charAt(0).toUpperCase() + localPart.slice(1);
	}

	if (ATS_DOMAINS.has(domain)) return null;
	// Also check parent domain for subdomained ATS hosts (e.g. "us.greenhouse-mail.io").
	const labels = domain.split('.');
	if (labels.length >= 3 && ATS_DOMAINS.has(labels.slice(1).join('.'))) return null;

	// "careers.walmart.com" → "walmart";  "walmart.com" → "walmart"
	const companySlug = labels.length >= 3 ? labels[labels.length - 2] : labels[0];
	return companySlug.charAt(0).toUpperCase() + companySlug.slice(1);
}

// HR/ATS-function words that get appended to a corporate sender's display name. Their presence is the
// signal that the display name is a COMPANY (not a person), so we only trust the name when one strips off.
const SENDER_NAME_SUFFIX = /[\s,]*(?:[-–|]\s*)?(?:(?:p&o|people(?:\s*&\s*organization)?)\s+)?(?:workday\s+)?(?:talent acquisition(?:\s+team)?|talent team|career opportunities|careers|recruit(?:ing|ment)(?:\s+team)?|human resources|hiring(?:\s+team)?|notifications?)\s*$/i;

/**
 * Fallback for ATS senders whose body omits the company: recover it from the sender DISPLAY NAME.
 * Only trusted when the name (a) carries an HR/ATS suffix we can strip ("RTX Workday Notifications" →
 * "RTX", "Siemens P&O Talent Acquisition" → "Siemens") or (b) uses the icims " @ " form ("Charles
 * Schwab Corporation @ icims" → "Charles Schwab Corporation"). A plain personal/company name with no
 * such marker is ignored — it's as likely to be a recruiter's name as an employer.
 */
function extractCompanyFromSenderName(from: string): string | null {
	let name = (from.split('<')[0] ?? '').trim().replace(/^["']|["']$/g, '').trim();
	if (!name) return null;

	// icims form: "<Company> @ icims" — the part after " @ " is the ATS, not the company.
	const atIdx = name.indexOf(' @ ');
	if (atIdx > 0) return name.slice(0, atIdx).trim() || null;
	if (name.includes('@')) return null;   // a raw address slipped through — no usable display name

	// Strip one or more trailing HR/ATS suffix runs ("Siemens P&O Talent Acquisition" → "Siemens").
	let stripped = name;
	for (let prev = ''; prev !== stripped; ) { prev = stripped; stripped = stripped.replace(SENDER_NAME_SUFFIX, '').trim(); }
	if (stripped === name || stripped.length < 2) return null;   // nothing stripped → likely a person, not a company
	return stripped;
}

/**
 * Do two role strings plausibly refer to the same posting? True if either side is empty /
 * the "Unknown Role" placeholder, or one is the other plus appended qualifiers — i.e. the
 * shorter role's significant words (>2 chars) are all contained in the longer one.
 * Merges "Software Engineer (L3 BE)" with "Software Engineer" / "… (Req 123)", but keeps
 * "Software Engineer" vs "QA Automation Engineer" or "Data Analyst" apart (they don't share
 * the full shorter title, only the generic word "engineer").
 */
function rolesCompatible(a: string | null, b: string | null): boolean {
	if (!a || !b || a === 'Unknown Role' || b === 'Unknown Role') return true;
	const tokens = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 2));
	const ta = tokens(a), tb = tokens(b);
	if (ta.size === 0 || tb.size === 0) return false;
	const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
	for (const t of small) if (!big.has(t)) return false;   // every word of the shorter title must appear in the longer
	return true;
}

// Generic corporate/industry descriptors. A longer company name that only ADDS these to a shorter one
// is the same entity under a fuller name ("SS&C" → "SS&C Technologies"). A non-descriptor extra word
// ("Epic" → "Epic Kids") signals a DIFFERENT company that merely shares a first word.
const COMPANY_DESCRIPTOR = new Set([
	// corporate structure / generic
	'group', 'holdings', 'capital', 'partners', 'ventures', 'international', 'global', 'worldwide',
	'industries', 'enterprises', 'company', 'brands', 'labs', 'studios', 'inc', 'llc', 'ltd', 'plc',
	'corp', 'corporation', 'co', 'management', 'advisors', 'advisory', 'asset', 'investments',
	// tech / functional descriptors
	'technologies', 'technology', 'tech', 'sciences', 'science', 'systems', 'solutions', 'software',
	'hardware', 'digital', 'services', 'consulting', 'networks', 'communications', 'analytics',
	'security', 'cloud', 'data', 'robotics', 'semiconductor', 'semiconductors', 'electronics',
	// industry sectors — "Fora Travel" is the same company as "Fora"; "Travel" is its sector, not a new brand
	'financial', 'finance', 'health', 'healthcare', 'bank', 'media', 'pharmaceuticals', 'pharma',
	'bio', 'biosciences', 'therapeutics', 'diagnostics', 'energy', 'power', 'retail', 'foods', 'food',
	'motors', 'automotive', 'aerospace', 'travel', 'hospitality', 'insurance', 'mortgage', 'realty',
	'logistics', 'transport', 'transportation', 'education', 'learning', 'payments', 'lending',
	'entertainment', 'games', 'gaming', 'sports', 'fitness', 'apparel', 'beverages', 'restaurants',
	'hotels', 'airlines', 'telecom', 'telecommunications', 'mobility', 'space', 'defense', 'materials',
]);

/**
 * The sender's real company domain, or null. Returns null for ATS / job-board / generic-provider
 * senders (LinkedIn, Indeed, Workday, Greenhouse, gmail.com…) so only a genuine company talent-team
 * address ("careers@epic.com" → "epic.com") is kept. Stored on the application and used to
 * disambiguate companies that share a first word during matching.
 */
function companyDomainFromSender(from: string): string | null {
	const rawEmail = from.match(/<([^>]+)>/)?.[1] ?? from.match(/\S+@\S+/)?.[0];
	const domain = rawEmail?.toLowerCase().split('@')[1];
	if (!domain) return null;
	if (ATS_DOMAINS.has(domain)) return null;
	const labels = domain.split('.');
	// registrable domain ≈ last two labels ("careers.epic.com" → "epic.com"). Good enough for the
	// common .com/.io/.ai/.co single-suffix TLDs these emails use.
	const registrable = labels.length >= 2 ? labels.slice(-2).join('.') : domain;
	if (ATS_DOMAINS.has(registrable)) return null;   // subdomained ATS host ("us.greenhouse-mail.io")
	return registrable;
}

const companyWords = (s: string) => s.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);

/**
 * LOOSE name match — one name's words are a leading prefix of the other's ("Epic" ⊂ "Epic Kids",
 * "Lila" ⊂ "Lila Sciences"). Used only to GATHER candidates cheaply; findExisting then confirms the
 * real employer with the sender domain and companiesSameEntity. Keeps "Morgan Stanley" vs "Morgan
 * Lewis" apart (second word differs) and "Lila" vs "Lilac" apart (different first word).
 */
function companiesCompatible(a: string, b: string): boolean {
	const wa = companyWords(a), wb = companyWords(b);
	if (!wa.length || !wb.length) return false;
	const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
	return short.every((w, i) => w === long[i]);
}

/**
 * STRICT same-employer check — a prefix match where the longer name only ADDS generic
 * corporate/industry descriptors ("SS&C" ↔ "SS&C Technologies", "Fora" ↔ "Fora Travel"). A distinct
 * proper noun in the extra words means a DIFFERENT company sharing a first word ("Epic" ✗ "Epic Kids").
 * This is the fallback when the sender domain can't decide (e.g. both records came from ATS senders).
 */
function companiesSameEntity(a: string, b: string): boolean {
	if (!companiesCompatible(a, b)) return false;
	const wa = companyWords(a), wb = companyWords(b);
	const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
	return long.slice(short.length).every(w => COMPANY_DESCRIPTOR.has(w));
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
 * Match an incoming email to an existing application. COMPANY is the primary key: no entry
 * for the company → it's a new application. Within a company, the ROLE only disambiguates,
 * and fuzzily — a status email often abbreviates the role ("Software Engineer (L3 BE)" →
 * "Software Engineer"), so word-for-word matching isn't required.
 *
 *  - 0 entries                  → undefined (create new)
 *  - 1 entry                    → adopt it when the role is compatible (you only applied here
 *                                  once); a genuinely different role → undefined (separate posting)
 *  - several entries + role     → exact match, else the oldest role-compatible one, else create
 *  - several entries + no role  → the oldest (the original application)
 */
async function findExisting(company: string, role: string | null, externalId: string | null, domain: string | null): Promise<Application | undefined> {
	// Step 1 — gather candidates by company name (loose word-prefix match). One first-word lookup covers
	// the exact company and its name variants. (A substring "contains" match can't be used — it ignores
	// word boundaries, so "Lila" ⊂ "Lilac".)
	let matches = (await db.findByCompanyFirstWord(company.split(/\s+/)[0] ?? company))
		.filter(m => companiesCompatible(m.company, company));

	// No name candidate → it's a new application/interview. We deliberately do NOT fall back to a
	// global req-number lookup: req numbers are only unique WITHIN a company, so a global match could
	// wrongly merge a different employer that reused the same number.
	if (matches.length === 0) return undefined;

	// Confirm which candidates are the SAME employer, not just first-word twins ("Epic" vs "Epic Kids"):
	//   Step 2 — the sender's real company domain matches a candidate's stored domain (strongest signal;
	//            also bridges name spellings, e.g. "JPMorgan" ↔ "JPMorganChase" from jpmorgan.com).
	//   Step 3 — otherwise, same entity by name (exact, or differ only by a generic corporate/industry
	//            descriptor). A candidate with a DIFFERENT real domain is a hard "different company" —
	//            descriptor similarity must not override it.
	//   Step 4 — nothing confirmed → undefined (new entry).
	const byDomain = domain ? matches.filter(m => m.company_domain === domain) : [];
	if (byDomain.length) {
		matches = byDomain;
	} else {
		matches = matches.filter(m =>
			companiesSameEntity(m.company, company) && (!domain || !m.company_domain || m.company_domain === domain),
		);
		if (matches.length === 0) return undefined;
	}

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

	// Fall back to the role string.
	if (matches.length === 1) return rolesCompatible(matches[0].role, role) ? matches[0] : undefined;
	if (role) {
		const norm = (r: string | null) => (r ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
		const exactRole = matches.find(m => norm(m.role) === norm(role));
		if (exactRole) return exactRole;
		const compatible = matches.filter(m => rolesCompatible(m.role, role));
		return compatible.length ? oldest(compatible) : undefined;
	}
	return oldest(matches);
}

/** The auto-detection note for an application, flagging when the role still needs manual entry. */
function gmailNote(subject: string, hasRole: boolean): string {
	const base = `Auto-detected from Gmail: ${subject}`;
	return hasRole ? base : `${base}\n⚠️ Role could not be extracted — please update manually.`;
}

router.post('/sync', requireAuth, async (req: Request, res: Response) => {
	// Progress streams to the client as newline-delimited JSON: a 'start' event (with the total), a
	// 'progress' event per email, and a final 'done' event. Once streaming begins the HTTP status is
	// already 200, so a later error is reported as an 'error' event instead of a 500.
	let streaming = false;
	const send = (event: Record<string, unknown>) => res.write(JSON.stringify(event) + '\n');
	try {
        const start = Date.now();
		// 1. List matching message IDs (cheap — stubs only). 2. Drop already-synced ones BEFORE
		// fetching any bodies, so a routine sync downloads only what's new. 3. Stream bodies one batch
		// at a time and discard each after use — peak memory is one batch. Processing order is
		// irrelevant: the merge keys on each email's precise internalDate (status/note = latest,
		// date_applied = earliest), so newest- or oldest-first yields the same result.
		// Scan window chosen per request (the 30/60/90/180 picker), defaulting to 30. Widening it is
		// safe — skip-synced backfills only the newly in-range emails. Values outside the allow-list
		// are ignored to bound fetch cost.
		const ALLOWED_DAYS = [30, 60, 90, 180];
		const requested    = Number(req.body?.days ?? req.query?.days);
		const days         = ALLOWED_DAYS.includes(requested) ? requested : 30;
		console.log(`[sync] scan window: ${days} days`);

		const allIds   = await listJobMessageIds(req.session.tokens!, days);
		const syncedIds = await db.getSyncedMessageIds(allIds);
		const newIds   = allIds.filter(id => !syncedIds.has(id));
		const failedIds: string[] = [];   // messages that errored on fetch — not synced, retried next run
		let added = 0, updated = 0, skipped = allIds.length - newIds.length, linkedinApplyParsed = 0, linkedinRejectParsed = 0, indeedParsed = 0, generalParsed = 0;
		console.log(`[sync] ${newIds.length} new of ${allIds.length} (skipped ${skipped} already-synced before fetch)`);

		res.setHeader('Content-Type', 'application/x-ndjson');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('X-Accel-Buffering', 'no');   // don't let a proxy buffer the progress stream
		streaming = true;
		send({ phase: 'start', processed: 0, total: newIds.length, added: 0, updated: 0, skipped });

		let processed = 0;
		for await (const email of streamJobMessages(req.session.tokens!, newIds, failedIds)) {
			const { threadId, messageId, subject, from, body } = email;
			processed++;
			send({ phase: 'progress', processed, total: newIds.length, added, updated, skipped });

			// Hard-filter obvious non-job emails before calling the LLM.
			if (AUTOMATED_SUBJECT.test(subject) || AUTOMATED_FROM.test(from)) {
				console.log(`[sync] skip (auto-filtered) subject="${subject}"`);
				await db.markEmailSynced({ thread_id: threadId, message_id: messageId, classified_as: 'ignored' });
				skipped++;
				continue;
			}

			// Try deterministic parser first — covers ~50-60% of emails (LinkedIn, Indeed, Workday)
			// with zero AI cost. Falls back to the LLM for everything else.
			let classification = parseEmail(subject, from, body);
			const detectedBy: 'parser' | 'llm' = classification ? 'parser' : 'llm';   // which path handled this email

			if (!classification) {
				try {
					classification = await classifyEmail(subject, from, body);
				} catch (err) {
					// Mark synced so a malformed LLM response isn't retried on every subsequent sync.
					console.error(`[classify] error for subject="${subject}":`, err);
					await db.markEmailSynced({ thread_id: threadId, message_id: messageId, classified_as: 'ignored' });
					skipped++;
					continue;
				}

				// The LLM is the SOURCE OF TRUTH for company/role on this path. The deterministic regex only
				// FILLS GAPS — when the LLM returned null — and never overrides a value the LLM produced.
				// (Overriding used to corrupt correct answers, e.g. truncate "Sherpa 6" → "Sherpa".) The
				// normalize/tidy/fallback steps below then canonicalize whatever value we end up with.
				if (classification.category !== 'ignored' && (!classification.company || !classification.role)) {
					const ext = extractGeneralCompanyRole(subject, body);
					if (!classification.company && ext) classification.company = ext.company;
					if (!classification.role) classification.role = ext?.role ?? recoverRoleFromBody(body, subject);
				}
			}

			// Tidy the final role (parser- or LLM-sourced) so an AI-included req/ID or location tail
			// ("Integration Services Developer (reference number: 771221)") doesn't reach the record.
			if (classification.role) classification.role = tidyRole(classification.role) || null;
			const { category, role, classifier_code } = classification;
			let { company } = classification;

            if (classifier_code === 'linkedin_applied') linkedinApplyParsed++;
            if (classifier_code === 'linkedin_rejected') linkedinRejectParsed++;
            if (classifier_code === 'indeed_applied') indeedParsed++;
            if (classifier_code === 'general_template') generalParsed++;

			// If the LLM couldn't identify the company, fall back to parsing the sender domain
			// (e.g. "noreply@walmart.com" → "Walmart").
			if (!company && category !== 'ignored') {
				const domainCompany = extractCompanyFromSender(from);
				if (domainCompany) {
					console.log(`[sync] company from domain fallback: "${domainCompany}" subject="${subject}"`);
					company = domainCompany;
				} else {
					// Domain is an ATS/generic host. Last resort: the sender's display name with its
					// HR/ATS suffix stripped ("RTX Workday Notifications" → "RTX").
					const nameCompany = extractCompanyFromSenderName(from);
					if (nameCompany) {
						console.log(`[sync] company from sender-name fallback: "${nameCompany}" subject="${subject}"`);
						company = nameCompany;
					}
				}
			}

			// Normalize legal suffixes for consistent dedup.
			if (company) company = normalizeCompany(company);

			// HackerRank's assessment product (hackerrankforwork.com) sends coding tests ON BEHALF OF an
			// employer and sometimes names itself as the company. Drop "HackerRank" as a company ONLY
			// when the email is from that product domain — a genuine application to HackerRank itself
			// (e.g. careers@hackerrank.com) comes from a different domain and keeps its real name.
			if (company && /^hacker\s?rank\b/i.test(company) && /hackerrankforwork\.(?:com|io)/i.test(from)) {
				console.log(`[sync] drop assessment-platform name as company: "${company}" subject="${subject}"`);
				company = null;
			}

			if (category === 'ignored' || !company) {
				console.log(`[sync] skip (category=${category} company=${company}) subject="${subject}"`);
				await db.markEmailSynced({ thread_id: threadId, message_id: messageId, classified_as: 'ignored' });
				skipped++;
				continue;
			}

			const externalId = extractJobNumber(subject, body);
			// Real company domain (null for ATS/job-board senders) — an extra safeguard for matching and a
			// stored signal that disambiguates first-word twins on future syncs.
			const senderDomain = companyDomainFromSender(from);
			const existing = await findExisting(company, role, externalId, senderDomain);

			if (existing) {
				// "Newest wins" (status, last_activity, auto note) and "earliest wins" (date_applied) are
				// decided by the email's precise internalDate, not the day-string — so same-day emails
				// order correctly and processing order never matters.
				// Newest wins by precise send time (epoch), so same-day emails order correctly and
				// processing order never matters. ts 0 means "no recorded activity", so any email is
				// correctly treated as newer.
				const isNewer   = email.internalDate >= existing.last_activity_ts;
				const isEarlier = !existing.date_applied || email.lastMessageDate < existing.date_applied;
				// Upgrade "Unknown Role" when this email provides a specific role
				// (e.g. a BAE Systems status update naming the role after a generic confirmation).
				const roleUpgrade = existing.role === 'Unknown Role' && role
					? { role, lookup_key: buildLookupKey(company, role) }
					: {};
				const effectiveRole = existing.role === 'Unknown Role' && role ? role : existing.role;
				// The newest email owns status, last_activity, and the auto note (a 'manual' note is
				// never overwritten).
				const newerUpdate = isNewer
					? {
						status: category,
						last_activity: email.lastMessageDate,
						last_activity_ts: email.internalDate,
						detected_by: detectedBy,   // record how the newest (status-driving) email was classified
						...(existing.notes_source !== 'manual'
							? { notes: gmailNote(subject, effectiveRole !== 'Unknown Role') }
							: {}),
					}
					: {};
				// Sticky: any interview/offer email marks the app as having reached interview — even if
				// a later rejection becomes the current status. Only ever set true.
				const reachedUpdate = (category === 'interview' || category === 'offer') && !existing.reached_interview
					? { reached_interview: true }
					: {};
				// Backfill the req/job number if this email has one and the record doesn't yet.
				const externalIdUpdate = externalId && !existing.external_id ? { external_id: externalId } : {};
				// Backfill the company domain once a real company email arrives for a record first created
				// from an ATS/job-board sender (so later syncs can match by domain).
				const domainUpdate = senderDomain && !existing.company_domain ? { company_domain: senderDomain } : {};
				const merged = {
					...newerUpdate,
					...(isEarlier ? { date_applied: email.lastMessageDate } : {}),
					...roleUpgrade,
					...reachedUpdate,
					...externalIdUpdate,
					...domainUpdate,
				};
				if (Object.keys(merged).length) await db.update(existing.id, merged);
				updated++;
			} else {
				await db.create({
					company,
					role:            role ?? 'Unknown Role',
					status:          category,
					interview_step:  null,
					reached_interview: category === 'interview' || category === 'offer',
					date_applied:    email.lastMessageDate,
					last_activity:   email.lastMessageDate,
					last_activity_ts: email.internalDate,
					job_url:         null,
					notes:           gmailNote(subject, !!role),
					external_id:     externalId,
					detected_by:     detectedBy,
					company_domain:  senderDomain,
					source:          'gmail',
					gmail_thread_id: threadId,
				});
				added++;
			}

			await db.markEmailSynced({ thread_id: threadId, message_id: messageId, classified_as: category });
		}
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        const failed = failedIds.length;
        if (failed) console.warn(`[sync] ${failed} message(s) could not be fetched — NOT marked synced, will be retried next sync: ${failedIds.join(', ')}`);
        console.log(`[sync] completed: ${added} added, ${updated} updated, ${skipped} skipped${failed ? `, ${failed} failed` : ''} (LinkedIn applied parsed: ${linkedinApplyParsed}, LinkedIn rejected parsed: ${linkedinRejectParsed}, Indeed parsed: ${indeedParsed}, General template parsed: ${generalParsed})`);
        console.log(`[sync] duration: ${duration} seconds`);

		send({ phase: 'done', added, updated, skipped, failed });
		res.end();
	} catch (err) {
		console.error('Sync error:', err);
		if (streaming) { send({ phase: 'error', error: errMsg(err, 'Unknown error') }); res.end(); }
		else res.status(500).json({ error: 'Sync failed: ' + errMsg(err, 'Unknown error') });
	}
});

export default router;
