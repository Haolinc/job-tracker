import type { Classification } from '../types';
import ollama from 'ollama'

const systemPrompt = `You are a job application email classifier. Given an email's From header, subject, and body text, determine if it relates to a job application and extract key information.

Return ONLY valid JSON in this exact shape:
{
  "category": "applied" | "interview" | "offer" | "rejected" | "ignored",
  "company": "Company name or null",
  "role": "Job title or null"
}

Categories:
- applied: confirmation that an application was received
- interview: a HUMAN recruiter or hiring manager personally reaching out to invite you for an interview — must feel like a direct, intentional outreach, not a system-generated message
- offer: job offer extended
- rejected: application declined or position filled
- ignored: everything else — newsletters, cold outreach, unrelated emails, automated scheduling confirmations (Calendly, Google Meet invites, "your interview is confirmed"), calendar invites, automatic replies, out-of-office replies, or anything ambiguous where you cannot confidently determine the category

IMPORTANT — only use "interview" when the email reads like a human personally wrote it to invite you. If it is a system-generated confirmation, a calendar event, or an automatic reply, classify as "ignored". When in doubt, use "ignored".

Company extraction tips (in order of reliability):
1. Look for "at [Company]" or "with [Company]" in the subject or body
2. Use the sender name from the From header (e.g. "Walmart Careers <...>" → "Walmart")
3. Extract the domain from the sender email and convert to a company name
   (e.g. "noreply@greenhouse.io" means the ATS is Greenhouse — look elsewhere;
    "jobs@stripe.com" → "Stripe"; "talent@anthropic.com" → "Anthropic")
4. Avoid using ATS platform names (Greenhouse, Lever, Workday, iCIMS, Taleo, BambooHR,
   SmartRecruiters, Jobvite, Jazz, Breezy) as the company — they are the hiring software,
   not the employer. Return null if only the ATS domain is available.

Role extraction tips:
- Look for job titles in the subject or body (e.g. "Application for Software Engineer")
- A generic "Thank you for applying" with no title → return null (caller will store "Unknown Role")
- Do not invent a role; only return what is explicitly stated.`;

async function classifyEmail(subject: string, from: string, body: string): Promise<Classification> {
    const res = await ollama.chat({
        model: 'qwen2.5:7b',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: `From: ${from}\nSubject: ${subject}\n\nBody:\n${body}` },
        ],
        options: {
            num_predict: 120,  // JSON output is ~40 tokens — cap prevents unnecessary generation
            temperature: 0,    // deterministic output, no randomness needed for classification
        },
    })
	const text = res.message.content.trim();
	// Strip markdown code fences if the model wraps its JSON in ```json ... ```
	const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

	const parsed = JSON.parse(json);
	const validCategories = new Set(['applied', 'interview', 'offer', 'rejected', 'ignored']);
	if (!parsed || !validCategories.has(parsed.category)) {
		throw new Error(`Unexpected classifier response: ${text}`);
	}
	return {
		category: parsed.category as Classification['category'],
		company:  typeof parsed.company === 'string' ? parsed.company : null,
		role:     typeof parsed.role    === 'string' ? parsed.role    : null,
	};
}

export { classifyEmail };
