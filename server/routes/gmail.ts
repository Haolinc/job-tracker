import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { fetchJobEmails } from '../services/gmailService';
import { classifyEmail } from '../services/classifier';
import { parseEmail, extractGeneralCompanyRole } from '../services/parser';
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
	'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
]);

// Strips trailing legal suffixes so e.g. "Sun West Mortgage Company" and
// "Sun West Mortgage" resolve to the same dedup key.
// The lookbehind (?<=\w) prevents matching " Co." in "Foo & Co." (which would
// leave a broken trailing "&") — only strip when preceded by a word character.
const COMPANY_SUFFIX_RE = /(?<=\w)[,.]?\s+(?:company|incorporated|inc\.?|llc|ltd\.?|corp\.?|corporation|co\.)$/i;

function normalizeCompany(name: string): string {
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

/**
 * Find the existing DB entry to update, using the following strategy:
 *  - Role known  → exact company + role match.
 *  - Role unknown, one entry for this company → must be the same application.
 *  - Role unknown, multiple entries → update the "Unknown Role" entry if one exists.
 *
 * Returns:
 *  - Application  → update it
 *  - undefined    → no match, create a new entry
 *  - null         → multiple known-role entries; can't determine which one — skip
 */
async function findExisting(
	company: string,
	role: string | null,
): Promise<Application | undefined | null> {
	if (role) {
		// Primary: O(1) indexed lookup via the pre-computed compound key.
		const byKey = await db.findByLookupKey(buildLookupKey(company, role));
		if (byKey) return byKey;
		// Fallback: regex scan for entries that predate the lookup_key field
		// (manually added records, or entries created before the migration ran).
		const byCompanyRole = await db.findByCompanyRole(company, role);
		if (byCompanyRole) return byCompanyRole;

		// Last resort: if the only existing entry for this company is "Unknown Role",
		// this email is providing the role that was missing from the confirmation email
		// (e.g. BAE Systems sends a generic confirmation with no role, then a follow-up
		// "Application Update" that names the role). Upgrade rather than duplicate.
		const allForCompany = await db.findByCompany(company);
		if (allForCompany.length === 1 && allForCompany[0].role === 'Unknown Role') {
			return allForCompany[0];
		}
		return undefined;
	}

	const matches = await db.findByCompany(company);
	if (matches.length === 0) return undefined;
	if (matches.length === 1) return matches[0];
	return matches.find(m => m.role === 'Unknown Role') ?? null;
}

router.post('/sync', requireAuth, async (req: Request, res: Response) => {
	try {
        const start = Date.now();
		const emails    = await fetchJobEmails(req.session.tokens!);
		const syncedIds = await db.getSyncedMessageIds(emails.map(e => e.messageId));
		let added = 0, updated = 0, skipped = 0, linkedinApplyParsed = 0, linkedinRejectParsed = 0, indeedParsed = 0, generalParsed = 0;

		for (const email of emails) {
			const { threadId, messageId, subject, from, body } = email;

			if (syncedIds.has(messageId)) {
				console.log(`[sync] skip (already synced) subject="${subject}"`);
				skipped++;
				continue;
			}

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

				// The LLM decided status; trust deterministic regex for company/role when it
				// can extract them (preserves exact req numbers, no hallucination).
				if (classification.category !== 'ignored') {
					const ext = extractGeneralCompanyRole(subject, body);
					if (ext) {
						classification.company = ext.company;
						if (ext.role) classification.role = ext.role;
					}
				}
			}

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
				}
			}

			// Normalize legal suffixes for consistent dedup.
			if (company) company = normalizeCompany(company);

			if (category === 'ignored' || !company) {
				console.log(`[sync] skip (category=${category} company=${company}) subject="${subject}"`);
				await db.markEmailSynced({ thread_id: threadId, message_id: messageId, classified_as: 'ignored' });
				skipped++;
				continue;
			}

			const existing = await findExisting(company, role);

			// null → multiple known-role entries; ambiguous, cannot dedup safely.
			if (existing === null) {
				await db.markEmailSynced({ thread_id: threadId, message_id: messageId, classified_as: 'ignored' });
				skipped++;
				continue;
			}

			if (existing) {
				// The most recent email wins — it reflects the true current status.
				const isNewer = email.lastMessageDate >= (existing.last_activity ?? '');
				// Also upgrade "Unknown Role" when this email provides a specific role
				// (e.g. a BAE Systems status update naming the role after a generic confirmation).
				const roleUpgrade = existing.role === 'Unknown Role' && role
					? { role, lookup_key: buildLookupKey(company, role) }
					: {};
				await db.update(existing.id, {
					status:        isNewer ? category : existing.status,
					last_activity: isNewer ? email.lastMessageDate : existing.last_activity,
					...roleUpgrade,
				});
				updated++;
			} else {
				const resolvedRole = role ?? 'Unknown Role';
				const notes = role
					? `Auto-detected from Gmail: ${subject}`
					: `Auto-detected from Gmail: ${subject}\n⚠️ Role could not be extracted — please update manually.`;
				await db.create({
					company,
					role:            resolvedRole,
					status:          category,
					interview_step:  null,
					date_applied:    email.lastMessageDate,
					last_activity:   email.lastMessageDate,
					job_url:         null,
					notes,
					source:          'gmail',
					gmail_thread_id: threadId,
				});
				added++;
			}

			await db.markEmailSynced({ thread_id: threadId, message_id: messageId, classified_as: category });
		}
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        console.log(`[sync] completed: ${added} added, ${updated} updated, ${skipped} skipped (LinkedIn applied parsed: ${linkedinApplyParsed}, LinkedIn rejected parsed: ${linkedinRejectParsed}, Indeed parsed: ${indeedParsed}, General template parsed: ${generalParsed})`);
        console.log(`[sync] duration: ${duration} seconds`);
        
		res.json({ added, updated, skipped });
	} catch (err) {
		console.error('Sync error:', err);
		res.status(500).json({ error: 'Sync failed: ' + errMsg(err, 'Unknown error') });
	}
});

export default router;
