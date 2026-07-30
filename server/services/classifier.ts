import type { Classification } from '../types';
import { canonicalReqId } from './parser/reqId';
import { debug } from '../logger';
import { errMsg } from '../utils';
import ollama from 'ollama';

const systemPrompt = `You classify and extract data from job-application emails. Given From, Subject, and Body, return ONLY this JSON (no prose, no markdown):

{
  "category": "applied" | "interview" | "offer" | "rejected" | "ignored",
  "company": "<name or null>",
  "role_source": "<exact email snippet the role comes from, or null> (fill BEFORE role)",
  "role": "<job title or null>",
  "req_id_source": "<exact email snippet the req_id comes from, or null> (fill BEFORE req_id)",
  "req_id": "<requisition/job/reference number exactly as written, or null>"
}

CATEGORY
- applied: application received or under review ("reviewing your resume", "we'll be in touch" = applied)
- interview: explicit scheduling ("schedule", "phone screen", "video call", "set up a time"), OR a test-platform invite (HackerRank/Codility/CodeSignal/HackerEarth) with a link, OR a named human personally inviting you
- offer: offer extended
- rejected: declined, or "position filled" / "no longer hiring for" / "moving forward with other candidates" (still a rejection even when wrapped in "explore other openings" boilerplate)
- ignored: everything else: newsletters, cold outreach, job-board recs ("...: Apply Now", "is still available"), Calendly/"interview confirmed" auto-emails, post-application admin (WOTC/EEO/demographic surveys), anything ambiguous
Tie-breakers: doubt between applied/interview -> applied. Doubt between interview/ignored -> ignored. Enthusiasm ("we're thrilled you applied") is ATS branding, not an interview.

COMPANY (stop at first hit)
1. Name in body PROSE sentences (highest priority): "applying/applied to X", "interest in X", "thank you for applying to X", "considering X", "welcome to X", "X has received your application". If the company appears only in the sign-off ("Regards, Morgan Stanley Talent Acquisition"), use it and strip HR words.
2. Subject line.
3. Sender display name / domain (last resort): "Walmart Careers <...>" -> Walmart; "X @ icims" -> X; "jobs@stripe.com" -> Stripe.
Rules: prefer the body's working name over a legal/ATS/signature form (body "JPMorganChase" beats sender "JPMorgan Chase & Co."). CASING: write the company in its own conventional capitalization (Morgan Stanley, Palantir, Paramount, Expedia; acronyms stay all-caps: AMETEK, MITRE, RELX) — NEVER lowercase a normally-capitalized name, even if the email/domain writes it lowercase. Keep an all-lowercase form ONLY when the brand is genuinely styled that way (dv01, thoughtbot, etsy, imgix); don't dismiss such a name as code. For "*@myworkday.com" the subdomain IS the company — expand AND capitalize it properly (ms@myworkday.com -> Morgan Stanley, mitre@ -> MITRE, expedia@ -> Expedia); never return "Workday". Never return an ATS (Greenhouse, Lever, iCIMS, Taleo, Workday) as the company; return null if only the ATS is available. For test-platform invites the company is the EMPLOYER, not the platform.

ROLE (stop at first hit)
1. Explicit phrase in subject/body: "application for X", "applied to X", "Application received for: X", "interest in the X position/role".
2. Title-cased title right before "position"/"role"/"opening".
3. Title in a LinkedIn/assessment subject.
Else null. Extract even unfamiliar/internal titles. Don't confuse company with role (company follows "interest in"; role precedes "position"). Keep the WHOLE job title: every seniority level ("I", "II", "3"), every department or team after a comma or dash ("Engineer - Stores & Supply Chain", "Software Engineer I - Implementations"), and every specialization is PART of the title — never drop them. Only a requisition/job id, a city/state, and a bare work-mode word are NOT part of it: when one is glued on, return the title WITHOUT it ("1031800BR - Engineer II" -> "Engineer II", "Software Developer I SOFTW005349" -> "Software Developer I", "Software Engineer Onsite Great River, NY" -> "Software Engineer") — but NEVER null a real title just because an id trails it (the id goes in req_id). Keep a meaningful qualifier in parentheses ("(Java)", "(Remote)").

REQ_ID
Extract a unique requisition/job/reference number when labelled ("Job ID:", "Req #", "reference number:", "(ID: ...)") OR in unmistakable req format unlabelled (year-hyphen-number 2026-71968; letter+digits R232753 / 722493BR; long standalone digit id 3092179). Keep EXACTLY as written. Null if not confident it's a req. Never a seniority level ("II"), a year inside a title, or a phone/date/salary/zip. 

If the body is unrendered template/code (contains "<%", "I18n.t", "*---*"), ignore it and use Subject + Sender.

REFERENCE CANDIDATES — JUDGE THEM
The user message may end with "Reference candidates" — a company and/or role a deterministic parser pulled from this email. JUDGE each against the email rather than trusting it: if it is right, keep it; if it carries extra words (a greeting, "for the …" prose, a location or work-mode tail, an ATS name), return only the trimmed entity; if it is mislabeled (a job title sitting in the company slot, e.g. "Java Developer" as the company) or does not actually appear in the email, replace it from the email or use null. For the ROLE, the candidate has already been machine-stripped of ids and locations: adopt it when it is a clean, COMPLETE title, but if the email shows a real part it dropped (a level, a department after a comma or dash, a specialization), return the fuller title from the email instead. Never echo a candidate you cannot confirm in the text. A candidate never changes the category.

EXAMPLES
Body "...career at JPMorganChase...", from "JPMorgan Chase & Co. <...@cloud.oracle.com>"
-> {"category":"applied","company":"JPMorganChase","role_source":null,"role":null,"req_id_source":null,"req_id":null}

Subject "Your HackerRank for Acme Corp - Backend Engineer Invitation", from HackerRank
-> {"category":"interview","company":"Acme Corp","role_source":"HackerRank for Acme Corp - Backend Engineer Invitation","role":"Backend Engineer","req_id_source":null,"req_id":null}

Subject "Update regarding your application for Software Engineer 1 (React + API + Cloud Migration) Job ID# 2026-0013799" (a rejection)
-> {"category":"rejected","company":"U.S. Bank","role_source":"your application for Software Engineer 1 (React + API + Cloud Migration)","role":"Software Engineer 1 (React + API + Cloud Migration)","req_id_source":"Job ID# 2026-0013799","req_id":"2026-0013799"}

Subject "CP Payroll, LLC dba ConnectPay - Tosca Quality Assurance Engineer (Remote) - Req # 722493BR", from "CP Payroll, LLC dba ConnectPay <...@connectpay.com>"
-> {"category":"applied","company":"ConnectPay","role_source":"Tosca Quality Assurance Engineer (Remote)","role":"Tosca Quality Assurance Engineer","req_id_source":"Req # 722493BR","req_id":"722493BR"}

Body "...interest in Software Engineer (ID: 3092179)...", from "noreply@mail.amazon.jobs"
-> {"category":"applied","company":"Amazon","role_source":"interest in Software Engineer","role":"Software Engineer","req_id_source":"Software Engineer (ID: 3092179)","req_id":"3092179"}

Body "...application for the Software Engineer in Test, Maps & Navigation Systems QA, Vehicle Software, 260300 position...", from tesla.com
-> {"category":"applied","company":"Tesla","role_source":"Software Engineer in Test, Maps & Navigation Systems QA, Vehicle Software","role":"Software Engineer in Test, Maps & Navigation Systems QA, Vehicle Software","req_id_source":"260300","req_id":"260300"}

Body "Thank you for your interest in Morgan & Morgan and for taking the time to apply to our Software Engineer posting...", from "Morgan & Morgan <...@morganandmorgan.com>"
-> {"category":"applied","company":"Morgan & Morgan","role_source":"apply to our Software Engineer posting","role":"Software Engineer","req_id_source":null,"req_id":null} 

Body "...complete this voluntary WOTC questionnaire...", from target.com
-> {"category":"ignored","company":null,"role_source":null,"role":null,"req_id_source":null,"req_id":null}`;

const VALID_CATEGORIES = new Set(['applied', 'interview', 'offer', 'rejected', 'ignored']);

// JSON Schema handed to Ollama's `format` — the server compiles it into a grammar that CONSTRAINS token
// sampling, so the model physically cannot emit a category outside this enum (no invented "none"/"other")
// nor any prose outside the object. Property ORDER is preserved by the grammar, so the *_source scratch
// fields are still generated before the value they justify (the chain-of-thought that drives extraction).
const nullableString = { type: ['string', 'null'] };
const responseSchema = {
	type: 'object',
	properties: {
		category:      { type: 'string', enum: [...VALID_CATEGORIES] },
		company:       nullableString,
		role_source:   nullableString,
		role:          nullableString,
		req_id_source: nullableString,
		req_id:        nullableString,
	},
	required: ['category', 'company', 'role_source', 'role', 'req_id_source', 'req_id'],
};

/** The model the classifier talks to — the user's pick from .env (OLLAMA_MODEL), or the recommended default. */
const classifierModel = (): string => process.env.OLLAMA_MODEL || 'qwen2.5:7b';

/**
 * The first JSON object in a model reply. Both calls below need this: the grammar constrains the object's
 * shape but not what may trail it, and the worked examples show "{json}  (note)", so the model sometimes
 * appends a parenthetical — take first "{" to last "}" and ignore any commentary tail. Markdown fences are
 * stripped first for the same reason. Throws (like JSON.parse) when there is no parseable object at all.
 */
function parseFirstJsonObject(replyText: string): Record<string, unknown> {
	const unfenced = replyText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
	const objectStart = unfenced.indexOf('{'), objectEnd = unfenced.lastIndexOf('}');
	const objectText = objectStart !== -1 && objectEnd !== -1 ? unfenced.slice(objectStart, objectEnd + 1) : unfenced;
	return JSON.parse(objectText) as Record<string, unknown>;
}

/**
 * The ONE chat request this module ever sends — warmup and real classification both go through here so they
 * stay identical (same system prompt + grammar). That identity is what makes the warmup effective: Ollama's
 * prompt-eval cache and compiled grammar carry over to the real emails only because the requests match.
 */
function requestClassification(emailContent: string, requestOptions: { maxOutputTokens: number; keepAlive?: string }) {
	return ollama.chat({
		model: classifierModel(),
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user',   content: emailContent },
		],
		format: responseSchema,   // grammar-constrain output to the schema — category can ONLY be the enum
		options: {
			num_predict: requestOptions.maxOutputTokens,
			temperature: 0,   // deterministic output, no randomness needed for classification
		},
		keep_alive: requestOptions.keepAlive,   // undefined → Ollama's default (5 minutes)
	});
}

// Warmup keeps retrying while Ollama is still starting up — it may be unreachable the moment the server boots.
const WARMUP_MAX_ATTEMPTS = 10;
const WARMUP_RETRY_DELAY_MS = 3000;

// Shared so warmup runs at most once at a time: the boot call and the first sync await the SAME load instead of
// racing two cold loads (which is what made the GUI/debug log interleave warmup with classify).
let warmupInFlight: Promise<boolean> | null = null;

/**
 * Preload the classification model into Ollama so the concurrent classification doesn't start on a cold model
 * (a multi-GB load can take many seconds). Sends a real classification request for a dummy email, so the model
 * load, system-prompt eval, and grammar compilation ALL happen now instead of on the first real email.
 * Idempotent: kicked off at server boot and AWAITED by the sync, so classification runs only once the model
 * is ready. Best-effort; never throws.
 */
export function warmUpModel(): Promise<boolean> {
	if (!warmupInFlight) {
		warmupInFlight = loadModelWithRetry();
		// If it gave up (Ollama was down), forget it so a later sync can try again once Ollama is up.
		void warmupInFlight.then((loaded) => { if (!loaded) warmupInFlight = null; });
	}
	return warmupInFlight;
}

async function loadModelWithRetry(): Promise<boolean> {
	const model = classifierModel();
	for (let attempt = 1; attempt <= WARMUP_MAX_ATTEMPTS; attempt++) {
		try {
			// maxOutputTokens:1 → do all the setup (load + prompt eval + grammar), then stop after one token.
			await requestClassification('From: warmup\nSubject: warmup\n\nBody:\nwarmup', {
				maxOutputTokens: 1,
				keepAlive: '30m',   // keep the model resident well past Ollama's 5-minute default
			});
			console.log(`[warmup] model ${model} preloaded and ready`);
			return true;
		} catch (error) {
			if (attempt === WARMUP_MAX_ATTEMPTS) {
				// console.error, not debug: a model that can't preload means classification will fail too.
				console.error(`[warmup] gave up preloading ${model}: ${errMsg(error, 'unknown error')}`);
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, WARMUP_RETRY_DELAY_MS));   // Ollama likely still starting — retry
		}
	}
	return false;
}

/** Render the optional parser hints as a user-turn block, or '' when there is nothing to hint. */
function buildReferenceBlock(hints?: { company?: string | null; role?: string | null }): string {
	if (!hints) return '';
	const lines: string[] = [];
	if (hints.company) lines.push(`- company: "${hints.company}"`);
	if (hints.role)    lines.push(`- role: "${hints.role}"`);
	if (lines.length === 0) return '';
	return `\n\nReference candidates (from a deterministic parser — adopt when correct, override when the email disagrees):\n${lines.join('\n')}`;
}

export async function classifyEmail(subject: string, from: string, body: string, hints?: { company?: string | null; role?: string | null }): Promise<Classification> {
	debug(`[classify] subject="${subject}" from="${from}" body="${body}..."`);
	// Parser candidates ride in the USER turn only — the system prompt stays byte-identical so Ollama's
	// prompt-eval cache (the thing warmup primes) survives. The model treats them as overridable references.
	const referenceBlock = buildReferenceBlock(hints);
	if (referenceBlock) debug(`[classify] hints company="${hints?.company ?? ''}" role="${hints?.role ?? ''}"`);
	const chatResponse = await requestClassification(`From: ${from}\nSubject: ${subject}\n\nBody:\n${body}${referenceBlock}`, {
		maxOutputTokens: 150,   // JSON output is ~40-60 tokens — extra room for longer role names
	});
	debug(`[classify] tokens: prompt=${chatResponse.prompt_eval_count ?? 0}`);
	const responseText = chatResponse.message.content.trim();
	// Collapse the model's pretty-printed JSON to one line so the debug log stays one-line-per-event grep-able.
	debug(`[classify] result:`, responseText.replace(/\s*\n\s*/g, ' '));
	const parsed = parseFirstJsonObject(responseText);
	if (!parsed || !VALID_CATEGORIES.has(parsed.category as string)) {
		throw new Error(`Unexpected classifier response: ${responseText}`);
	}
	// canonicalReqId strips a leading "Req"/"Job Req" label the model sometimes prepends and validates the
	// token (≥5 digits), matching what the parser extracts from the same text so a posting links across paths.
	const reqInput = (typeof parsed.req_id === 'string' || typeof parsed.req_id === 'number') ? String(parsed.req_id) : null;
	return {
		category: parsed.category as Classification['category'],
		company:  typeof parsed.company === 'string' ? parsed.company : null,
		role:     typeof parsed.role    === 'string' ? parsed.role    : null,
		req_id:   canonicalReqId(reqInput),
	};
}

// ── Company/role picker (chooses among the parser's candidates) ──────────────

// A cheap, focused call: the parser already narrowed the email to a short candidate list, so the picker only
// TYPES those spans — which is the employer, which is the job title — and NEVER re-reads the whole body. That
// is the whole point of parsing first: keep this fast (a handful of spans, no body eval). Only invoked for
// ≥2 candidates (a lone span goes to the full classifier instead — see gmail.ts), so it always has a real
// choice to make.
//
// SOURCE-GROUNDED extraction, not span selection. The old picker was grammar-locked to the parser's exact
// candidate spans (an enum), so when the parser mis-cut a span ("Astronomer for the Software Engineer…",
// "Meta Hi Hao Lin") the correct answer was literally not in the allowed set — the model could only relabel a
// bad cut, never fix it. Here the model reads the candidate-bearing sentence and returns the correct SLICE of
// the text; the parser's spans are demoted to HINTS. Anti-hallucination moves from "must equal a span" to
// "must appear verbatim in the email" (a substring check in code + a retry) — looser, so it can re-cut, but
// still incapable of inventing a company. Reason-before-answer scratch fields carry the chain-of-thought.
const pickerSystemPrompt = `You are the JUDGE in a job-application email pipeline. A rough parser has already proposed candidate values for the EMPLOYER (the company doing the hiring) and the JOB TITLE (the role applied for). Your job is to decide whether each candidate is right, FIX it if it carries extra words, or REJECT it to null if it is not actually an employer / job title.

You are given a Subject, a Body excerpt, and the parser's candidate guesses. The guesses are ROUGH — they may glue a name to a greeting or a title ("Astronomer for the Software Engineer, Astro Core Services", "Meta Hi Hao Lin", "employment with Peraton"), carry a requisition id, trail a location or work mode, or name an applicant-tracking system instead of the employer.

Return ONLY this JSON (no prose, no markdown):
{
  "company_reason": "<one short phrase: judge the candidate — is it the employer? what to fix or why reject> (fill BEFORE company)",
  "company": "<the clean employer name, or null>",
  "role_reason": "<one short phrase: judge the candidate — is it the job title? what to fix or why reject> (fill BEFORE role)",
  "role": "<the clean job title, or null>"
}

HOW TO JUDGE
- SPLIT semantic wrappers: if a candidate glues the name to a greeting, to "for the …" prose, or to the OTHER entity, return only the entity. "employment with Peraton" → "Peraton". "Astronomer for the Software Engineer" → company "Astronomer", role "Software Engineer". You MAY also drop a trailing requisition id, city/state, or bare work-mode word ("Software Engineer Opportunities in NJ" → "Software Engineer").
- KEEP the whole title: a seniority level ("I", "II", "3"), a department or team after a comma or dash ("Engineer - Stores & Supply Chain", "Software Engineer I - Implementations"), and a specialization are PART of the job title — never drop them. When unsure whether a trailing word is noise or part of the title, KEEP it — a deterministic cleanup pass strips leftover ids and locations afterward, so you never need to over-trim.
- REJECT to null: if NONE of the candidates is a real employer, company is null. An ATS/job board (iCIMS, Workday, Greenhouse, Lever, Taleo, LinkedIn, Indeed, SmartRecruiters, Recruitee), a bare job title, a location, a work mode, or sentence prose ("our company", "your team") is NOT an employer. A company name is never the role. When in doubt, null — a fuller classifier re-reads the whole email.
- GROUNDED: the name you return must appear word-for-word in the Subject or Body excerpt (after trimming). Never invent, translate, or append text that is not there — never turn "Liberty Mutual Insurance" into "Liberty Mutual @ iCIMS".
- WORD ORDER: in "apply to X for the Y role" / "application to X for Y", X (right after "to") is the COMPANY and Y (after "for") is the ROLE — never the reverse.

EXAMPLES
Candidates: company="employment with Peraton" role="Entry-Level Full Stack Software Developer"; Body "…your interest in employment with Peraton for the Entry-Level Full Stack Software Developer position."
-> {"company_reason":"candidate wraps the name in 'employment with' — trim to the org","company":"Peraton","role_reason":"clean title","role":"Entry-Level Full Stack Software Developer"}
Candidates: company="our company" role="Frontend Software Engineers - Colorado Springs"; Body "Welcome to our company. …for the Frontend Software Engineers - Colorado Springs role."
-> {"company_reason":"'our company' is prose, not the hiring org — no candidate names an employer","company":null,"role_reason":"full title incl. the location tag — keep it, cleanup strips it later","role":"Frontend Software Engineers - Colorado Springs"}
Candidates: company="Astronomer for the Software Engineer, Astro Core Services" role="Astronomer"; Body "…apply to Astronomer for the Software Engineer, Astro Core Services role."
-> {"company_reason":"trim the trailing title off the company","company":"Astronomer","role_reason":"the title after 'for the'; the other candidate is the company — keep the team after the comma","role":"Software Engineer, Astro Core Services"}
Candidates: company="Target" role="Engineer - Stores & Supply Chain"; Body "…your application for the Engineer - Stores & Supply Chain role at Target."
-> {"company_reason":"named employer","company":"Target","role_reason":"the team after the dash is part of the title — keep it whole","role":"Engineer - Stores & Supply Chain"}`;

const normalizeForCompare = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Anti-hallucination check that replaces the old span-enum: a returned value is trusted only if it appears
 * verbatim (whitespace/case-insensitive) in the email's own text. Looser than "equals a parser span" — the
 * model may re-cut a mis-glued span — but it still cannot invent a company that isn't in the email.
 */
export function appearsInSource(value: string, groundingSources: string[]): boolean {
	const normalizedValue = normalizeForCompare(value);
	return normalizedValue.length > 0 && groundingSources.some(source => normalizeForCompare(source).includes(normalizedValue));
}

/**
 * The candidate-bearing sentence(s) — the excerpt the picker extracts from. The picker used to be blind to the
 * body for speed; source-grounded extraction needs enough context to re-cut a mis-glued span, but not the
 * whole body. Pick the body sentences that mention a candidate (matched by the candidate's leading words,
 * since a trimmed span may not be verbatim), in order, capped; fall back to the opening sentences.
 */
export function pickerContext(body: string, spans: string[]): string {
	const sentences = body.split(/(?<=[.!?])\s+|\n+/).map(sentence => sentence.trim()).filter(Boolean);
	// Match a sentence by each span's leading words — a trimmed span may not be verbatim, but its first few are.
	const spanLeadWords = spans
		.map(span => normalizeForCompare(span).split(' ').slice(0, 3).join(' '))
		.filter(leadWords => leadWords.length >= 3);
	const matchedSentences: string[] = [];
	for (const sentence of sentences) {
		const normalizedSentence = normalizeForCompare(sentence);
		if (spanLeadWords.some(leadWords => normalizedSentence.includes(leadWords)) && !matchedSentences.includes(sentence)) matchedSentences.push(sentence);
		if (matchedSentences.join(' ').length > 400) break;
	}
	return (matchedSentences.length ? matchedSentences : sentences.slice(0, 2)).join(' ').slice(0, 500);
}

/**
 * JUDGE the parser's candidate company/role against the email. Called ONLY for ≥2 candidates (the caller routes
 * a lone span to the full classifier). The model decides whether each candidate is the real employer / job
 * title, TRIMS it if it carries extra words (greeting, "for the …", req-id, ATS name), or REJECTS it to null
 * when no candidate is valid — the judgment lives in the model, not in deterministic post-trims. Grounding (the
 * kept value must be verbatim in the shown excerpt, plus one corrective retry) is the only hard gate and cannot
 * be satisfied by an invention.
 *
 * Returns null on a failed/unparseable call (caller keeps the parser's own guess); a successful call with
 * `company === null` is a real "no trustworthy employer in the text" and tells the caller to slide to the
 * full classifier.
 */
export async function pickCompanyRole(spans: string[], subject: string, body: string): Promise<{ company: string | null; role: string | null } | null> {
	if (spans.length === 0) return null;
	const bodyExcerpt = pickerContext(body, spans);
	// Ground the answer against EXACTLY what the model is shown — the excerpt and subject — not the full body or
	// sender. Validating against the whole body let a fabricated "Liberty Mutual @ icims" pass because that
	// footer cruft lived in a part of the body the model never read; the sender (an ATS address) fed the model
	// the very "icims" token it stitched on. Shown-set == validated-set is the whole anti-hallucination guarantee.
	const groundingSources = [bodyExcerpt, subject];
	const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
		{ role: 'system', content: pickerSystemPrompt },
		{ role: 'user',   content: `Subject: ${subject}\n\nBody excerpt:\n${bodyExcerpt}\n\nParser candidate guesses to judge (rough, may be mis-cut): ${spans.join(' | ')}` },
	];
	const runPickerCall = async () => {
		const chatResponse = await ollama.chat({
			model: classifierModel(),
			messages,
			format: {
				type: 'object',
				properties: {
					company_reason: { type: 'string' },
					company:        nullableString,
					role_reason:    { type: 'string' },
					role:           nullableString,
				},
				required: ['company_reason', 'company', 'role_reason', 'role'],
			},
			options: {
				num_predict: 220,   // judge writes two (longer) reason phrases + two possibly-long titles; keep JSON whole
				temperature: 0,
			},
		});
		const responseText = chatResponse.message.content.trim();
		return { responseText, parsed: parseFirstJsonObject(responseText) };
	};
	try {
		let { responseText, parsed } = await runPickerCall();
		debug(`[pick] spans=${JSON.stringify(spans)} ->`, responseText.replace(/\s*\n\s*/g, ' '));
		// The ONLY hard gate is grounding: the judged value (after the model's own trimming) must appear verbatim
		// in what the model was shown. This stays compatible with self-trimming — "employment with Peraton" judged
		// down to "Peraton" is still in the excerpt — while blocking anything invented. All other cleanup (dropping
		// req-ids, ATS names, sentence prose) is the model's judgment now, not a deterministic post-trim.
		const keepIfGrounded = (value: unknown) => (typeof value === 'string' && appearsInSource(value, groundingSources) ? value : null);
		let company = keepIfGrounded(parsed.company);
		let role    = keepIfGrounded(parsed.role);
		// A non-null answer that isn't grounded means the model trimmed to (or invented) text not in the excerpt —
		// retry ONCE with feedback (research: a single correction round fixes the vast majority), then null it.
		const companyUngrounded = typeof parsed.company === 'string' && company === null;
		const roleUngrounded    = typeof parsed.role === 'string' && role === null;
		if (companyUngrounded || roleUngrounded) {
			const offendingFields = [companyUngrounded ? `company "${String(parsed.company)}"` : '', roleUngrounded ? `role "${String(parsed.role)}"` : '']
				.filter(Boolean).join(' and ');
			messages.push({ role: 'assistant', content: responseText });
			messages.push({ role: 'user', content: `The ${offendingFields} does not appear word-for-word in the Subject or Body excerpt. Copy the exact substring you mean (you may trim surrounding words, but keep the remainder verbatim), or use null. Return the JSON again.` });
			({ responseText, parsed } = await runPickerCall());
			debug(`[pick] retry ->`, responseText.replace(/\s*\n\s*/g, ' '));
			company = keepIfGrounded(parsed.company);
			role    = keepIfGrounded(parsed.role);
		}
		return { company, role };
	} catch (error) {
		debug(`[pick] failed: ${errMsg(error, 'unknown error')}`);
		return null;
	}
}
