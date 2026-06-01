import type { Classification } from '../types';

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

// A company name is a "proper-noun run": one or more capitalized tokens joined by spaces or by
// a name connector (and / of / the / &). The run ends at the first lowercase word that isn't a
// connector — exactly where the name stops and the sentence prose begins. We capture broadly in
// the patterns (up to punctuation) then TRIM to this run here, which salvages the name instead
// of discarding the whole capture (so no prose denylist is needed):
//   "Vanta and for your interest…"        → "Vanta"                    (stops at lowercase "for")
//   "Public Health Solutions has been…"   → "Public Health Solutions"  (stops at "has")
//   "Bank of America was received"        → "Bank of America"          (keeps "of" connector)
//   "The New York Times - Software Eng…"  → "The New York Times"       (stops at " - ")
// The trim is case-SENSITIVE on purpose, so it must not run under a /i regex.
const PROPER_NOUN_RUN = /^[A-Z][\w.&'()/-]*(?:\s+(?:(?:and|of|the|&)\s+)?[A-Z][\w.&'()/-]*)*/;

const GEN_CO  = '([^.,!?\\n]+?)';                            // capture stays within one sentence
const GEN_END = '(?=[.,!?\\n]|$)';

/** Trim the capture to its leading proper-noun run, then reject req numbers / bad length. */
function cleanGeneralCompany(s: string | null | undefined): string | null {
	if (!s) return null;
	const run = s.trim().match(PROPER_NOUN_RUN);              // didn't start with a capital → not a company name
	if (!run) return null;
	s = run[0].trim();
	if (s.length < 2 || s.length > 50) return null;
	if (/^(?:req)?\d|^[A-Z]{0,4}\d{3,}/.test(s)) return null;             // an uppercase req number ("REQ346977 …"), not a company
	return s;
}

/** Role: Title-cased, with trailing location modifiers stripped (requisition numbers kept). */
function cleanGeneralRole(s: string | null | undefined): string | null {
	if (!s) return null;
	s = s.replace(/^(?:the|an?|our|your)\s+/i, '').trim();
	s = s.replace(/^[A-Z][\w&.]*'s\s+/, '').trim();          // drop a company possessive: "Vestwell's QA Engineer" → "QA Engineer"
	if (!/^[A-Z0-9]/.test(s)) return null;                   // kills gerund leaks like "exploring the…"
	s = s.replace(/\s[-–]\s[A-Z][a-zA-Z.]+,\s*[A-Z]{2}\b|\s+(?:onsite|hybrid|remote)\s+[A-Z][a-zA-Z]+(?:,\s*[A-Z]{2})?/gi, '').trim();
	if (s.length < 2 || s.length > 60) return null;
	if (/\bposition\b/i.test(s)) return null;                // "Software Engineer II, Off position here" → overran
	return s;
}

/**
 * Deterministically pull company (and role when present) from the sentence
 * structures common to application-acknowledgement / rejection emails:
 *
 *   "...applying for [the] [Role] [position|role] at|with [Company]"
 *   "...your interest in [the] [Role] position at|with [Company]"
 *   "...employment with [Company] in our [Role] position"
 *   "...joining our team at [Company]"
 *   "...applying to | application to | apply at [Company]"     (company only)
 *
 * Regex beats the LLM here: it never hallucinates, preserves exact requisition
 * numbers, and is reproducible. Returns null (defer to the LLM) when no structure
 * matches or the captured company fails validation. Exported so the sync loop can
 * override the LLM's company/role on the AI-status path.
 */
export function extractGeneralCompanyRole(subject: string, body: string): { company: string; role: string | null } | null {
	const text = `${subject}\n${body}`;
	// Not applications: demographic surveys and "finish your draft" reminders.
	if (/\b(demographic|survey)\b/i.test(text)) return null;
	if (/keep track of your application|still working on the application|if you have completed the application/i.test(body)) return null;

	let company: string | null = null;
	let role:    string | null = null;
	let m: RegExpMatchArray | null;

	// 1. applying for [the] [role|position of] [Role] [position|role] at|with [Company]
	m = text.match(new RegExp(`\\b(?:applying|application|apply) for (?:the\\s+|an?\\s+)?(?:(?:role|position) of\\s+)?([^.!?\\n]+?)(?:\\s+(?:position|role))?\\s+(?:at|with)\\s+${GEN_CO}${GEN_END}`, 'i'));
	if (m) { role = m[1]; company = m[2]; }

	// 2. your interest in [the] [Role] position at|with [Company]
	if (!company) { m = text.match(new RegExp(`your interest in (?:the\\s+|an?\\s+)?([^.!?\\n]+?)\\s+position\\s+(?:at|with)\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) { role = m[1]; company = m[2]; } }

	// 3. employment with [Company] in our [Role] position
	if (!company) { m = text.match(new RegExp(`employment with\\s+${GEN_CO}\\s+in our\\s+([^.!?\\n]+?)\\s+position`, 'i')); if (m) { company = m[1]; role = m[2]; } }

	// 4. joining our team at [Company]
	if (!company) { m = text.match(new RegExp(`joining our team at\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) company = m[1]; }

	// 5. applying to | application to | apply at [Company]   (company only)
	if (!company) { m = text.match(new RegExp(`\\b(?:applying to|application to|apply at)\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) company = m[1]; }

	const cleanCompany = cleanGeneralCompany(company);
	if (!cleanCompany) return null;

	// Role recovery: the company-only patterns (4, 5) don't capture a role, but the body
	// usually names it as "...for/to [the|our] [Role] role|position" or "position of [Role]".
	// cleanGeneralRole validates the capture, so a bad grab becomes null rather than garbage.
	let cleanRole = cleanGeneralRole(role);
	if (!cleanRole) {
		// [A-Z] anchor on the capture skips the wrong "for" in "thank you FOR applying TO our [Role]…".
		const r1 = body.match(/\b(?:for|to|exploring)\s+(?:the\s+|our\s+|your\s+|a\s+)?([A-Z][^.!?\n]*?)\s+(?:role|position|opportunity)\b/);
		const r2 = body.match(/\b(?:position|role) of\s+([A-Z][^.!?\n]*?)(?=[.!?,]|\s+(?:has|have|is|was|at|with|on)\b|$)/);
		cleanRole = cleanGeneralRole(r1?.[1]) ?? cleanGeneralRole(r2?.[1]);
	}
	return { company: cleanCompany, role: cleanRole };
}

// Strong, unambiguous status phrases mined from the real corpus (each ~0% in the
// opposite class). "if"-conditional sentences are skipped for rejection because
// applied confirmations routinely say "if you're not selected…".
// NOTE: bare "unfortunately" is deliberately NOT here — it appears in applied emails too
// ("unfortunately we can't give status updates"). Rejection needs an explicit action phrase.
const GENERAL_REJECT  = /regret to inform|not be proceeding|other candidates|pursue other|mov(?:e|ing) forward with (?:other )?(?:candidates|applicants)|\b(?:not|won'?t|will not|unable to|cannot|can'?t)\s+(?:be\s+|to\s+)?(?:mov(?:e|ing)\s+forward|progress|proceed)\b|\bnot\s+selected\b|decided to (?:go|proceed) with|will not be progressing|selected (?:a|the|another) candidate|position has (?:now )?been filled/i;
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

// ── Public API ────────────────────────────────────────────────────────────────

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
