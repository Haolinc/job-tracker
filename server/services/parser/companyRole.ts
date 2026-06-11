// ── Company (+ role) extraction from email sentence structures ───────────────
// Deterministic and reproducible — never hallucinated, unlike the LLM. Uses ./roles for the role.

import { cleanGeneralRole, recoverRoleFromBody } from './roles';

// A company name is a "proper-noun run": one or more capitalized tokens joined by spaces or by
// a name connector (and / of / the / &). The run ends at the first lowercase word that isn't a
// connector — exactly where the name stops and the sentence prose begins. We capture broadly in
// the patterns (up to punctuation) then TRIM to this run here, which salvages the name instead
// of discarding the whole capture (so no prose denylist is needed):
//   "Vanta and for your interest…"        → "Vanta"                    (stops at lowercase "for")
//   "Public Health Solutions has been…"   → "Public Health Solutions"  (stops at "has")
//   "Bank of America was received"        → "Bank of America"          (keeps "of" connector)
//   "The New York Times - Software Eng…"  → "The New York Times"       (stops at " - ")
//   "Sherpa 6. We really…"                → "Sherpa 6"                  (keeps a numeric token)
// Continuation tokens may start with a DIGIT so number-bearing names survive ("Sherpa 6", "Section 8");
// otherwise "Sherpa 6" truncated to "Sherpa" and failed to merge with the un-truncated form.
// The trim is case-SENSITIVE on purpose, so it must not run under a /i regex.
const PROPER_NOUN_RUN = /^[A-Z][\w.&'()/-]*(?:\s+(?:(?:and|of|the|&)\s+)?[A-Z0-9][\w.&'()/-]*)*/;

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
	if (/^req(?:uisition)?\b/i.test(s)) return null;                     // "Req 93091 …" / "Requisition …" is a job ref, not a company (e.g. "applying to Req 93091 - QA Tester")
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
export function extractGeneralCompanyRole(subject: string, body: string): { company: string; role: string | null; roleConfident: boolean } | null {
	const text = `${subject}\n${body}`;
	// Not applications: demographic surveys and "finish your draft" reminders.
	if (/\b(demographic|survey)\b/i.test(text)) return null;
	if (/keep track of your application|still working on the application|if you have completed the application/i.test(body)) return null;

	let company: string | null = null;
	let role:    string | null = null;
	let m: RegExpMatchArray | null;

	// 0. "[Company]: Thank you for applying to [the] [Role] job" — Workday system emails whose BODY is an
	// unrendered stub ("THIS IS A SYSTEM-GENERATED EMAIL"); the subject carries both company and role.
	m = subject.match(/^(.+?):\s*Thank you for applying to (?:the\s+)?(.+?)\s+job\b/i);
	if (m) { company = m[1]; role = m[2]; }

	// 1. applying for [the] [role|position of] [Role] [position|role] at|with [Company]
	m = text.match(new RegExp(`\\b(?:applying|application|apply) for (?:the\\s+|an?\\s+)?(?:(?:role|position) of\\s+)?([^.!?\\n]+?)(?:\\s+(?:position|role))?\\s+(?:at|with)\\s+${GEN_CO}${GEN_END}`, 'i'));
	if (m) { role = m[1]; company = m[2]; }

	// 1b. application to [the] [Role] opening|position|role at|with [Company]
	// ("...your application to the QA Automation Engineer opening with SS&C Technologies Inc.")
	if (!company) { m = text.match(new RegExp(`\\b(?:applying|application|applied|apply) to (?:the\\s+|an?\\s+)?([^.!?\\n]+?)\\s+(?:opening|position|role|opportunity)\\s+(?:at|with)\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) { role = m[1]; company = m[2]; } }

	// 2. your interest in [the] [Role] position|opportunity|opening|role at|with [Company]
	// ("...interest in the Software Engineer (NYC) opportunity at PermitFlow", "...the Engineer,
	// Product Integration (Paisly) opportunity at JetBlue")
	if (!company) { m = text.match(new RegExp(`your interest in (?:the\\s+|an?\\s+)?([^.!?\\n]+?)\\s+(?:position|opportunity|opening|role)\\s+(?:at|with)\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) { role = m[1]; company = m[2]; } }

	// 3. employment with [Company] in our [Role] position
	if (!company) { m = text.match(new RegExp(`employment with\\s+${GEN_CO}\\s+in our\\s+([^.!?\\n]+?)\\s+position`, 'i')); if (m) { company = m[1]; role = m[2]; } }

	// 3c. "applying to [Company] - [Role]" (subject) — the role trails the company after a SPACED dash and
	// often holds a comma the sentence-bounded patterns above can't keep ("The New York Times - Software
	// Engineer, Programming"). Spaces around the dash are required, so hyphenated names ("Coca-Cola") don't split.
	if (!company) { m = subject.match(/\b(?:applying to|application to|apply to|your application to)\s+(.+?)\s+[-–]\s+(.+)$/i); if (m) { company = m[1]; role = m[2]; } }

	// 3d. "Application received by [Company]" (subject) — for emails whose BODY is an unrendered junk
	// template ("*---*---*"); the subject still names the employer ("Application received by City of Scottsdale").
	if (!company) { m = text.match(new RegExp(`\\breceived by\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) company = cleanGeneralCompany(m[1]); }

	// 3b. [Company] has received your application   (company only) — Ashby/greenhouse confirmations
	// ("Thank You for Applying! Pinecone Has Received Your Application"). Runs BEFORE the "joining"
	// patterns: the clean subject signal beats a body where HTML-stripping glued words ("joining Pineconeon").
	if (!company) { m = text.match(new RegExp(`${GEN_CO}\\s+has received your application`, 'i')); if (m) company = cleanGeneralCompany(m[1]); }

	// 4. joining our team at [Company]
	if (!company) { m = text.match(new RegExp(`joining our team at\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) company = cleanGeneralCompany(m[1]); }

	// 4c. joining [the] [Company] [team]   (company only) — "interest in joining Luma!", "joining the Deltek team"
	if (!company) { m = text.match(new RegExp(`joining (?:the\\s+)?${GEN_CO}${GEN_END}`, 'i')); if (m) company = cleanGeneralCompany(m[1]); }

	// 4b. [a] career [opportunities] at [Company]   (company only) — Workday/Oracle HR confirmations:
	// "interested in a career at JPMorganChase". Deterministic so it never depends on the LLM's mood.
	if (!company) { m = text.match(new RegExp(`\\bcareer(?:\\s+opportunities)?\\s+at\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) company = cleanGeneralCompany(m[1]); }

	// 5. signature sign-off — some emails name the company ONLY in the closing line. Two forms:
	//   (a) "[Recruiting|Talent Acquisition] Team at [Company]"   ("Best, The Recruiting Team at Precision Neuroscience")
	//   (b) "[Salutation], [Company] Talent Acquisition|Recruiting" ("Kind Regards, Morgan Stanley Talent Acquisition")
	// Runs BEFORE the bare "applying to" pattern: a subject like "applying to Software Engineer" (a ROLE,
	// no company) would otherwise make that pattern grab the role and the structural guard nullify everything,
	// hiding the real company in the sign-off ("Thank you, PMC Talent Acquisition Team").
	if (!company) { m = text.match(new RegExp(`(?:Talent Acquisition|Recruiting)\\s+Team at\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) company = cleanGeneralCompany(m[1]); }
	if (!company) { m = text.match(new RegExp(`(?:Regards|Kind Regards|Best Regards|Warm Regards|Sincerely|Best|Warmly|Cheers|Thanks|Thanks again|Thank you|Many thanks|All the best),\\s+(?!(?:The|Talent|Recruiting|Recruitment|Human|People)\\b)${GEN_CO}\\s+(?:Talent Acquisition|Talent Team|Recruiting Team|Recruiting)\\b`, 'i')); if (m) company = cleanGeneralCompany(m[1]); }

	// 6. applying to | application to | apply at [Company]   (company only)
	if (!company) { m = text.match(new RegExp(`\\b(?:applying to|application to|apply at)\\s+${GEN_CO}${GEN_END}`, 'i')); if (m) company = cleanGeneralCompany(m[1]); }

	// 7. [your] interest in [Company]   (company only, LAST — broadest) — "interest in Lockheed Martin",
	// "interest in Blue Mountain Quality Resources, LLC and our …". The proper-noun-run trim + the
	// structural guard below keep this from grabbing a role phrase ("interest in the Software Engineer …").
	if (!company) { m = text.match(new RegExp(`\\b(?:your |the )?interest in ${GEN_CO}${GEN_END}`, 'i')); if (m) company = cleanGeneralCompany(m[1]); }

	const cleanCompany = cleanGeneralCompany(company);
	if (!cleanCompany) return null;

	// Structural guard: if the captured "company" is referred to as a job title in the body
	// ("...the QA Engineer I position", "...the Software Engineer role"), it's a role mis-parsed as a
	// company — defer to the LLM, which reads the real company from the body. Keys off the email's own
	// structure (the trailing position/role/opening) rather than a fixed role vocabulary, so it
	// catches any title the body confirms (e.g. "Account Executive opening") without a keyword list.
	const escaped = cleanCompany.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (new RegExp(`\\b${escaped}\\s+(?:position|role|opening|opportunity)\\b`, 'i').test(body)) return null;

	// A role captured by a primary pattern (0-3, alongside the company) is high-confidence; a role
	// scraped by the body-recovery heuristics is a low-confidence guess. The caller uses this to decide
	// whether the regex role may override a role the LLM already produced.
	let cleanRole = cleanGeneralRole(role);
	const roleConfident = !!cleanRole;
	if (!cleanRole) cleanRole = recoverRoleFromBody(body, subject);

	// Structural guard 2: the captured "company" IS the role — e.g. "…your interest in Software
	// Engineer" names no employer, so pattern 7 grabbed the role as the company. (Guard 1 misses it
	// because the role phrase has no trailing "position/role/…" marker, and it came from the subject,
	// not the body.) Defer to the LLM, which reads the real company from the body/sender.
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
	if (cleanRole && norm(cleanCompany) === norm(cleanRole)) return null;

	return { company: cleanCompany, role: cleanRole, roleConfident };
}
