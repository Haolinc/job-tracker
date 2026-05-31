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

Company extraction tips (in order of reliability):
1. Look for explicit company mentions in the subject or body (highest priority):
   - Subject "Thank you for applying to [Company]" or "Thanks for applying to [Company]" →
     company is [Company]. This is the most reliable signal — extract it literally even if
     the name is a short or common word like "Loop", "Fora", "Chalk", "Spot & Tango".
   - "at [Company]" or "with [Company]" in subject or body
   - "applying to [Company]", "applied to [Company]"
   - "Thank you for your interest in [Company]", "welcome to [Company]"
   Always prefer these explicit phrases over domain guessing.
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
- Look for job titles in the subject or body (e.g. "Application for Software Engineer")
- If a reference number, requisition ID, or job code appears alongside the title, append it
  in parentheses so the same role at the same company can be distinguished by application:
    e.g. "Java Developer (reference number: 779128)", "SWE (Req ID: ABC-123)"
  Only include a code if it is explicitly in the email; do not invent one.
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
  When in doubt, keep the original text.`;

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
