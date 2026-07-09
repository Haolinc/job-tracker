import type { Classification } from '../types';
import { canonicalReqId } from './parser/reqId';
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
// racing two cold loads (which is what made the GUI/sync.log interleave warmup with classify).
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
				console.log(`[warmup] gave up preloading ${model}: ${error instanceof Error ? error.message : String(error)}`);
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, WARMUP_RETRY_DELAY_MS));   // Ollama likely still starting — retry
		}
	}
	return false;
}

async function classifyEmail(subject: string, from: string, body: string): Promise<Classification> {
	console.log(`[classify] subject="${subject}" from="${from}" body="${body}..."`);
	const res = await requestClassification(`From: ${from}\nSubject: ${subject}\n\nBody:\n${body}`, {
		maxOutputTokens: 150,   // JSON output is ~40-60 tokens — extra room for longer role names
	});
	console.log(`[classify] tokens: prompt=${res.prompt_eval_count ?? 0}`);
	const text = res.message.content.trim();
    console.log(`[classify] result:`, text);
	// Strip markdown code fences if the model wraps its JSON in ```json ... ```
	const jsonText = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
	// The worked examples show "{json}  (note)", so the model sometimes appends a trailing parenthetical
	// after its JSON. Take just the first object — first "{" to last "}" — and ignore any commentary tail.
	const start = jsonText.indexOf('{'), end = jsonText.lastIndexOf('}');
	const parsed = JSON.parse(start !== -1 && end !== -1 ? jsonText.slice(start, end + 1) : jsonText) as Record<string, unknown>;
	if (!parsed || !VALID_CATEGORIES.has(parsed.category as string)) {
		throw new Error(`Unexpected classifier response: ${text}`);
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

export { classifyEmail, warmUpModel };
