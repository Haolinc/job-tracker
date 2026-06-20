import { describe, it, expect } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { canonicalReqId, extractJobNumber } from './parser/reqId';
import { tidyRole, recoverRoleFromBody } from './parser/roles';
import { parseEmail } from './parser/templates';
import { extractGeneralCompanyRole } from './parser/companyRole';
import { buildBody } from './gmail/body';

// ── canonicalReqId ────────────────────────────────────────────────────────────
// Cleans an LLM-supplied requisition id. Rule: a label GLUED to the digits is the company's code prefix
// (keep it); a label separated by a space/colon/# is a label (strip it). ≥5 digits required.
describe('canonicalReqId', () => {
    // [given job id, expected job id]
	const cases: [string | null, string | null][] = [
		['REQ352476', 'REQ352476'],            
		['REQ 352476', '352476'],              // spaced label, stripped
		['Req36805', 'Req36805'],              
		['Req 93091', '93091'],                // spaced label, stripped
		['Job Req 57663', '57663'],            // spaced label, stripped
		['job number 210715977', '210715977'], // spaced "job number" label
		['Requisition: 200035410', '200035410'],
		['#12345', '12345'],                   // leading hash dropped
		['  R0859802  ', 'R0859802'],          // surrounding whitespace trimmed
		['abc', null],                         // no digits
		['R0859802', 'R0859802'],              // "R" is a code prefix, not the "Req" label
		['722493BR', '722493BR'],              // suffix code kept
		['2026-0013799', '2026-0013799'],      // hyphenated kept whole
		['R_336139', 'R_336139'],              // underscore kept
		['JR_036564', 'JR_036564'],
		['R.0056062', 'R.0056062'],            // period kept
		['HREMOTE-US-Telework', null],         // 0 digits → not a req
		['II', null],                          // seniority level
		['2026', null],                        // bare year (4 digits)
		[null, null],
	];
	it.each(cases)('%j -> %j', (input, expected) => {
		expect(canonicalReqId(input)).toBe(expected);
	});
});

// ── extractJobNumber ──────────────────────────────────────────────────────────
// Deterministic req extraction from subject+body, kept AS WRITTEN. Glued REQ stays whole via the
// alphanumeric rule; a spaced label is stripped; phones/years are rejected.
describe('extractJobNumber', () => {
    // [Subject, Body, Expected job id]
	const cases: [string, string, string | null][] = [
		['subject', 'Job Number: 210715977', '210715977'],
		['subject', 'Req ID: 210705462 for the role', '210705462'],
		['subject', 'Requisition 123456 closed', '123456'],
		['subject', 'we received your Req 93091 application', '93091'],            // spaced label → strip
		['subject', 'Application received for: REQ352476 Associate Engineer', 'REQ352476'],   // glued → keep whole
		['...Job ID# 2026-0013799', 'b', '2026-0013799'],                   // hyphenated, whole
		['subject', 'interest in Software Engineer (ID: 3092179).', '3092179'],   // bare ID label (Amazon)
		['subject', 'application for: R0859802 Software Dev Engineer', 'R0859802'],
		['subject', 'Software Engineer Opportunities in NJ 722493BR', '722493BR'],
		['Req 2026-71968 - Space Force - Software Engineer', 'b', '2026-71968'],
		['We Received Your Application for Software Engineer I – 31143106', 'b', '31143106'],
		["Got it! Application received for: REQ352476 Associate Engineer", 'b', 'REQ352476'],  // T-Mobile glued
		['subject', 'Job ID: 12345 ... and a later 67890 elsewhere', '12345'],   // first labelled match wins
		['subject', 'no requisition here, call us at 1-888-596-2365', null],      // phone, not a req
		['Software Engineer - Remote', 'Great River, NY. Level 3 role.', null],
	];
	it.each(cases)('(%j, %j) -> %j', (subject, body, expected) => {
		expect(extractJobNumber(subject, body)).toBe(expected);
	});
});

// ── tidyRole ──────────────────────────────────────────────────────────────────
// Strips leading req tokens, brace ids, and trailing req/location noise; keeps real year-prefixed titles.
describe('tidyRole', () => {
     // [Role name with other info, Expected role name]
	const cases: [string, string][] = [
		['2026-71968 Space Force - Software Engineer', 'Space Force - Software Engineer'],
		['R232753 Platform Engineer', 'Platform Engineer'],
		['Associate {TS9118550}', 'Associate'],
		['Software Engineer Opportunities in NJ 722493BR', 'Software Engineer Opportunities in NJ'],
		['Software Engineer I – 31143106', 'Software Engineer I'],
		['Java Developer (reference number: 779128)', 'Java Developer'],   // trailing ref parenthetical
		['Software Engineer Onsite Great River, NY', 'Software Engineer'], // work-mode + location tail
		['R-78284 Software Engineer I', 'Software Engineer I'],            // hyphenated leading req
		['Development Engineer in Test [208728]', 'Development Engineer in Test'],   // bracket-wrapped id
		['QA Engineer [Remote]', 'QA Engineer [Remote]'],                 // bracket without a digit kept
		// regressions — must be left intact:
		['2026 Emerging Talent Software Engineers - Full time', '2026 Emerging Talent Software Engineers - Full time'],
		['3D Designer', '3D Designer'],
		['Software Engineer III', 'Software Engineer III'],
		['QA Automation Engineer (All Levels)', 'QA Automation Engineer (All Levels)'],
		['Software Engineer (Remote)', 'Software Engineer (Remote)'],     // "(Remote)" qualifier kept
	];
	it.each(cases)('%j -> %j', (input, expected) => {
		expect(tidyRole(input)).toBe(expected);
	});
});

// ── parseEmail ────────────────────────────────────────────────────────────────
// End-to-end deterministic classification. Each case asserts category, company (substring), role
// (substring, or null), and classifier_code where it pins the path.
describe('parseEmail', () => {
	interface Case {
		testName: string; subject: string; from: string; body: string;
		category: string; company?: string; role?: string | null; code?: string;
	}
	const cases: Case[] = [
		{
			testName: 'LinkedIn fast-apply confirmation (structured card)',
			subject: 'Hao Lin, your application was sent to FanDuel',
			from: 'LinkedIn <jobs-noreply@linkedin.com>',
			body: 'Your application was sent to FanDuel\nSoftware Engineer II\nFanDuel\nNew York, United States\nView job:',
			category: 'applied', company: 'FanDuel', role: 'Software Engineer II', code: 'linkedin_applied',
		},
		{
			// Real regression: the LinkedIn page name in the subject ("Socotec Gestions") differs from the
			// brand on the card ("SOCOTEC"). The old company-sandwich approach failed the role and kept the
			// legal name; reading the card by position gives the brand company + the role directly.
			testName: 'LinkedIn fast-apply — subject name ≠ card brand (Socotec)',
			subject: 'Hao Lin, your application was sent to Socotec Gestions',
			from: 'LinkedIn <jobs-noreply@linkedin.com>',
			body: 'Your application was sent to Socotec Gestions\nSoftware Engineer\nSOCOTEC\nNew York, NY\nView job:',
			category: 'applied', company: 'SOCOTEC', role: 'Software Engineer', code: 'linkedin_applied',
		},
		{
			testName: 'LinkedIn rejection',
			subject: 'Your application to Backend Engineer at Acme',
			from: 'LinkedIn <jobs-noreply@linkedin.com>',
			body: 'Your update from Acme. Unfortunately the team moved forward with other candidates.',
			category: 'rejected', company: 'Acme', role: 'Backend Engineer', code: 'linkedin_rejected',
		},
		{
			testName: 'general template — interest in the [Role] opportunity at [Company]',
			subject: 'Update on your PermitFlow application',
			from: 'PermitFlow <noreply@permitflow.com>',
			body: "Thank you again for your interest in the Software Engineer (NYC) opportunity at PermitFlow. After review we've decided to move forward with candidates whose experience is more closely aligned.",
			category: 'rejected', company: 'PermitFlow', role: 'Software Engineer (NYC)', code: 'general_template',
		},
		{
			testName: 'general template — the [Role] role has been filled (Etsy)',
			subject: 'Update on your application',
			from: 'Etsy <noreply@etsy.com>',
			body: 'Thank you for your interest in Etsy. Unfortunately, the Senior Software Engineer I, Data Enablement role has since been filled and we are no longer moving forward.',
			category: 'rejected', company: 'Etsy', role: 'Senior Software Engineer I, Data Enablement', code: 'general_template',
		},
		{
			testName: 'general template — joining us as a [Role] (Talkspace)',
			subject: 'Your application to Talkspace',
			from: 'Talkspace <noreply@talkspace.com>',
			body: "The Talkspace team is excited that you're interested in joining us as a QA Automation Engineer (AI Systems & Web Apps). We have received your application and will review it.",
			category: 'applied', company: 'Talkspace', role: 'QA Automation Engineer (AI Systems & Web Apps)', code: 'general_template',
		},
		{
			testName: 'general template — and the [Role] position (Affinity, paren-aware)',
			subject: 'Thank you for applying',
			from: 'Affinity Solutions <noreply@affinity.solutions>',
			body: 'Thank you for your interest in Affinity Solutions and the QA Automation Engineer (46_2026.1) position. We will review your application.',
			category: 'applied', company: 'Affinity', role: 'QA Automation Engineer', code: 'general_template',
		},
		{
			testName: 'Indeed fast-apply confirmation',
			subject: 'Indeed Application: Backend Engineer',
			from: 'Indeed Apply <indeedapply@indeed.com>',
			body: 'Employer: Acme Robotics\n\nYour application has been submitted.',
			category: 'applied', company: 'Acme Robotics', role: 'Backend Engineer', code: 'indeed_applied',
		},
		{
			testName: 'general template — application for: [req] [Role] (CVS, colon form)',
			subject: 'Thank you for your application',
			from: 'CVS Health <noreply@cvshealth.com>',
			body: 'Thank you for your interest in CVS Health. We received your application for: R0859802 Software Development Engineer (Open). We will review it shortly.',
			category: 'applied', company: 'CVS Health', role: 'Software Development Engineer', code: 'general_template',
		},
		{
			testName: 'general template — iCIMS subject "Job Application: ... - [req] [Role] on [date]" (BBH)',
			subject: 'Job Application: Hao Lin Chen - 70363 Junior Java Developer on 04/03/2026',
			from: 'Brown Brothers Harriman <noreply@bbh.com>',
			body: 'Thank you for applying to Brown Brothers Harriman. Your application has been received.',
			category: 'applied', company: 'Brown Brothers', role: 'Junior Java Developer', code: 'general_template',
		},
		{
			testName: 'general template — interest in the [Role] opportunity at [Company] (JetBlue)',
			subject: 'Thank you for your interest in the Engineer, Product Integration (Paisly) at JetBlue',
			from: 'JetBlue <noreply@jetblue.com>',
			body: 'Thank you for your interest in the Engineer, Product Integration (Paisly) opportunity at JetBlue! After careful review we have decided to move forward with other candidates.',
			category: 'rejected', company: 'JetBlue', role: 'Engineer, Product Integration (Paisly)', code: 'general_template',
		},
		{
			testName: 'general template — review your application for the [Role] position (Veeva)',
			subject: 'Your application to Veeva',
			from: 'Veeva <noreply@veeva.com>',
			body: 'Thank you for your interest in Veeva and for giving us the opportunity to review your application for the Associate Quality Engineer position. We have decided to pursue other candidates.',
			category: 'rejected', company: 'Veeva', role: 'Associate Quality Engineer', code: 'general_template',
		},
		{
			testName: 'general template — position of [Role] (Abbott)',
			subject: 'We Received Your Application for Software Engineer I',
			from: 'Abbott <noreply@abbott.com>',
			body: 'Thank you for your interest in Abbott. We received your application for the position of Software Engineer I and will review it.',
			category: 'applied', company: 'Abbott', role: 'Software Engineer I', code: 'general_template',
		},
		{
			testName: 'role-less confirmation parses company+category, leaves role to AI fallback (Rippling)',
			subject: 'Thanks for applying to Rippling',
			from: 'Rippling <no-reply@ats.rippling.com>',
			body: 'Thank you for applying to Rippling! We have received your application and will review it shortly.',
			category: 'applied', company: 'Rippling', role: null, code: 'general_template',
		},
		{
			testName: 'recruiter outreach is NOT a parser hit (defers to filter/LLM)',
			subject: 'Need Locals || Java Full Stack Developer',
			from: 'Mohd <mohdanas@hanstaffing.com>',
			body: 'Our records show that you are an experienced IT professional. Role: Java Full Stack Developer. Please refer them to us; we do have referral bonus.',
			category: '__null__',   // parser returns null → handled by RECRUITER_OUTREACH filter upstream
		},
	];

	for (const c of cases) {
		it(c.testName, () => {
			const res = parseEmail(c.subject, c.from, c.body);
			if (c.category === '__null__') { expect(res).toBeNull(); return; }
			expect(res).not.toBeNull();
			expect(res!.category).toBe(c.category);
			if (c.company) expect(res!.company?.toLowerCase()).toContain(c.company.toLowerCase());
			if (c.role === null) expect(res!.role).toBeNull();
			else if (c.role) expect(tidyRole(res!.role ?? '').toLowerCase()).toContain(c.role.toLowerCase());
			if (c.code) expect(res!.classifier_code).toBe(c.code);
		});
	}
});

// ── buildBody → parseEmail (LinkedIn, end-to-end) ─────────────────────────────
// Locks the real LinkedIn pipeline: the raw plain-text part (messy dividers, a "View job:" URL, and
// the "similar jobs" recommendations below the card) must reduce to the structured card the extractor
// reads. Mirrors the actual Albert Bow email captured from Gmail "Show original".
describe('buildBody + parseEmail (LinkedIn)', () => {
	const msg = (plain: string): gmail_v1.Schema$Message => ({
		payload: { mimeType: 'text/plain', body: { data: Buffer.from(plain).toString('base64url') } },
	});
	const from = 'LinkedIn <jobs-noreply@linkedin.com>';

	it('reads role + brand company from the card and drops the recommendations', () => {
		const plain = [
			'Your application was sent to Albert Bow', '',
			'Software Engineer', 'Albert Bow', 'New York City Metropolitan Area',
			'View job: https://www.linkedin.com/comm/jobs/view/4418756640/?trackingId=abc',
			'', '---------------------------------------------------------', '',
			'Applied on June 15, 2026-------------------------------------',
			'        Now, take these next steps for more success', '',
			'View similar jobs you may be interested in',
			'software engineer- ST, Seattle, WA', 'Starbucks', 'Seattle, WA', 'View job: https://x',
		].join('\n');

		const body = buildBody(msg(plain), from);
		expect(body).not.toMatch(/Starbucks/);            // recommendation dropped
		expect(body).not.toMatch(/https?:\/\//);          // URLs stripped

		const res = parseEmail('Hao Lin, your application was sent to Albert Bow', from, body);
		expect(res).toMatchObject({ category: 'applied', company: 'Albert Bow', role: 'Software Engineer', classifier_code: 'linkedin_applied' });
	});
});

// ── extractGeneralCompanyRole ─────────────────────────────────────────────────
// Pulls company (+role when present) from acknowledgement/rejection sentence structures.
describe('extractGeneralCompanyRole', () => {
	it('applying for the [Role] position at [Company] (Pomelo)', () => {
		const r = extractGeneralCompanyRole('Thanks for applying', 'Thank you for applying for the Software Engineer (All Levels) position at Pomelo Care.');
		expect(r?.company).toContain('Pomelo');
		expect(tidyRole(r?.role ?? '')).toBe('Software Engineer (All Levels)');
	});
	it('review your application for the [Role] position (Veeva)', () => {
		const r = extractGeneralCompanyRole('x', 'Thank you for your interest in Veeva and the opportunity to review your application for the Associate Quality Engineer position.');
		expect(r?.company).toBe('Veeva');
		expect(r?.role).toBe('Associate Quality Engineer');
	});
	it('interest in [Company] (company only, role recovered separately)', () => {
		const r = extractGeneralCompanyRole('x', 'Thank you for your interest in Lockheed Martin. Your application has been received.');
		expect(r?.company).toContain('Lockheed');
	});
	it('returns null for a demographic survey', () => {
		expect(extractGeneralCompanyRole('Survey', 'Please complete this voluntary demographic survey.')).toBeNull();
	});
	it('returns null for a "keep track of your application" draft reminder', () => {
		expect(extractGeneralCompanyRole('Keep track', 'Keep track of your application. If you are still working on the application, finish it here.')).toBeNull();
	});
});

// ── recoverRoleFromBody ───────────────────────────────────────────────────────
// Best-effort role recovery from prose when no primary structure captured it.
describe('recoverRoleFromBody', () => {
	const cases: [string, string, string | null][] = [
		// [body, subject, expected]
		['We have received your application to the following job: Software Engineer, Live and Interactive.', 'None', 'Software Engineer, Live and Interactive'],
		["The team is excited that you're interested in joining us as a QA Automation Engineer (AI Systems & Web Apps).", 'None', 'QA Automation Engineer (AI Systems & Web Apps)'],
		['Unfortunately, the Senior Software Engineer I, Data Enablement role has since been filled.', 'None', 'Senior Software Engineer I, Data Enablement'],
		['We received your application for: R0859802 Software Development Engineer (Open).', 'None', 'Software Development Engineer (Open)'],
		['Your application has been submitted for the following position(s):\nSoftware Engineer Opportunities in NJ 722493BR\nNext steps below.', 'None', 'Software Engineer Opportunities in NJ'],
		['Your application has been received.', 'Job Application: Hao Lin Chen - 70363 Junior Java Developer on 04/03/2026', 'Junior Java Developer'],
		['Just a plain confirmation with no recognizable title anywhere.', 'None', null],
	];
	it.each(cases)('body=%j subject=%j -> %j', (body, subject, expected) => {
		expect(recoverRoleFromBody(body, subject)).toBe(expected);
	});
});
