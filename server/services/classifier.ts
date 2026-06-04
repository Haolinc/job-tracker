import type { Classification } from '../types';
import ollama from 'ollama';

const systemPrompt = `You are a job application email classifier. Given an email's From header, subject, and body text, determine if it relates to a job application and extract key information.

Return ONLY valid JSON in this exact shape:
{
  "category": "applied" | "interview" | "offer" | "rejected" | "ignored",
  "company": "Company name or null",
  "role": "Job title or null"
}

Categories:
- applied: confirmation that an application was received
- interview: invitation to schedule or attend an interview, phone screen, or technical assessment — requires explicit scheduling or assessment language (see rules below)
- offer: job offer extended
- rejected: application declined or position filled
- ignored: everything else — newsletters, cold outreach, unrelated emails, automated scheduling confirmations (Calendly, Google Meet invites, "your interview is confirmed"), calendar invites, automatic replies, out-of-office replies, or anything ambiguous where you cannot confidently determine the category

REJECTION SIGNALS — these phrases mean "rejected", NOT "ignored", even when the email is padded with
encouraging marketing fluff (career pages, job alerts, "keep an eye on our openings", "stay connected"):
"the position/role has been filled", "this role has been filled", "(we are) no longer hiring for",
"position is now filled", "moving forward with other candidates", "not be proceeding". An email that
names the role you applied for and then says it was filled or they're no longer hiring is a REJECTION —
do not let the surrounding "explore other opportunities" boilerplate downgrade it to "ignored".

INTERVIEW RULES — only classify as "interview" if at least ONE of these is present:
1. Explicit scheduling language: "schedule an interview", "phone screen", "video call", "speak with you", "call with you", "set up a time"
2. A technical assessment or test invitation with a link or platform name (e.g. HackerRank, Codility, Intervue, TestGorilla)
3. A named human (not just "The Hiring Team") personally extending an invitation with their own words

INTERVIEW TRAPS — do NOT classify as "interview" even if the email sounds positive:
- Enthusiasm alone is NOT an interview: "We're thrilled/excited/delighted you're interested" is standard ATS branding that appears on application confirmations, not interviews
- "Reviewing your resume/application" means still in the applied stage — classify as "applied"
- "We'll be in touch", "we'll reach out if there's a match", "stay tuned" = no action required yet → "applied"
- A system-generated email from an ATS (Workday, Greenhouse, Lever, iCIMS, Ashby, SmartRecruiters) with a generic "Hiring Team" sign-off is always "applied" or "ignored", never "interview"
- When in doubt between "applied" and "interview", choose "applied". When in doubt between "interview" and "ignored", choose "ignored".

LinkedIn subject rules:
- Subject contains "your application was sent to [Company]" → category "applied"
- Subject contains "apply now to '[Role] at [Company]'" → category "ignored" (recommendation, not a confirmation)

Job board recommendation rules (classify as "ignored"):
- Subject ends with ": Apply Now" or contains "Apply Soon" → Glassdoor/job board unsolicited recommendation, not a confirmation
- Subject contains "is still available" → unsolicited follow-up recommendation, not a confirmation

Indeed rule for company extraction: the subject is "Indeed Application: [Role]" with no company. Look in the body for the employer name — it typically appears near "applied to", "position at", or the job listing header.

Assessment-platform rule (HackerRank, Codility, CodeSignal, HackerEarth): these are technical-test
invitations → category "interview". The sender is usually "[Platform] for [Company]" (e.g.
"HackerRank for JPMorganChase") and the subject names the employer and role (e.g. "Your HackerRank
JPMorganChase - NAMR Software Engineering Program - Campus Hiring - 2026 Invitation"). The company is
the EMPLOYER (here "JPMorganChase"), NEVER the platform. The role is the program/title from the
subject (here "NAMR Software Engineering Program - Campus Hiring - 2026"). If the body is an
unrendered template or code (e.g. it contains "<%" / "<%=" / "I18n.t"), IGNORE the body entirely and
extract company + role from the SUBJECT and SENDER.

Company extraction — PRIORITY ORDER (read top to bottom, stop at the first that yields a name):
  (A) the company named in the BODY's PROSE SENTENCES  ← highest priority, most reliable
  (B) the SUBJECT line
  (C) the sender display name / email domain  ← last resort
The body's sentences are the most reliable source: a company writes its everyday WORKING name there
(e.g. "a career at JPMorganChase") even when the subject is generic ("We received your application")
or the sender/signature shows a legal or ATS name ("JPMorgan Chase & Co.", "@myworkday.com"). Always
prefer the body's working name over a legal/ATS/domain form — consistency matters more than formality,
because the same employer's other emails use that same working name.

1. Explicit company phrases — look in the BODY first, then the subject:
   - "Thank you for applying to [Company]" / "Thanks for applying to [Company]" → company is
     [Company]. Extract it literally even if it's a short/common word ("Loop", "Fora", "Chalk").
   - "at [Company]" or "with [Company]"
   - "applying to [Company]", "applied to [Company]"
   - "Thank you for your interest in [Company]", "welcome to [Company]"
   - "considering [Company]", "thank you for considering [Company]" (common in rejections)
   SOURCE-OF-TRUTH RULE — the company name as written in the body's PROSE SENTENCES is the highest
   priority. When the body uses one form in a sentence and a different legal/entity form in an email
   SIGNATURE, legal FOOTER, or the sender's display name, ALWAYS use the SENTENCE form. Example:
   body sentence "interested in a career at JPMorganChase" but signature "Sincerely, JPMorgan Chase
   & Co." and sender "JPMorgan Chase & Co. Human Resources" → use "JPMorganChase" (the working name
   in the sentence), NOT the legal name from the signature/sender.
   IMPORTANT — company names may START WITH A LOWERCASE LETTER or be fully lowercase/stylized
   (e.g. "dv01", "thoughtbot", "imgix", "etsy"). Extract such a name literally and PRESERVE its
   original casing — do NOT dismiss a lowercase token as a code/ID and do NOT skip it. Equally, do
   NOT mistake a title-cased JOB TITLE for the company: the company is what follows
   "applying/considering/interest in", while the role is the title-cased phrase before
   "position"/"role". Example body: "...for considering dv01 ... aligned with the QA Engineer I
   position" → company "dv01", role "QA Engineer I" (NOT company "QA Engineer I").
   Always prefer these explicit phrases over domain guessing.
   MORE company phrases to catch (the body often uses ONLY one of these): "interest in joining
   [Company]", "joining the [Company] team", "[Company] has received your application", and a bare
   "interest in [Company]" / "interest in employment at [Company]".
   SIGNATURE-ONLY RULE — sometimes the company appears NOWHERE in the body prose except the closing
   sign-off ("Kind Regards, Morgan Stanley Talent Acquisition" / "Best, The Recruiting Team at
   Precision Neuroscience"). In that case use that name. Do NOT return null when the signature names a
   company — strip the trailing HR words ("Talent Acquisition", "Recruiting Team", "Careers").
2. Use the sender name from the From header (e.g. "Walmart Careers <...>" → "Walmart").
   When the display name is "[Company] @ [ATS]" (e.g. "General Dynamics Mission Systems @ icims"),
   extract the part BEFORE " @ " as the company — the ATS suffix is not the company name.
3. Extract the domain from the sender email and convert to a company name
   (e.g. "noreply@greenhouse.io" means the ATS is Greenhouse — look elsewhere;
    "jobs@stripe.com" → "Stripe"; "talent@anthropic.com" → "Anthropic";
    "noreply@walmart.com" → "Walmart" — ignore the "noreply" prefix, use the domain)
4. Workday subdomain rule: emails from "*@myworkday.com" use a branded subdomain that
   IS the company. Extract the part before "@myworkday.com" and treat it as the company slug.
   Convert it to a proper name (e.g. "cableone@myworkday.com" → "CableONE",
   "ms@myworkday.com" → "Morgan Stanley", "relx@myworkday.com" → "RELX").
   Do NOT return "Workday" as the company for these emails.
   Workday applied rule: subjects like "Got it! Application received for: [Role]",
   "External Apply Confirmation", "Thank You for Your Application!", or
   "Thanks for your interest in career opportunities at [Company]" from a *@myworkday.com
   sender are applied confirmations → category "applied". Extract the role from the subject
   or body (the req ID line often contains it).
5. Indeed rule: emails from "indeedapply@indeed.com" are application forwarding emails.
   The real company is in the subject line, typically formatted as
   "Indeed Application: [Role] at [Company]" or in the body. Extract the company from there.
   Do NOT return "Indeed" as the company.
6. Avoid using generic ATS platform names (Greenhouse, Lever, iCIMS, Taleo, BambooHR,
   SmartRecruiters, Jobvite, Jazz, Breezy) as the company — they are the hiring software,
   not the employer. Return null if only the ATS domain is available.

Role extraction tips:
- Look for job titles in the subject or body (e.g. "Application for Software Engineer", "Application Success: Space Force - Software Engineer")
- Keep the title CLEAN: do NOT append reference/requisition numbers, job IDs, or location tails — the
  requisition number is tracked separately. "Java Developer (reference number: 779128)" → "Java Developer".
- LinkedIn subjects like "Your application to [Role] at [Company]" → role is [Role], company is [Company]
- A generic "Thank you for applying" with no title → return null (caller will store "Unknown Role")
- Do not invent a role; only return what is explicitly stated.
- Strip location/workplace modifiers from the end of role titles only when they are clearly
  geographic (a recognisable city, state, or country name follows the modifier):
    "Software Engineer Onsite Great River, NY"  → "Software Engineer"
    "Software Engineer - Remote Austin, TX"     → "Software Engineer"
    "Data Analyst Hybrid Chicago"               → "Data Analyst"
  Do NOT strip if what follows is a number (requisition IDs look like "Remote 376141" — keep it)
  or a non-geographic word ("Evergreen" is a posting type, not a city — keep it).
  When in doubt, keep the original text.

WORKED EXAMPLES (input cue → output). These are the source of truth for the tricky decisions; when a
new case is classified wrong, ADD a short example here rather than relying on prose rules alone:
1. From "JPMorgan Chase & Co. <noreply@cloud.oracle.com>", body "...interested in a career at JPMorganChase..."
   → {"category":"applied","company":"JPMorganChase","role":null}
   (the body's working name wins over BOTH the legal signature name and the Oracle ATS sender domain)
2. Subject "Thank you for your Resume", body "...your application for the Test Engineer at Sherpa 6. We..."
   → {"category":"applied","company":"Sherpa 6","role":"Test Engineer"}   (keep the number — it is part of the name)
3. Body "...Thanks for applying! ... Thank you, PMC Talent Acquisition Team"  (company appears ONLY in the sign-off)
   → {"category":"applied","company":"PMC","role":null}
4. Subject "Application received by City of Scottsdale", body is unrendered junk ("*---*---*---*")
   → {"category":"applied","company":"City of Scottsdale","role":null}   (body is junk → take the company from the SUBJECT)
5. Body "...Thank you for your interest in employment at CP Payroll, LLC dba ConnectPay..."
   → {"category":"applied","company":"ConnectPay","role":null}   (use the "dba" trade name, not the legal entity)
6. Subject "Your HackerRank for Acme Corp - Backend Engineer Invitation", from "HackerRank <...>"
   → {"category":"interview","company":"Acme Corp","role":"Backend Engineer"}   (the EMPLOYER, never the assessment platform)`;

const VALID_CATEGORIES = new Set(['applied', 'interview', 'offer', 'rejected', 'ignored']);

async function classifyEmail(subject: string, from: string, body: string): Promise<Classification> {
	console.log(`[classify] subject="${subject}" from="${from}" body="${body}..."`);
	const res = await ollama.chat({
		model: 'qwen2.5:7b',
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user',   content: `From: ${from}\nSubject: ${subject}\n\nBody:\n${body}` },
		],
		options: {
			num_predict: 150,  // JSON output is ~40-60 tokens — extra room for longer role names
			temperature: 0,    // deterministic output, no randomness needed for classification
		},
	});
	const text = res.message.content.trim();
	// Strip markdown code fences if the model wraps its JSON in ```json ... ```
	const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

	const parsed = JSON.parse(json) as Record<string, unknown>;
	console.log(`[classify] result:`, parsed);
	if (!parsed || !VALID_CATEGORIES.has(parsed.category as string)) {
		throw new Error(`Unexpected classifier response: ${text}`);
	}
	return {
		category: parsed.category as Classification['category'],
		company:  typeof parsed.company === 'string' ? parsed.company : null,
		role:     typeof parsed.role    === 'string' ? parsed.role    : null,
	};
}

export { classifyEmail };
