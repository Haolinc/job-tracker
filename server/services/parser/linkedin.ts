// ── LinkedIn extractor ──────────────────────────────────────────────────────
// LinkedIn's "application sent" email is a rigid card. buildBody() preserves its line breaks
// (it does NOT flatten LinkedIn like other mail), so the body arrives structured:
//   Your application was sent to <Page name>
//   <Role>
//   <Company brand>
//   <Location>
//   View job: ...
// We read the card by POSITION, not by matching the company name. This sidesteps two traps:
//   • the page name in the subject differs from the brand on the card ("Socotec Gestions" vs
//     "SOCOTEC") — we take the brand from the card, which is what the user actually applied to;
//   • the role no longer depends on the company name repeating to bracket it.

import type { Classification } from '../../types';
import { senderEmail } from './sender';

// Easy-Apply confirmation: read the three lines after the heading (role, company, location).
function parseApplied(subject: string, body: string): Classification | null {
	if (!/your application was sent to/i.test(subject)) return null;

	const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
	const idx = lines.findIndex(l => /^your application was sent to\b/i.test(l));
	if (idx < 0) return null;

	const role    = lines[idx + 1];
	const company = lines[idx + 2];
	if (!role || !company) return null;
	// The card must be intact: a flattened/degenerate body would put the date or job-link marker
	// where the role or company should be — bail to the next parser rather than emit garbage.
	if (/^(?:view job|applied on)\b/i.test(role) || /^(?:view job|applied on)\b/i.test(company)) return null;

	return { category: 'applied', company, role, classifier_code: 'linkedin_applied' };
}

// Rejection: the subject carries everything ("Your application to [Role] at [Company]"); the body
// only confirms the type ("Your update from [Company]"). lastIndexOf(' at ') keeps company names
// that themselves contain " at " (e.g. "AI at Scale") intact.
function parseRejected(subject: string, body: string): Classification | null {
	if (!/^your application to /i.test(subject)) return null;
	if (!/your update from /i.test(body)) return null;

	const rest   = subject.slice('your application to '.length);
	const lastAt = rest.lastIndexOf(' at ');
	if (lastAt < 0) return null;

	return {
		category: 'rejected',
		role:     rest.slice(0, lastAt).trim(),
		company:  rest.slice(lastAt + 4).trim(),
		classifier_code: 'linkedin_rejected',
	};
}

/** Classify a LinkedIn job email (applied confirmation or rejection), or null if it's neither. */
export function parseLinkedIn(subject: string, from: string, body: string): Classification | null {
	if (!senderEmail(from).endsWith('jobs-noreply@linkedin.com')) return null;
	return parseApplied(subject, body) ?? parseRejected(subject, body);
}
