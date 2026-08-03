import { describe, it, expect } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { buildBody } from './body';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const part = (mimeType: string, text: string): gmail_v1.Schema$MessagePart => ({ mimeType, body: { data: b64(text) } });
const msg = (...parts: gmail_v1.Schema$MessagePart[]): gmail_v1.Schema$Message =>
	({ payload: { mimeType: 'multipart/alternative', parts } });

describe('buildBody — generic mail (cleanBody)', () => {
	it('removes URLs and truncates at the footer signal', () => {
		const out = buildBody(
			msg(part('text/plain', 'Thank you for applying to Acme. See https://acme.com/status now. This email was intended for me@x.com so unsubscribe here.')),
			'careers@acme.com',
		);
		expect(out).toContain('Thank you for applying to Acme.');
		expect(out).not.toContain('http');           // URL stripped
		expect(out).not.toContain('unsubscribe');     // footer truncated
	});
	it('decodes HTML entities (named and hex)', () => {
		const out = buildBody(msg(part('text/plain', 'We&rsquo;ve received your application &amp; will &#x2018;review&#x2019; it.')), 'careers@acme.com');
		expect(out).toBe("We've received your application & will 'review' it.");
	});
	it('keeps a paragraph break as a "\\n" boundary but collapses a hard-wrapped line into a space', () => {
		// Real plain-text shape (MTA): a blank line separates "…at the MTA" from the greeting — a reliable
		// boundary that must survive as "\n" — while a lone newline only hard-wraps one sentence ("We
		// have\nreceived"), which must become a space so the sentence stays intact.
		const out = buildBody(
			msg(part('text/plain', 'Your Application at the MTA\r\n\r\nDear Hao Lin\r\n\r\nThank you for your interest. We have\r\nreceived your application.')),
			'noreply@hr1.mta.org',
		);
		expect(out).toBe('Your Application at the MTA\nDear Hao Lin\nThank you for your interest. We have received your application.');
	});
	it('turns block-level HTML boundaries (<p>/<div>) into a "\\n" so a heading does not run into the next block', () => {
		// Meta's shape: the "applying to Meta" heading and the "Hi Hao Lin" greeting live in SEPARATE blocks.
		// Flattening every tag to a space glued them ("applying to Meta Hi Hao Lin," which the parser read as
		// the company); a block boundary must survive as a "\n" so the capture stops at "Meta".
		const out = buildBody(
			msg(part('text/html', '<p>Thank you for applying to Meta</p><p>Hi Hao Lin, we received your application.</p>')),
			'careers@meta.com',
		);
		expect(out).toBe('Thank you for applying to Meta\nHi Hao Lin, we received your application.');
	});
	it('keeps words on the same rendered line together across inline tags (<b>/<a>)', () => {
		// Inline tags are NOT line breaks — dropping <b> to a space must not split "The New York Times"
		// onto separate lines the way a block boundary would.
		const out = buildBody(
			msg(part('text/html', '<p>Thanks for your interest in <b>The New York Times</b>.</p>')),
			'careers@nyt.com',
		);
		expect(out).toContain('The New York Times');   // inline tag boundaries stayed on one line
		expect(out).not.toContain('\n');               // a single block -> no boundary inside it
	});
	it('falls back to the HTML part when the plain part is an unrendered template', () => {
		const out = buildBody(
			msg(part('text/plain', '<% I18n.t("confirmation.body") %>'), part('text/html', '<p>Thanks for applying to <b>Globex</b>!</p>')),
			'careers@globex.com',
		);
		expect(out).toContain('Thanks for applying to Globex');
	});
});

// Senders pad email (especially the hidden preheader) with invisible characters. Deleting one that occupies
// width joins the words around it — that is what stored "Loyola Enterprises Inc..Unfortunately, …".
describe('buildBody — invisible characters', () => {
	const clean = (text: string) => buildBody(msg(part('text/plain', text)), 'careers@acme.com');

	it('treats a non-breaking space as a space, not as nothing', () => {
		expect(clean('Applied to Acme Inc.\u00A0Unfortunately, Acme has moved on.'))
			.toBe('Applied to Acme Inc. Unfortunately, Acme has moved on.');
	});
	it('collapses a run of NBSP padding to a single space', () => {
		expect(clean('Acme Inc.\u00A0\u00A0\u00A0Unfortunately, they moved on.'))
			.toBe('Acme Inc. Unfortunately, they moved on.');
	});
	it('gives the same result for the &nbsp; entity and the literal character', () => {
		// These two disagreed: the entity became a space, the literal was deleted.
		expect(clean('Acme&nbsp;Corp')).toBe('Acme Corp');
		expect(clean('Acme\u00A0Corp')).toBe('Acme Corp');
	});
	it('still deletes genuinely zero-width characters, adding no space', () => {
		// The reader sees nothing there, so the parser must not see a space either.
		expect(clean('Acme\u200BCorp')).toBe('AcmeCorp');   // ZWSP
		expect(clean('Acme\u00ADCorp')).toBe('AcmeCorp');   // soft hyphen
		expect(clean('Acme\uFEFFCorp')).toBe('AcmeCorp');   // BOM
	});
	it('treats the line and paragraph separators as breaks rather than joins', () => {
		expect(clean('Acme Inc.\u2028Unfortunately, they moved on.')).toBe('Acme Inc. Unfortunately, they moved on.');
		expect(clean('Acme Inc.\u2029Unfortunately, they moved on.')).toBe('Acme Inc. Unfortunately, they moved on.');
	});
});

describe('buildBody — LinkedIn', () => {
	it('keeps the card line structure and drops the "similar jobs" recommendations', () => {
		const out = buildBody(
			msg(part('text/plain', 'Software Engineer\nGlobex\nNew York, NY\nView similar jobs you may like\nDecoy Role\nDecoy Co')),
			'jobs-noreply@linkedin.com',
		);
		expect(out).toContain('Software Engineer\nGlobex');   // line breaks preserved for positional reading
		expect(out).not.toContain('Decoy Role');              // recommendations dropped
	});
});

describe('buildBody — Indeed', () => {
	// A REAL confirmation card, line-for-line from a sync log (each line was its own block element). The
	// wording matters: "The following items were sent to …" is Indeed's — "Your application was sent to …"
	// is LINKEDIN's, and the old fixture used it, missing the "Good luck!" tail that broke 36 companies.
	const indeedCard = (role: string, company: string, location: string, reviews?: string) =>
		[
			"We'll help you get started", 'Application submitted', role, company, `- ${location}`,
			...(reviews ? [reviews] : []),                     // some employers have no reviews line
			`The following items were sent to ${company}. Good luck!`,
			'&bull;', 'Application', '&bull;', 'Resume', 'Next steps',
		].map(line => `<div>${line}</div>`).join('');

	const employerLine = (html: string) =>
		buildBody(msg(part('text/plain', 'Indeed Application'), part('text/html', html)), 'indeedapply@indeed.com')
			.split('\n')[0];

	it('lifts the employer out of the HTML part and prepends "Employer:"', () => {
		expect(employerLine(indeedCard('Cleared Junior Software Engineer', 'Amentum', 'Washington, DC 20024', '5,595 reviews')))
			.toBe('Employer: Amentum');
	});
	it('keeps a period INSIDE the company name', () => {
		// Regression: a "[^.]+" capture stopped at the first period and stored "BuildingReports".
		expect(employerLine(indeedCard('Quality Assurance Tester', 'BuildingReports.com', 'Remote', '11 reviews')))
			.toBe('Employer: BuildingReports.com');
	});
	it('keeps a period that ENDS the company name, dropping only the template’s own', () => {
		// "Epic Kids Inc." renders as "…sent to Epic Kids Inc.. Good luck!" — exactly one of those dots is ours.
		expect(employerLine(indeedCard('Junior Software Engineer, Full-Stack', 'Epic Kids Inc.', 'San Jose, CA', '2 reviews')))
			.toBe('Employer: Epic Kids Inc.');
	});
	it('adds no period to a company that has none, and handles a card with no reviews line', () => {
		expect(employerLine(indeedCard('Quality Assurance Analyst (onsite)', 'GTM Payroll Services Inc', 'Clifton Park,NY,12065')))
			.toBe('Employer: GTM Payroll Services Inc');
	});
	it('adds no Employer line when the template no longer matches, deferring to the LLM', () => {
		// Better to lose the deterministic path than to invent a company. The sync summary's
		// "Indeed applied parsed" count drops and makes a template change visible.
		expect(employerLine('<div>The following items were delivered to Initech.</div>')).not.toContain('Employer:');
	});
});
