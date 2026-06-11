// ── Role-string cleanup + recovery ──────────────────────────────────────────
// tidyRole cleans a role string; recoverRoleFromBody pulls one from email prose when it's known.

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

export { cleanGeneralRole };

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
