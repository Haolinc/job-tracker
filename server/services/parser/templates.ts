// ── Template parsers + the parseEmail dispatcher ────────────────────────────
// Deterministic parsers (LinkedIn, Indeed, general) — classify the ~50-60% of mail matching a known
// shape with no AI cost.

import type { Classification } from '../../types';
import { extractGeneralCompanyRole } from './companyRole';

// ── Helpers ───────────────────────────────────────────────────────────────────

function senderEmail(from: string): string {
	return (from.match(/<([^>]+)>/)?.[1] ?? from.match(/\S+@\S+/)?.[0] ?? '').toLowerCase();
}

// ── Template parsers ──────────────────────────────────────────────────────────

/**
 * LinkedIn Easy Apply confirmation.
 * Subject: "[Name], your application was sent to [Company]"
 * From:    jobs-noreply@linkedin.com
 * Body:    "Your application was sent to [Company]\n\n[Role]\n[Company]\n[Location]\n..."
 */
function parseLinkedInApplied(subject: string, from: string, body: string): Classification | null {
	if (!senderEmail(from).endsWith('jobs-noreply@linkedin.com')) return null;

	const companyMatch = subject.match(/your application was sent to (.+)$/i);
	if (!companyMatch) return null;

	const company = companyMatch[1].trim();

	// cleanBody() always collapses whitespace before the body reaches the parser, so the
	// LinkedIn body arrives as a single line:
	//   "Your application was sent to [Company] [Role] [Company] [Location] ..."
	// Extract the role as the text between the first and second occurrence of the company name.
	const esc  = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const m    = body.match(new RegExp(`was sent to\\s+${esc}\\s+(.+?)\\s+${esc}`, 'i'));
	const role = m?.[1]?.trim() ?? null;

	return { category: 'applied', company, role, classifier_code: 'linkedin_applied' };
}

/**
 * LinkedIn rejection notification.
 * Subject: "Your application to [Role] at [Company]"
 * From:    jobs-noreply@linkedin.com
 * Body:    "Your update from [Company] ..."
 *
 * Uses lastIndexOf(' at ') so company names containing " at " (e.g. "AI at Scale") parse correctly.
 */
function parseLinkedInRejected(subject: string, from: string, body: string): Classification | null {
	if (!senderEmail(from).endsWith('jobs-noreply@linkedin.com')) return null;
	if (!/^your application to /i.test(subject)) return null;
	if (!/your update from /i.test(body)) return null;

	const rest   = subject.slice('your application to '.length);
	const lastAt = rest.lastIndexOf(' at ');
	if (lastAt < 0) return null;

	return {
		category: 'rejected',
		role:     rest.slice(0, lastAt).trim(),
		company:  rest.slice(lastAt + 4).trim(),
        classifier_code: 'linkedin_rejected'
	};
}

/**
 * Indeed Easy Apply confirmation.
 * Subject: "Indeed Application: [Role]"
 * From:    indeedapply@indeed.com
 * Body:    gmailService.buildBody() prepends "Employer: [Company]\n\n" for Indeed emails.
 */
function parseIndeed(subject: string, from: string, body: string): Classification | null {
	if (!senderEmail(from).includes('indeedapply@indeed.com')) return null;

	const roleMatch = subject.match(/^Indeed Application:\s*(.+)$/i);
	if (!roleMatch) return null;

	const company = body.match(/^Employer:\s*(.+)/im)?.[1]?.trim() ?? null;

	// If buildBody() didn't find the employer in the HTML, company is unknown.
	// indeed.com is in ATS_DOMAINS so the domain fallback won't help either —
	// fall through to AI rather than silently saving with a null company.
	if (!company) return null;

	return { category: 'applied', company, role: roleMatch[1].trim(), classifier_code: 'indeed_applied' };
}

// Strong, unambiguous status phrases mined from the real corpus (each ~0% in the
// opposite class). "if"-conditional sentences are skipped for rejection because
// applied confirmations routinely say "if you're not selected…".
// NOTE: bare "unfortunately" is deliberately NOT here — it appears in applied emails too
// ("unfortunately we can't give status updates"). Rejection needs an explicit action phrase.
const GENERAL_REJECT  = /regret to inform|not be proceeding|other candidates|pursue other|mov(?:e|ing) forward with (?:other )?(?:candidates|applicants)|\b(?:not|won'?t|will not|unable to|cannot|can'?t)\s+(?:be\s+|to\s+)?(?:mov(?:e|ing)\s+forward|progress|proceed)\b|\bnot\s+selected\b|decided to (?:go|proceed) with|will not be progressing|selected (?:a|the|another) candidate|\bbeen filled\b|\b(?:is|was|now)\s+filled\b|\bno longer hiring\b/i;
const GENERAL_APPLIED = /received your application|application (?:has been|was) received|we will review|we'?ll review|under review|currently reviewing|reviewing your (?:application|profile)|will be in touch|get back to you|look forward to reviewing|if your (?:qualifications|skills|background|experience)|if there (?:is|'?s) a (?:match|fit|potential)|confirm receipt|has been (?:submitted|received)|status of your application|successfully (?:submitted|received|applied)/i;

/** Returns a status only when keywords are decisive; null means "ask the LLM". */
function generalStatus(body: string): 'applied' | 'rejected' | null {
	if (body.split(/(?<=[.!?])\s+/).some(s => GENERAL_REJECT.test(s) && !/\bif\b/i.test(s))) return 'rejected';
	if (GENERAL_APPLIED.test(body)) return 'applied';
	return null;
}

/**
 * General application template. Splits the work by each tool's strength:
 * regex owns company/role extraction (accurate, reproducible), keyword matching
 * owns the clear-cut status calls. Fires a complete deterministic result only
 * when BOTH succeed; otherwise returns null so the sync loop falls back to the
 * LLM for status (still overriding its company/role via extractGeneralCompanyRole).
 *
 * Validated against the real sync corpus: 0 status false-positives, company/role
 * equal-to-or-more-accurate than the LLM on every fired case.
 */
function parseGeneralApplicationPattern(subject: string, from: string, body: string): Classification | null {
	const extracted = extractGeneralCompanyRole(subject, body);
	if (!extracted) return null;

	const status = generalStatus(body);
	if (!status) return null;                                // company/role known, status ambiguous → LLM

	return { category: status, company: extracted.company, role: extracted.role, classifier_code: 'general_template' };
}

// Workday (*@myworkday.com) is intentionally NOT parsed here.
// Each company customises their Workday email template independently, so there
// is no reliable platform-level subject or body pattern to match against.
// The company is still recovered correctly for all Workday emails via the
// extractCompanyFromSender() domain-fallback in routes/gmail.ts, which reads
// the branded subdomain (e.g. "tmobile@myworkday.com" → "Tmobile").
// Category and role extraction is handled by the AI classifier.

// ── Dispatcher ──────────────────────────────────────────────────────────────────

const PARSERS = [
	parseLinkedInApplied,
	parseLinkedInRejected,
	parseIndeed,
	parseGeneralApplicationPattern,
] as const;

/**
 * Try to classify an email deterministically without calling the AI.
 *
 * Returns a Classification if a known high-volume template matches, or null
 * if the email should fall through to the AI classifier.
 *
 * Covered templates:
 *   • LinkedIn Easy Apply confirmations      (~30–40 % of emails)
 *   • LinkedIn rejection notifications       (~15–20 % of emails)
 *   • Indeed Easy Apply confirmations        (~10 % of emails)
 *   • General "Thank you for your interest" templates (~5–10 % of emails)
 *
 * Workday is intentionally excluded — each company customises the template
 * so there is no reliable platform-level pattern. Company is still recovered
 * via the extractCompanyFromSender() subdomain fallback in routes/gmail.ts.
 */
export function parseEmail(subject: string, from: string, body: string): Classification | null {
	for (const parser of PARSERS) {
		const result = parser(subject, from, body);
		if (result) {
			console.log(`[parser] hit subject="${subject}" → ${result.category} company="${result.company}" role="${result.role}" classifier_code="${result.classifier_code ? result.classifier_code : 'none'}"`);
			return result;
		}
	}
	return null;
}
