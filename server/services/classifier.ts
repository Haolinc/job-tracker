import Anthropic from '@anthropic-ai/sdk';
import type { Classification } from '../types';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const systemPrompt = `You are a job application email classifier. Given an email subject and snippet, determine if it relates to a job application and extract key info.

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
- ignored: newsletters, cold outreach, unrelated emails`;

async function classifyEmail(subject: string, snippet: string): Promise<Classification> {
	const response = await anthropic.messages.create({
		model: 'claude-sonnet-4-20250514',
		max_tokens: 200,
		system: systemPrompt,
		messages: [{ role: 'user', content: `Subject: ${subject}\n\nSnippet: ${snippet}` }],
	});
	const block = response.content[0];
	if (block.type !== 'text') throw new Error('Unexpected response type from classifier');
	return JSON.parse(block.text) as Classification;
}

export { classifyEmail };
