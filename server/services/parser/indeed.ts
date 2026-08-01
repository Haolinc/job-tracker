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

// Rejection: one template with two slots — "An update on your application from [Company]" as the subject,
// "Thank you for applying to the [Role] position at [Company]." opening the body. Every part must hold:
// noreply@indeed.com also carries job recommendations and neutral status mail, and bailing here falls
// through to the general template rather than mislabelling one of those as a rejection.
function parseRejected(subject: string, body: string): Classification | null {
	// The subject is the template's own header: it gates the shape, and stands in as the fallback company.
	const subjectCompany = subject.match(/^An update on your application from\s+(.+)$/i)?.[1]?.trim();
	if (!subjectCompany) return null;
	// The decision sentence. Without it this is an "update" that never says the application was declined.
	if (!/\bnot selected\b/i.test(body)) return null;

	// Both fields come from the body's prose, with the subject behind them — the precedence the classifier
	// prompt states (body prose > subject > sender domain). Each capture is bounded by literal template text
	// on BOTH sides, so nothing has to guess where the name ends: a company that legitimately ends in a period
	// ("Loyola Enterprises Inc.") survives whole, and the sentence's own period is never swallowed into it.
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
