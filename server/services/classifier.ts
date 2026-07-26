import type { Classification } from '../types';
import { canonicalReqId } from './parser/reqId';
import { debug } from '../logger';
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
Else null. Extract even unfamiliar/internal titles. Don't confuse company with role (company follows "interest in"; role precedes "position"). Keep clean: drop req numbers and location tails. Strip a trailing work-mode tail only when a place follows ("Software Engineer Onsite Great River, NY" -> "Software Engineer"); keep it if a number or non-place word follows.

REQ_ID
Extract a unique requisition/job/reference number when labelled ("Job ID:", "Req #", "reference number:", "(ID: ...)") OR in unmistakable req format unlabelled (year-hyphen-number 2026-71968; letter+digits R232753 / 722493BR; long standalone digit id 3092179). Keep EXACTLY as written. Null if not confident it's a req. Never a seniority level ("II"), a year inside a title, or a phone/date/salary/zip. 

If the body is unrendered template/code (contains "<%", "I18n.t", "*---*"), ignore it and use Subject + Sender.

REFERENCE CANDIDATES
The user message may end with "Reference candidates" — a company and/or role a deterministic parser pulled from this email. Treat them as informed hints: the company's exact spelling is usually reliable, but a candidate can be mislabeled (a job title placed in the company slot, or a partial name). Confirm each against the email — adopt it when it fits, correct or replace it when the email disagrees. A candidate never changes the category.

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
function warmUpModel(): Promise<boolean> {
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
				console.error(`[warmup] gave up preloading ${model}: ${error instanceof Error ? error.message : String(error)}`);
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

async function classifyEmail(subject: string, from: string, body: string, hints?: { company?: string | null; role?: string | null }): Promise<Classification> {
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
	// Strip markdown code fences if the model wraps its JSON in ```json ... ```
	const jsonText = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
	// The worked examples show "{json}  (note)", so the model sometimes appends a trailing parenthetical
	// after its JSON. Take just the first object — first "{" to last "}" — and ignore any commentary tail.
	const start = jsonText.indexOf('{'), end = jsonText.lastIndexOf('}');
	const parsed = JSON.parse(start !== -1 && end !== -1 ? jsonText.slice(start, end + 1) : jsonText) as Record<string, unknown>;
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
// Written in the full classifier's STYLE, not a one-liner: labeled COMPANY/ROLE rule sections, a
// reason-before-answer scratch field (the chain-of-thought that drove the full classifier's accuracy), and
// worked examples — because the terse original prompt is exactly what mislabeled a role as the company. The
// answer fields are grammar-locked to the spans (or null), so the model can only label or decline, never
// invent. STRICT null-when-uncertain: a null slot slides to the full classifier rather than shipping a guess.
const pickerSystemPrompt = `You are given candidate spans pulled from a job-application email, with its From and Subject. Each span is the EMPLOYER (company), the JOB TITLE (role), or neither. Put the best-fitting span in each slot. Return ONLY this JSON (no prose, no markdown):

{
  "company_reason": "<one short phrase: which span is the employer, or why none is> (fill BEFORE company)",
  "company": "<the exact span that names the employer, or null>",
  "role_reason": "<one short phrase: which span is the job title, or why none is> (fill BEFORE role)",
  "role": "<the exact span that names the job title, or null>"
}

COMPANY — the organization doing the hiring.
- A job title is NEVER a company: "Software Engineer", "QA Analyst", "Mid-Level Software Engineer", "Web Developer", "Data Scientist" are roles.
- An ATS or job board is NEVER a company: Greenhouse, Lever, iCIMS, Taleo, Workday, LinkedIn, Indeed, SmartRecruiters → null.
- A bare location or work mode is NEVER a company: "Remote", "Hybrid", "New York".

ROLE — the job title applied for, e.g. "<Level> <Discipline> Engineer/Analyst/Developer/Manager/Designer/Scientist".

STRICT — accuracy over coverage:
- Copy a span EXACTLY as given; never invent, edit, merge, or shorten one.
- A span may fit NEITHER slot. If you are not confident a span is a legitimate company (or role), put null there — do NOT force a guess. A null is safe: a fuller classifier re-reads the whole email.

EXAMPLES
From "careers@bloomberg.net", Spans ["Bloomberg","IT Service Desk Analyst"]
-> {"company_reason":"Bloomberg is a known employer","company":"Bloomberg","role_reason":"IT Service Desk Analyst is a job title","role":"IT Service Desk Analyst"}
Spans ["Greenhouse","Backend Engineer"]
-> {"company_reason":"Greenhouse is an ATS, not an employer","company":null,"role_reason":"Backend Engineer is a job title","role":"Backend Engineer"}
Spans ["Software Engineer","Platform Engineer"]
-> {"company_reason":"both spans are job titles; no employer named","company":null,"role_reason":"Software Engineer is the title","role":"Software Engineer"}`;

/**
 * Ask the model which of `spans` is the employer and which is the job title. Called ONLY for ≥2 candidates
 * (the caller routes a lone span to the full classifier), so there is always a genuine choice to make.
 *
 * The answer fields are grammar-constrained to an enum of the SPANS THEMSELVES (plus null), so the model can
 * only label a real candidate or decline — it cannot invent a company. A `reason` scratch field is generated
 * before each answer (chain-of-thought), mirroring the full classifier's source-before-value technique. That
 * enum changes per email, so this grammar compiles fresh each call — tiny, but not free.
 *
 * Returns null on a failed/unparseable call (caller keeps the parser's own guess); a successful call with
 * `company === null` is a real "not confident any span is the employer" and tells the caller to slide to the
 * full classifier.
 */
async function pickCompanyRole(spans: string[], subject: string, from: string): Promise<{ company: string | null; role: string | null } | null> {
	if (spans.length === 0) return null;
	// enum (not a bare string type) is what forbids invention: the sampler can emit only one of these exact
	// strings or null. Kept in the parser's priority order so ties break the way the deterministic guess did.
	const spanEnum = { enum: [...spans, null] };
	try {
		const chatResponse = await ollama.chat({
			model: classifierModel(),
			messages: [
				{ role: 'system', content: pickerSystemPrompt },
				{ role: 'user',   content: `From: ${from}\nSubject: ${subject}\n\nSpans:\n${spans.map(s => `- ${s}`).join('\n')}` },
			],
			format: {
				type: 'object',
				properties: {
					company_reason: { type: 'string' },
					company:        spanEnum,
					role_reason:    { type: 'string' },
					role:           spanEnum,
				},
				required: ['company_reason', 'company', 'role_reason', 'role'],
			},
			options: {
				num_predict: 100,   // two short reason phrases + two copied spans — 100 covers long titles with room
				temperature: 0,
			},
		});
		const responseText = chatResponse.message.content.trim();
		debug(`[pick] spans=${JSON.stringify(spans)} ->`, responseText.replace(/\s*\n\s*/g, ' '));
		const start = responseText.indexOf('{'), end = responseText.lastIndexOf('}');
		const parsed = JSON.parse(start !== -1 && end !== -1 ? responseText.slice(start, end + 1) : responseText) as Record<string, unknown>;
		// Belt and braces behind the grammar: only ever return a string the parser actually found in the email.
		const labelled = (value: unknown) => (typeof value === 'string' && spans.includes(value) ? value : null);
		return { company: labelled(parsed.company), role: labelled(parsed.role) };
	} catch (error) {
		debug(`[pick] failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

export { classifyEmail, warmUpModel, pickCompanyRole };
