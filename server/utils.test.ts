import { describe, it, expect } from 'vitest';
import { errMsg, formatDuration, resolveStatus, isFastApplyNotice, looksLikeStatusUpdate, looksLikeConfirmation } from './utils';

describe('formatDuration', () => {
	it.each([
		[0, '0s'],
		[8000, '8s'],
		[60000, '1m'],
		[341050, '5m 41s'],     // a real sync time
		[3661000, '1h 1m 1s'],
		[5400000, '1h 30m'],    // exact half-hour drops the 0s
		[500, '1s'],            // rounds to nearest second (0.5s → 1s)
	])('%d ms -> %s', (ms, expected) => {
		expect(formatDuration(ms)).toBe(expected);
	});
});

describe('resolveStatus — forward-only, terminal-sticky', () => {
	it('advances forward', () => {
		expect(resolveStatus('applied', 'interview')).toBe('interview');
		expect(resolveStatus('applied', 'rejected')).toBe('rejected');
		expect(resolveStatus('interview', 'offer')).toBe('offer');
		expect(resolveStatus('interview', 'rejected')).toBe('rejected');
	});

	it('never rolls back (a lower-stage email keeps the current stage)', () => {
		expect(resolveStatus('interview', 'applied')).toBe('interview');   // stray "received your application"
		expect(resolveStatus('applied', 'applied')).toBe('applied');
	});

	it('terminal states are final', () => {
		expect(resolveStatus('rejected', 'interview')).toBe('rejected');   // reached_interview tracked separately
		expect(resolveStatus('rejected', 'applied')).toBe('rejected');
		expect(resolveStatus('offer', 'rejected')).toBe('offer');          // an offer never becomes a rejection
	});
});

describe('isFastApplyNotice — only the apply NOTICE, never a rejection', () => {
	it('is true for the fast-apply application notices', () => {
		expect(isFastApplyNotice('linkedin_applied')).toBe(true);
		expect(isFastApplyNotice('indeed_applied')).toBe(true);
	});
	it('is false for fast-apply REJECTIONS (a status update, not an apply event)', () => {
		// The EarthCam bug: "linkedin_rejected" stamped fast_apply on the record and split the real notice.
		expect(isFastApplyNotice('linkedin_rejected')).toBe(false);
		expect(isFastApplyNotice('indeed_rejected')).toBe(false);
	});
	it('is false for non-fast / missing codes', () => {
		expect(isFastApplyNotice('general_template')).toBe(false);
		expect(isFastApplyNotice(undefined)).toBe(false);
	});
});

describe('looksLikeStatusUpdate — keyed on the subject, never confirmation body boilerplate', () => {
	it('real updates are caught by their subject', () => {
		expect(looksLikeStatusUpdate('Application Status Update')).toBe(true);
		expect(looksLikeStatusUpdate('OPENLANE: Update on the status of your application')).toBe(true);
		expect(looksLikeStatusUpdate('TransUnion: Job application status update')).toBe(true);
	});
	it('a confirmation is NOT an update — body boilerplate like "status update on your application" is ignored', () => {
		// ResMed/Liberty Mutual confirmations carry "you will receive a status update on your application" in
		// the body; keying on the subject means that no longer flips the confirmation into an update.
		expect(looksLikeStatusUpdate('Thank you for applying')).toBe(false);
		expect(looksLikeStatusUpdate('We have received your application for Software Engineer')).toBe(false);
		expect(looksLikeStatusUpdate('We received your job application (Job Number: 210752192)')).toBe(false);
	});
});

describe('looksLikeConfirmation — positive confirmation language overrides an "update" subject', () => {
	it('detects the corpus confirmation phrases (subject or body)', () => {
		expect(looksLikeConfirmation('Application Received', '')).toBe(false); // subject lacks the phrase, body empty
		expect(looksLikeConfirmation('', 'We have received your application for Software Engineer II')).toBe(true);
		expect(looksLikeConfirmation('Thanks for applying to Baseten!', '')).toBe(true);
		expect(looksLikeConfirmation('', 'Hao Lin, your application was sent to EarthCam')).toBe(true);
		expect(looksLikeConfirmation('', 'we will contact you with the next stage in our interview process')).toBe(true);
	});
	it('the Inspira case: an "Employment Update" subject whose body acknowledges the application IS a confirmation', () => {
		const subject = 'Employment Update - Inspira Financial Trust, LLC';
		const body = 'Dear Hao Lin, We have received your application for the position of Software Engineer II (Remote). '
			+ 'If your experience matches we will contact you with the next stage in our interview process.';
		// Subject alone reads as an update…
		expect(looksLikeStatusUpdate(subject)).toBe(true);
		// …but the confirmation language wins, so the route keeps it as a confirmation (fills the slot).
		expect(looksLikeConfirmation(subject, body)).toBe(true);
	});
	it('a pure status ping with NO confirmation language is not a confirmation (stays demoted)', () => {
		expect(looksLikeConfirmation('Application Update', 'Your application is currently under review by the team.')).toBe(false);
	});
});

describe('errMsg', () => {
	it('returns an Error message', () => {
		expect(errMsg(new Error('boom'), 'fallback')).toBe('boom');
	});
	it('returns a string error as-is', () => {
		expect(errMsg('a string error', 'fallback')).toBe('a string error');
	});
	it('falls back for unknown shapes', () => {
		expect(errMsg({ weird: true }, 'fallback')).toBe('fallback');
		expect(errMsg(null, 'fallback')).toBe('fallback');
	});
});
