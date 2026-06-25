// ── General template + the parseEmail dispatcher ────────────────────────────
// The general (non-platform) acknowledgement/rejection template, plus the dispatcher that runs
// every deterministic parser in order. Platform-specific extractors live in their own modules
// (./linkedin, ./indeed) — each owns one fast-apply platform's exact format.

import type { Classification } from '../../types';
import { extractGeneralCompanyRole } from './companyRole';
import { parseLinkedIn } from './linkedin';
import { parseIndeed } from './indeed';

// ── General template ────────────────────────────────────────────────────────────

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
// Company, category, and role for Workday emails are all left to the AI classifier,
// whose prompt knows the branded-subdomain rule (e.g. "ms@myworkday.com" → "Morgan Stanley").

// ── Dispatcher ──────────────────────────────────────────────────────────────────

// Each fast-apply platform owns its own extractor module; the general template is the catch-all.
// To support a new platform, add its parser module and slot it in here before the general one.
const PARSERS = [
	parseLinkedIn,
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
 * so there is no reliable platform-level pattern; the AI classifier handles those.
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
