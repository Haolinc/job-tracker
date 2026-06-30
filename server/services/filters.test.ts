import { describe, it, expect } from 'vitest';
import { AUTOMATED_SUBJECT, RECRUITER_OUTREACH, isIgnorableEmail } from './filters';

describe('AUTOMATED_SUBJECT', () => {
	it.each([
		'Automatic reply: away from desk',
		'Out of office',
		'Your interview is confirmed',
		'Your interview has been scheduled',
		'5 new jobs for you',
		'Software Engineer job alert',
		'Email address validation request',
		'Your verification code',
		'Your one-time passcode',
		'Enter the one time code to continue',
		'Sign-in link for your application at Affinity Solutions',
		'sign in link for your account',
		'Magic link to continue',
		'Jacobs - Application Update',
	])('flags %j', (subject) => {
		expect(AUTOMATED_SUBJECT.test(subject)).toBe(true);
	});

	it.each([
		'Thank you for applying to Acme',
		'Your application to Software Engineer at Acme',
		'Jacobs - Application Update, Software Engineer',   // the ", [Role]" form is a real update (negative lookahead)
		'We received your application',
	])('does NOT flag %j', (subject) => {
		expect(AUTOMATED_SUBJECT.test(subject)).toBe(false);
	});
});

describe('RECRUITER_OUTREACH', () => {
	it('flags a staffing-agency cold-outreach body', () => {
		const body = 'Our records show that you are an experienced IT professional. Role: Java Full Stack Developer. ' +
			'If you are qualified, available, interested, planning to make a change, or know of a friend who might ' +
			'have the required qualifications. We do have referral bonus for candidates.';
		expect(RECRUITER_OUTREACH.test(body)).toBe(true);
	});

	it.each([
		'corp to corp role',
		'this is a C2C position',
		'open to W2 or 1099',
		'contract to hire opportunity',
	])('flags contract-staffing terms: %j', (body) => {
		expect(RECRUITER_OUTREACH.test(body)).toBe(true);
	});

	it.each([
		'Thank you for applying. We will review your application and keep an eye on our current openings.',
		'After careful consideration we have decided to move forward with other candidates.',
		'A recruiter will review your information to determine if you best meet the qualifications.',
	])('does NOT flag a real application/rejection: %j', (body) => {
		expect(RECRUITER_OUTREACH.test(body)).toBe(false);
	});
});

describe('isIgnorableEmail', () => {
	it('skips on automated subject', () => {
		expect(isIgnorableEmail('Email address validation request', 'x@y.com', 'body')).toBe(true);
	});
	it('skips on calendly sender', () => {
		expect(isIgnorableEmail('Schedule', 'noreply@calendly.com', 'body')).toBe(true);
	});
	it('skips on recruiter-outreach body', () => {
		expect(isIgnorableEmail('Java Full Stack Developer', 'r@staffing.com', 'We do have referral bonus for candidates.')).toBe(true);
	});
	it('keeps a real application email', () => {
		expect(isIgnorableEmail('Thank you for applying to Acme', 'careers@acme.com', 'We have received your application for Software Engineer.')).toBe(false);
	});
});
