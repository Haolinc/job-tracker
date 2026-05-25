import type { Classification } from '../types';
import ollama from 'ollama'

const systemPrompt = `You are a job application email classifier. Given an email's From header, subject, and body text, determine if it relates to a job application and extract key information.

Return ONLY valid JSON in this exact shape:
{
  "category": "applied" | "interview" | "offer" | "rejected" | "ignored",
  "company": "Company name or null",
  "role": "Job title or null",
  "confidence": 0.0 to 1.0
}

Categories:
- applied: confirmation that an application was received
- interview: invitation to interview, scheduling request, or interview confirmation
- offer: job offer extended
- rejected: application declined or position filled
- ignored: newsletters, cold outreach, unrelated emails

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
- Do not invent a role; only return what is explicitly stated.

Confidence:
- 0.9+: clear application email with company and role both identified
- 0.7–0.9: clear application email, company identified, role unknown
- 0.5–0.7: application email likely but company is uncertain
- below 0.5: ambiguous or unrelated`;

async function classifyEmail(subject: string, from: string, body: string): Promise<Classification> {
    const res = await ollama.chat({
        model: 'qwen2.5:7b',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: `From: ${from}\nSubject: ${subject}\n\nBody:\n${body}` },
        ],
    })
	const text = res.message.content.trim();
	// Strip markdown code fences if the model wraps its JSON in ```json ... ```
	const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

	return JSON.parse(json) as Classification;
}

export { classifyEmail };
