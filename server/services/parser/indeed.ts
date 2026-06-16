// ── Indeed extractor ────────────────────────────────────────────────────────
// Indeed Easy-Apply confirmation. The role is in the subject ("Indeed Application: [Role]"); the
// company is NOT in the plain-text part, so buildBody() lifts it out of the HTML and prepends an
// "Employer: [Company]" line. If that lift failed there's no company to recover (indeed.com is an
// ATS domain), so we bail to the AI rather than save with a null company.

import type { Classification } from '../../types';
import { senderEmail } from './sender';

export function parseIndeed(subject: string, from: string, body: string): Classification | null {
	if (!senderEmail(from).includes('indeedapply@indeed.com')) return null;

	const roleMatch = subject.match(/^Indeed Application:\s*(.+)$/i);
	if (!roleMatch) return null;

	const company = body.match(/^Employer:\s*(.+)/im)?.[1]?.trim() ?? null;
	if (!company) return null;

	return { category: 'applied', company, role: roleMatch[1].trim(), classifier_code: 'indeed_applied' };
}
