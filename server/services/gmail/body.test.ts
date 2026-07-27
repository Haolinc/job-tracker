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
	it('falls back to the HTML part when the plain part is an unrendered template', () => {
		const out = buildBody(
			msg(part('text/plain', '<% I18n.t("confirmation.body") %>'), part('text/html', '<p>Thanks for applying to <b>Globex</b>!</p>')),
			'careers@globex.com',
		);
		expect(out).toContain('Thanks for applying to Globex');
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
	it('lifts the employer out of the HTML part and prepends "Employer:"', () => {
		const out = buildBody(
			msg(part('text/plain', 'Indeed Application'), part('text/html', '<p>Your application was sent to Initech.</p>')),
			'indeedapply@indeed.com',
		);
		expect(out.startsWith('Employer: Initech')).toBe(true);
	});
});
