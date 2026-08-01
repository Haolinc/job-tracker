// ── Indeed extractor ────────────────────────────────────────────────────────
// Indeed sends two rigid, Indeed-authored templates from two different addresses, so each is read by
// POSITION (like the LinkedIn card) rather than by keyword:
//   • indeedapply@indeed.com — the Easy-Apply confirmation. The role is in the subject ("Indeed
//     Application: [Role]"); the company is NOT in the plain-text part, so buildBody() lifts it out of
//     the HTML and prepends an "Employer: [Company]" line. If that lift failed there's no company to
//     recover (indeed.com is an ATS domain), so we bail to the AI rather than save with a null company.
//   • noreply@indeed.com — the rejection. The subject carries the company, the body's opening line the role.

import type { Classification } from '../../types';
import { senderEmail } from './sender';

// Easy-Apply confirmation: role from the subject, company from the "Employer:" line buildBody() prepends.
function parseApplied(subject: string, body: string): Classification | null {
	const roleMatch = subject.match(/^Indeed Application:\s*(.+)$/i);
	if (!roleMatch) return null;

	const company = body.match(/^Employer:\s*(.+)/im)?.[1]?.trim() ?? null;
	if (!company) return null;

	return { category: 'applied', company, role: roleMatch[1].trim(), classifier_code: 'indeed_applied' };
}

// Rejection. Strict on every part: noreply@indeed.com also carries job recommendations and neutral status
// mail, and bailing falls through to the general template rather than mislabelling one as a rejection.
function parseRejected(subject: string, body: string): Classification | null {
	// Gates the template shape, and stands in as the fallback company.
	const subjectCompany = subject.match(/^An update on your application from\s+(.+)$/i)?.[1]?.trim();
	if (!subjectCompany) return null;
	if (!/\bnot selected\b/i.test(body)) return null;   // no decision sentence -> a neutral update, not a rejection

	// Body prose first, subject behind it (the precedence the classifier prompt states). Both captures are
	// bounded by template text on either side, so "Loyola Enterprises Inc." keeps its own trailing period.
	const bodyCompany = body.match(/unfortunately,\s+(.+?)\s+has moved to the next step/i)?.[1]?.trim();
	const role        = body.match(/thank you for applying to the\s+(.+?)\s+position at\s/i)?.[1]?.trim();
	if (!role) return null;

	return { category: 'rejected', company: bodyCompany ?? subjectCompany, role, classifier_code: 'indeed_rejected' };
}

/** Classify an Indeed job email (apply confirmation or rejection), or null if it's neither. */
export function parseIndeed(subject: string, from: string, body: string): Classification | null {
	const sender = senderEmail(from);
	if (sender.includes('indeedapply@indeed.com')) return parseApplied(subject, body);
	if (sender.includes('noreply@indeed.com')) return parseRejected(subject, body);
	return null;
}
