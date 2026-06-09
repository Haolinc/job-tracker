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
 * Cosmetic role cleanup applied to EVERY final role (parser- or LLM-sourced): strips trailing ID /
 * requisition parentheticals and work-mode / location tails, while keeping meaningful qualifiers like
 * "(Java)", "(Maritime)", "(Remote)". Never rejects — returns the tidied string.
 */
export function tidyRole(s: string): string {
	s = s.trim();
	// LEADING requisition token the ATS/AI sometimes prepends to the title ("2026-71968 Space Force -
	// Software Engineer", "R232753 Platform Engineer"). Req-shaped = ≥5 digits with an optional short letter
	// prefix and internal hyphens. The ≥5-digit floor keeps a real year-prefixed title ("2026 Emerging
	// Talent Software Engineers") and levels ("3D Designer") intact.
	const lead = s.match(/^#?[A-Za-z]{0,4}[0-9][0-9A-Za-z-]*\s+(?=\S)/);
	if (lead && (lead[0].match(/[0-9]/g)?.length ?? 0) >= 5) s = s.slice(lead[0].length).trim();
	// Brace-wrapped id token anywhere ("Associate {TS9118550}" → "Associate").
	s = s.replace(/\s*\{[^}]*\}\s*/g, ' ').trim();
	s = s.replace(/\s*\(\s*(?:ref(?:erence)?|requisition|req|job|id|no)\b[^)]*\)\s*$/i, '').trim();   // "(reference number: 771221)", "(Req ID: …)", "(ID: 3208334)"
	s = s.replace(/\s*\(\s*#?[A-Za-z]{0,5}[-_: ]?\d[\dA-Za-z._\-/ ]*\)\s*$/, '').trim();               // pure-ID parenthetical "(500544)", "(124432BR)", "(2026-75736)"
	// trailing DASH-separated requisition id ("… Developer Platform Team - 2026-75736", "… - R28486").
	// Excludes a bare year ("- 2026") and short levels ("- L3"): needs a hyphenated number, letters+≥2 digits, or ≥5 digits.
	s = s.replace(/\s*[-–]\s*#?(?:\d{1,4}[-_]\d{2,}|[A-Za-z]{1,6}[-_]?\d{2,}|\d{5,})[A-Za-z]{0,3}$/, '').trim();
	// trailing SPACE-separated requisition id with no dash ("Software Engineer Opportunities in NJ 722493BR",
	// "… Engineer R0859802"): a 5+ digit run, or a 4+ digit run with a 1-3 letter prefix/suffix. The ≥5-digit /
	// letter-bound shape keeps real trailing numbers in titles ("Engineer 3", "Level 2") safe.
	s = s.replace(/\s+#?(?:[A-Za-z]{1,3}\d{4,}|\d{4,}[A-Za-z]{1,3}|\d{5,})$/, '').trim();
	s = s.replace(/\s+(?:onsite|hybrid|remote)\b.*$/i, '').trim();                                     // work-mode + everything after ("… Onsite Great River, NY"); "(Remote)" is safe (paren breaks the \s+ anchor)
	s = s.replace(/\s*[-–,]\s*[A-Z][A-Za-z. ]+?,\s*[A-Z]{2}\b.*$/, '').trim();                         // trailing "- City, ST" / ", City, ST"
	s = s.replace(/\s+(?:United\s+(?:States|Kingdom)|USA?|UK)\b(?:\s*\([A-Za-z]{2,3}\))?$/i, '').trim();   // trailing "… United States (US)"
	return s.replace(/[\s,\-–]+$/, '').trim();   // leftover trailing separators
}

/** Role: Title-cased, with trailing location/ID noise stripped (via tidyRole). */
function cleanGeneralRole(s: string | null | undefined): string | null {
	if (!s) return null;
	s = s.replace(/^(?:the|an?|our|your)\s+/i, '').trim();
	s = s.replace(/^[A-Z][\w&.]*'s\s+/, '').trim();          // drop a company possessive: "Vestwell's QA Engineer" → "QA Engineer"
	if (!/^(?:\([^)]*\)\s*)?[A-Z0-9]/.test(s)) return null;  // kills gerund leaks ("exploring the…"); a leading "(Entry level)" qualifier is allowed
	s = tidyRole(s);
	if (s.length < 2 || s.length > 80) return null;          // 80 (not 60) so long real titles survive ("(Entry level) Full Stack Software Engineer (LLM application Development)")
	if (/\bposition\b/i.test(s)) return null;                // "Software Engineer II, Off position here" → overran
	// Reject sentence fragments where a recovery pattern over-captured prose — verbs/auxiliaries/pronouns
	// never appear in a real job title ("Talent Acquisition team will be evaluating applications for this").
	// Case-SENSITIVE on purpose: it targets lowercase prose words, not Title-Cased role words.
	if (/\b(?:will|would|shall|be|been|being|are|is|was|were|do|does|did|have|has|had|we|us|our|you|your|they|them|their|this|that|these|those|evaluating|reviewing|received|receive|submitted|considering|currently|please|thanks)\b/.test(s)) return null;
	if (/^United\s+(?:States|Kingdom)\b/i.test(s)) return null;   // a location fragment, not a role (e.g. r3 grabbing "United States (April 2026 Start)" after an en-dash split the title)
	return s;
}

/**
 * Best-effort ROLE recovery from body prose, for emails where the company is already known but the
 * title wasn't captured by a primary structure. Patterns run most- to least-specific; cleanGeneralRole
 * validates each capture so a bad grab degrades to null rather than garbage. The result is LOW
 * CONFIDENCE by nature — callers only use it to FILL a missing role, never to override one already set.
 */
export function recoverRoleFromBody(body: string, subject = ''): string | null {
	// Subject form: "New Application Received [Role]" / "Application Received [for|:] [Role]" — the title
	// trails the phrase, often with a location tail cleanGeneralRole strips ("… United States (US)").
	const s1 = subject.match(/\b(?:new application received|application received(?:\s+for)?)\s*:?\s+(.+)$/i);
	// Subject form: "(We have received your) application for [Role]" — the title follows "application for"
	// and may carry a trailing "- <req>" (tidyRole strips it): "…application for Software Engineer, Developer Platform Team - 2026-75736".
	const s2 = subject.match(/\bapplication for\s+(?:the\s+)?(.+)$/i);
	// Subject form: "Job Application: [Name] - [req] [Role] on [date]" — iCIMS application receipts
	// ("Job Application: Hao Lin Chen - 70363 Junior Java Developer on 04/03/2026"). The title sits between
	// the dash-prefixed req number and the " on <date>" tail.
	const s4 = subject.match(/\bJob Application:.*?[-–]\s*\d+\s+([A-Z][^\n]*?)\s+on\s+\d/i);
	// Subject form: "... Update for [Role], Req #..." — status emails (BAE, T-Mobile) put the title after
	// "Update for", terminated by a comma/req-label/end rather than a "position"/"role" keyword, and may
	// prefix a req id ("Update for REQ347505 SDET Engineer"). "BAE Systems - Application Update for Entry
	// Level Software Engineer, Req #124432BR" → "Entry Level Software Engineer".
	const s3 = subject.match(/\b[Uu]pdate for\s+(?:the\s+)?(?:REQ\w*\s+)?([A-Z][^\n]*?)(?=\s*,?\s*(?:[Rr]eq|[Rr]equisition|[Jj]ob)\b|[.!?]|$)/);
	// "...position|role of [req#] [Role]" — Workday/Oracle sometimes print a req number before the title
	const r2 = body.match(/\b(?:position|role) of\s+(?:\d{5,}\s+)?([A-Z][^.!?\n]*?)(?=[.!?,]|\s+(?:has|have|is|was|at|with|on)\b|$)/);
	// "...for|to [the|our] [Role] role|position|opportunity|opening" (skip the wrong "for" in "thank you FOR applying").
	// The optional "(…)" lets a leading qualifier through ("…to the (Entry level) Full Stack Software Engineer … position").
	const r1 = body.match(/\b(?:for|to|exploring)\s+(?:the\s+|our\s+|your\s+|a\s+)?((?:\([^)]*\)\s*)?[A-Z][^.!?\n]*?)\s+(?:role|position|opportunity|opening)\b/);
	// "...in|for the [Role] role|position|opportunity" — "interest in the Associate, Software Engineer position"
	// (r1's for/to anchor sits too far left), "interest in the Software Engineer (NYC) opportunity"
	const r9 = body.match(/\b(?:in|for)\s+the\s+((?:\([^)]*\)\s*)?[A-Z][^.!?\n]*?)\s+(?:role|position|opening|opportunity)\b/);
	// "...our [open] [Role] role|position|opening" — the "interest in our … role" phrasing r1's for/to anchor misses
	const r4 = body.match(/\bour\s+(?:open\s+)?([A-Z][^.!?\n]*?)\s+(?:role|position|opening)\b/);
	// "...application for the [Role] job …" — Workable confirmations ("application for the QA Automation Engineer job was submitted")
	const r5 = body.match(/\bapplication for the\s+([A-Z][^.!?\n]*?)\s+(?:job|position|role)\b/);
	// "...applying to|application for [our] [Role], [req#]" — icims lists the title before a short req id
	// ("Specialist - Jr. Java Software Engineer, 2026-119847"). [^!?\n] (allows ".") so an abbreviation
	// period inside the title ("Jr.") doesn't truncate it — the trailing req number bounds the capture.
	const r6 = body.match(/\b(?:applying to|application for)\s+(?:the\s+|our\s+)?([A-Z][^!?\n]*?),?\s+(?:20\d{2}-)?\d{4,}\b/);
	// "...application for [Role]," — title terminated by a comma or a clause word, not a "position"/"role"
	// keyword ("received your application for Quality Assurance Automation Engineer, and we…"). Lower
	// priority than the keyword-anchored patterns above, so it only fills when they find nothing.
	const r10 = body.match(/\b(?:application|applied|apply(?:ing)?)\s+for\s+(?:the\s+|our\s+|an?\s+)?([A-Z][^.!?\n,]*?)(?=,|\s+(?:and|position|role|opening|opportunity|job|at|with|here)\b|[.!?\n]|$)/);
	// "...applying for: [Role]" — MathWorks ("Thank you for applying for: Software Engineer in Test")
	const r7 = body.match(/\bapplying for:\s*([A-Z][^.!?\n]*?)(?=\s+(?:Dear|Hi|Hello)\b|[.!?\n]|$)/);
	// "...application for: [req] [Role]" — colon form with an optional leading req token (CVS Health:
	// "received your application for: R0859802 Software Development Engineer (Open)"). The colon
	// distinguishes it from r10's no-colon form; the optional "[A-Z]{0,3}\d…" swallows a leading req id.
	const r13 = body.match(/\bapplication for:\s+(?:#?[A-Za-z]{0,3}\d[\w./-]*\s+)?([A-Z][^!?\n]*?)(?=[.!?\n]|$)/i);
	// "[Role] [8-9 digit req number]" — title right before the requisition id ("Software Engineer III - Java 210677860")
	const r3 = body.match(/\b([A-Z][A-Za-z0-9][A-Za-z0-9 ,/&()[\].+-]{2,68}?)\s+\d{8,9}\b/);
	// "following job: [Role]" / "following job(s): [Role]" / "following position(s): [Role]" — NBC Universal,
	// SAP SuccessFactors, Lockheed ATS: "...application to the following job: Software Engineer, Live and
	// Interactive", "...submitted for the following position(s): Software Engineer Opportunities in NJ 722493BR"
	const r8 = body.match(/\bfollowing\s+(?:job|position)(?:\(s\)|s)?\s*:?\s+([A-Z][^.!?\n]+?)(?=[.!?\n]|$)/i);
	// "...joining us|the team as [a] [Role]" — Talkspace ("excited that you're interested in joining us as a
	// QA Automation Engineer (AI Systems & Web Apps)")
	const r11 = body.match(/\bjoining\s+(?:us|the\s+team)\s+as\s+(?:an?\s+)?([A-Z][^.!?\n]*?)(?=[.!?\n]|$)/i);
	// "...the [Role] role|position has|since|is" — rejection/confirmation prose with no for/to/in anchor
	// ("Unfortunately, the Senior Software Engineer I, Data Enablement role has since been filled", "...and
	// the QA Automation Engineer (46_2026.1) position"). LOWEST priority — broadest, so it only fills when
	// the anchored patterns above find nothing; cleanGeneralRole rejects prose mis-captures.
	// Paren-aware capture so a parenthetical req with an inner period ("(46_2026.1)") doesn't truncate the title.
	const r12 = body.match(/\bthe\s+([A-Z](?:[^.!?\n()]|\([^)]*\))*?)\s+(?:role|position|opening|opportunity)\b/);
	// "...interest in the [Role] at|with [Company]" — no position keyword, the title sits directly before
	// "at <Company>" (Synopsys: "interest in the Validation/Verification Engineer (Computer Science Focus) -
	// Exton, PA (14923) - 14923 at Synopsys"). Paren-aware; tidyRole strips the trailing location/req tail.
	const r14 = body.match(/\binterest in the\s+([A-Z](?:[^.!?\n()]|\([^)]*\))*?)\s+(?:at|with)\s+[A-Z]/);
	return cleanGeneralRole(s1?.[1]) ?? cleanGeneralRole(s4?.[1]) ?? cleanGeneralRole(s3?.[1]) ?? cleanGeneralRole(r2?.[1]) ?? cleanGeneralRole(r1?.[1]) ?? cleanGeneralRole(r9?.[1]) ?? cleanGeneralRole(r4?.[1])
		?? cleanGeneralRole(r5?.[1]) ?? cleanGeneralRole(r8?.[1]) ?? cleanGeneralRole(r11?.[1]) ?? cleanGeneralRole(r13?.[1]) ?? cleanGeneralRole(r6?.[1]) ?? cleanGeneralRole(r10?.[1]) ?? cleanGeneralRole(r7?.[1]) ?? cleanGeneralRole(s2?.[1]) ?? cleanGeneralRole(r3?.[1]) ?? cleanGeneralRole(r14?.[1]) ?? cleanGeneralRole(r12?.[1]);
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

/**
 * Pull the ATS requisition / job number from an email (subject or body) when it is explicitly
 * labelled — e.g. "Job Number: 210715977", "Job number: 210705462", "Req ID: 210705462",
 * "Requisition 123456". This is a stable unique key for one posting: the application confirmation
 * and the later status/rejection email for the same job both carry it, so it matches them reliably
 * even when the company name is written differently ("JPMorganChase" vs "JPMorgan Chase & Co.").
 * Returns the digits only, or null when no number is present.
 */
export function extractJobNumber(subject: string, body: string): string | null {
	const text = `${subject}\n${body}`;
	// Any candidate must carry ≥5 digits so a bare year ("2026"), level ("L3"), or short count isn't taken.
	const enoughDigits = (s: string) => (s.match(/[0-9]/g)?.length ?? 0) >= 5;
	// A requisition is kept AS WRITTEN — its short letter prefix/suffix and internal hyphens are the
	// company's own format ("2026-0013799", "722493BR", "R0859802"), so the confirmation and the later
	// status/rejection email for one posting carry the identical string and still match exactly.
	const TOKEN = '[A-Za-z]{0,3}[0-9][0-9A-Za-z]*(?:-[0-9][0-9A-Za-z]*)*';

	// 1. LABELLED ("Job ID# 2026-0013799", "Req ID: 210705462", "Requisition 123456", "Job Number: 210715977").
	// A SEPARATOR (space / colon / #) between the label and the number is required, so a label GLUED to the
	// digits ("REQ352476") is left for rule 2 to keep WHOLE — there the "REQ" is the company's code prefix,
	// not a label to strip.
	const labeled = text.match(
		new RegExp(`\\b(?:job\\s*(?:number|id|no\\.?|#)|req(?:uisition)?(?:\\s*(?:id|number|no\\.?|#))?|requisition)[\\s:#]+(${TOKEN})`, 'i'),
	);
	if (labeled && enoughDigits(labeled[1])) return labeled[1];
	// 1b. A bare "ID: 3092179" — the colon makes it an explicit label (not a stray "id" in prose). Amazon
	// posts the job id this way: "...your interest in Software Engineer (ID: 3092179)".
	const idLabel = text.match(new RegExp(`\\bID\\s*[:#]\\s*(${TOKEN})`, 'i'));
	if (idLabel && enoughDigits(idLabel[1])) return idLabel[1];
	// 2. An UNLABELLED but unmistakably req-shaped alphanumeric token: a 1-3 letter prefix + 5+ digits
	// ("R0859802") or 5+ digits + a 1-3 letter suffix ("722493BR", "124432BR"). This mixed letter/digit
	// shape doesn't occur in phone numbers, dates, or money, so it's safe to read without a label.
	const alnum = text.match(/\b([A-Za-z]{1,3}[0-9]{5,}|[0-9]{5,}[A-Za-z]{1,3})\b/);
	if (alnum) return alnum[1];
	// 3. A dash-set-off id in the SUBJECT ("...Software Engineer I – 31143106", "... – 2026-0013799").
	// Subject-only because phone numbers in body footers are also dash-separated digit runs.
	const dashed = subject.match(/[-–]\s*([0-9]{4,}(?:-[0-9]{2,})?|[0-9]{6,})\b/);
	if (dashed && enoughDigits(dashed[1])) return dashed[1];
	return null;
}

/**
 * Canonicalise a requisition id that came from the LLM (which is looser than the parser): drop a leading
 * "#" and a SPACED/punctuated "Req" / "Requisition" / "Job Req" LABEL the model sometimes prepends
 * (e.g. "Req 93091" → "93091", "Job Req 57663" → "57663"), then validate. A label GLUED straight to the
 * digits is kept — it is the company's code prefix, not a label ("REQ352476" stays "REQ352476", same as the
 * parser reads it). A requisition is ONE token of letters/digits and . _ - carrying ≥5 digits; prose,
 * label-only text, and non-numeric codes ("HREMOTE-US-Telework" → 0 digits) degrade to null. Underscores/
 * periods are kept so real ATS ids survive ("R_336139", "R.0056062").
 */
export function canonicalReqId(raw: string | null | undefined): string | null {
	if (raw == null) return null;
	const s = String(raw).trim()
		.replace(/^#\s*/, '')
		// A run of label words ("Req", "Job Number", "Requisition", "Job ID") each followed by a SEPARATOR;
		// a label glued straight to the digits ("REQ352476") has no separator and is left whole.
		.replace(/^(?:(?:job|req(?:uisition)?|ref(?:erence)?|number|no|id)[\s.:#-]+)+(?=[0-9A-Za-z])/i, '')
		.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) return null;
	if ((s.match(/[0-9]/g)?.length ?? 0) < 5) return null;
	return s;
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
