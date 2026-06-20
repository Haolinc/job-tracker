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
	// Software Engineer", "R232753 Platform Engineer", "R-78284 Software Engineer I"). Req-shaped = ≥5 digits
	// with an optional short letter prefix and an optional separator before the digits. The ≥5-digit floor
	// keeps a real year-prefixed title ("2026 Emerging Talent Software Engineers") and levels ("3D Designer").
	const lead = s.match(/^#?[A-Za-z]{0,4}[-_]?[0-9][0-9A-Za-z-]*\s+(?=\S)/);
	if (lead && (lead[0].match(/[0-9]/g)?.length ?? 0) >= 5) s = s.slice(lead[0].length).trim();
	// Brace- or bracket-wrapped id token anywhere ("Associate {TS9118550}" → "Associate",
	// "Development Engineer in Test [208728]" → "…Test"). Bracket form requires a digit so "[Remote]" survives.
	s = s.replace(/\s*\{[^}]*\}\s*/g, ' ').trim();
	s = s.replace(/\s*\[\s*#?[A-Za-z]{0,5}[-_: ]?\d[\dA-Za-z._\-/ ]*\]\s*/g, ' ').trim();
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
	if (/^United\s+(?:States|Kingdom)\b/i.test(s)) return null;   // a location fragment, not a role (e.g. a recovery pattern grabbing "United States (April 2026 Start)" after an en-dash split the title)
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
	// Declared in PRIORITY order (first non-null wins, via the return chain below).
	// Subject "Job Application: [Name] - [req] [Role] on [date]" — iCIMS receipts; title sits between the
	// dash-prefixed req and the " on <date>" tail.
	const subjJobApplication = subject.match(/\bJob Application:.*?[-–]\s*\d+\s+([A-Z][^\n]*?)\s+on\s+\d/i);
	// "position|role of [req#] [Role]" — Workday/Oracle may print a req before the title.
	const positionOfRole = body.match(/\b(?:position|role) of\s+(?:\d{5,}\s+)?([A-Z][^.!?\n]*?)(?=[.!?,]|\s+(?:has|have|is|was|at|with|on)\b|$)/);
	// "for|to [the|our] [Role] role|position|opportunity|opening" — the optional "(…)" passes a leading
	// qualifier ("…to the (Entry level) Full Stack Software Engineer … position").
	const forTheRole = body.match(/\b(?:for|to|exploring)\s+(?:the\s+|our\s+|your\s+|a\s+)?((?:\([^)]*\)\s*)?[A-Z][^.!?\n]*?)\s+(?:role|position|opportunity|opening)\b/);
	// "in|for the [Role] role|position|opportunity" — "interest in the Associate, Software Engineer position".
	const inTheRole = body.match(/\b(?:in|for)\s+the\s+((?:\([^)]*\)\s*)?[A-Z][^.!?\n]*?)\s+(?:role|position|opening|opportunity)\b/);
	// "our [open] [Role] role|position|opening".
	const ourRole = body.match(/\bour\s+(?:open\s+)?([A-Z][^.!?\n]*?)\s+(?:role|position|opening)\b/);
	// "application for the [Role] job" — Workable ("application for the QA Automation Engineer job was submitted").
	const applicationForTheJob = body.match(/\bapplication for the\s+([A-Z][^.!?\n]*?)\s+(?:job|position|role)\b/);
	// "following job|position(s): [Role]" — NBC Universal, SAP SuccessFactors, Lockheed ATS.
	const followingJob = body.match(/\bfollowing\s+(?:job|position)(?:\(s\)|s)?\s*:?\s+([A-Z][^.!?\n]+?)(?=[.!?\n]|$)/i);
	// "joining us|the team as [a] [Role]" — Talkspace.
	const joiningAs = body.match(/\bjoining\s+(?:us|the\s+team)\s+as\s+(?:an?\s+)?([A-Z][^.!?\n]*?)(?=[.!?\n]|$)/i);
	// "application for: [req] [Role]" — CVS Health colon form; the optional token swallows a leading req id.
	const applicationForColon = body.match(/\bapplication for:\s+(?:#?[A-Za-z]{0,3}\d[\w./-]*\s+)?([A-Z][^!?\n]*?)(?=[.!?\n]|$)/i);
	// "application for [Role]," — no "position"/"role" keyword; title terminated by a comma or clause word.
	const applicationForClause = body.match(/\b(?:application|applied|apply(?:ing)?)\s+for\s+(?:the\s+|our\s+|an?\s+)?([A-Z][^.!?\n,]*?)(?=,|\s+(?:and|position|role|opening|opportunity|job|at|with|here)\b|[.!?\n]|$)/);
	// Subject "application for [Role]" — may carry a trailing "- <req>" (tidyRole strips it).
	const subjApplicationFor = subject.match(/\bapplication for\s+(?:the\s+)?(.+)$/i);
	// "the [Role] role|position has|since|is" — anchorless rejection/confirmation prose; LOWEST priority
	// (broadest). Paren-aware so a parenthetical req with an inner period ("(46_2026.1)") doesn't truncate.
	const theRolePhrase = body.match(/\bthe\s+([A-Z](?:[^.!?\n()]|\([^)]*\))*?)\s+(?:role|position|opening|opportunity)\b/);
	return cleanGeneralRole(subjJobApplication?.[1]) ?? cleanGeneralRole(positionOfRole?.[1]) ?? cleanGeneralRole(forTheRole?.[1])
		?? cleanGeneralRole(inTheRole?.[1]) ?? cleanGeneralRole(ourRole?.[1]) ?? cleanGeneralRole(applicationForTheJob?.[1])
		?? cleanGeneralRole(followingJob?.[1]) ?? cleanGeneralRole(joiningAs?.[1]) ?? cleanGeneralRole(applicationForColon?.[1])
		?? cleanGeneralRole(applicationForClause?.[1]) ?? cleanGeneralRole(subjApplicationFor?.[1]) ?? cleanGeneralRole(theRolePhrase?.[1]);
}
