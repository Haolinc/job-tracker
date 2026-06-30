// Patterns that identify automated / non-application emails, matched BEFORE the parser/LLM so a sync
// spends no inference on them.

// Subject-based: auto-replies, interview/calendar confirmations, job alerts, account-activation / magic
// links, and a few ATS portal-reminder stragglers.
export const AUTOMATED_SUBJECT = new RegExp(
	[
		'^automatic reply',
		'^auto:',
		'^out of office',
		'interview confirmation',
		'interview confirmed',
		'your interview (is|has been) (confirmed|scheduled)',
		'has been scheduled',
		'calendar invite',
		'meeting confirmed',
		'reminder',
		'jobs? alert',
		'new jobs? for you',
		'\\d+ new jobs?',
		'your career opportunities at',       // recruitment marketing, not application confirmation
		// Account-activation / email-verification / OTP emails from ATS portals — the application is NOT yet
		// submitted (e.g. Siemens "Email address validation request", or a "Your verification code" /
		// one-time-passcode email), so this isn't an application event. "one[\s-]?time" matches the
		// hyphen, space, and run-together spellings (one-time / one time / onetime).
		'email address validation',
		'verify your email',
		'confirm your email',
		'verification code',
		'one[\\s-]?time',
		'activate your account',
		// Auth / magic-link emails from ATS portals (e.g. ClearCompany "Sign-in link for your application
		// at …") — a login link to RESUME an application, not an application event. The body often names
		// the role, so without this filter it wrongly spawns/updates a record.
		'sign[\\s-]?in link',
		'log[\\s-]?in link',
		'magic link',
		// Glassdoor post-application feedback survey — runtime backstop; Gmail query
		// already excludes by subject, but these emails DO match the keywordFilter
		// ("your application"), so a fetched straggler would still be skipped here.
		'quick question about your application at',
		// Jacobs generic portal-reminder emails — subject is exactly "Jacobs - Application Update"
		// with no role after it. The valid Jacobs emails always have ", [Role]" after "Update".
		'jacobs - application update(?!,)',
	].join('|'),
	'i',
);

export const AUTOMATED_FROM = /calendly\./i;

// Staffing-agency COLD OUTREACH (a recruiter pitching a contract role), not an application event. Matched
// on the BODY because the subject is usually just the role title. Each phrase is mass-mail-specific and
// ~never appears in an employer's own confirmation/rejection, so a single hit is enough to skip the email.
export const RECRUITER_OUTREACH = /\bplanning to make a change\b|\bknow of a friend\b|\breferral bonus\b|\bour records (?:show|indicate)\b|\bmy current opening|\beven if we have spoken recently\b|\b(?:c2c|corp[\s-]?to[\s-]?corp|w-?2|1099|contract to hire)\b/i;

/** True when an email is automated/non-application noise and should be skipped before parsing/LLM. */
export function isIgnorableEmail(subject: string, from: string, body: string): boolean {
	return AUTOMATED_SUBJECT.test(subject) || AUTOMATED_FROM.test(from) || RECRUITER_OUTREACH.test(body);
}
