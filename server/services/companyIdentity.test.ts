import { describe, it, expect } from 'vitest';
import { companyTradeName, companyDomainFromSender, companiesSameEntity } from './companyIdentity';

describe('companyTradeName', () => {
	it('keeps a legal suffix — it is part of the employer’s own name', () => {
		// The parsers capture the company verbatim from the email; nothing downstream may edit that wording.
		// Two spellings of one employer are reconciled by companiesSameEntity at match time, not by truncation.
		expect(companyTradeName('Sun West Mortgage Company')).toBe('Sun West Mortgage Company');
		expect(companyTradeName('Acme, Inc.')).toBe('Acme, Inc.');
		expect(companyTradeName('Globex LLC')).toBe('Globex LLC');
		expect(companyTradeName('Loyola Enterprises Inc.')).toBe('Loyola Enterprises Inc.');
		expect(companyTradeName('Foo & Co.')).toBe('Foo & Co.');
	});
	it('resolves a "dba" trade name', () => {
		expect(companyTradeName('CP Payroll, LLC dba ConnectPay')).toBe('ConnectPay');
		expect(companyTradeName('Big Box d/b/a Shopwise')).toBe('Shopwise');
	});
	it('drops a LinkedIn company-page qualifier', () => {
		expect(companyTradeName('CLEAR - Corporate')).toBe('CLEAR');
		expect(companyTradeName('Acme - North America')).toBe('Acme');
	});
});

// The suffix truncation companyTradeName no longer does now has to hold HERE instead — this is what keeps a
// confirmation naming the legal entity and a rejection naming the brand on one record.
describe('companiesSameEntity — absorbs the legal suffix the stored name now keeps', () => {
	it('matches a suffixed name against its bare form', () => {
		expect(companiesSameEntity('Loyola Enterprises Inc.', 'Loyola Enterprises')).toBe(true);
		expect(companiesSameEntity('Acme, Inc.', 'Acme')).toBe(true);
		expect(companiesSameEntity('Sun West Mortgage Company', 'Sun West Mortgage')).toBe(true);
	});
});

describe('companyDomainFromSender', () => {
	it('returns the registrable domain for a real company sender', () => {
		expect(companyDomainFromSender('careers@epic.com')).toBe('epic.com');
		expect(companyDomainFromSender('Jane Doe <talent@anthropic.com>')).toBe('anthropic.com');
		expect(companyDomainFromSender('noreply@careers.epic.com')).toBe('epic.com');   // strips subdomain
	});
	it('keeps the 3-label registrable domain for multi-part TLDs', () => {
		expect(companyDomainFromSender('jobs@careers.acme.co.uk')).toBe('acme.co.uk');   // not the shared "co.uk"
	});
	it('returns null for ATS / job-board / generic-provider senders', () => {
		expect(companyDomainFromSender('noreply@greenhouse.io')).toBeNull();
		expect(companyDomainFromSender('jobs@linkedin.com')).toBeNull();
		expect(companyDomainFromSender('x@myworkday.com')).toBeNull();
		expect(companyDomainFromSender('me@gmail.com')).toBeNull();
	});
	it('returns null for a subdomained ATS host and a regional ATS TLD', () => {
		expect(companyDomainFromSender('recruiting@us.greenhouse-mail.io')).toBeNull();
		expect(companyDomainFromSender('noreply@talent.icims.eu')).toBeNull();   // brand match, alternate TLD
	});
	it('returns null when there is no parseable email', () => {
		expect(companyDomainFromSender('The Hiring Team')).toBeNull();
	});
});

describe('companiesSameEntity', () => {
	it('is true when the longer name only ADDS generic descriptors', () => {
		expect(companiesSameEntity('SS&C', 'SS&C Technologies')).toBe(true);
		expect(companiesSameEntity('Fora', 'Fora Travel')).toBe(true);
		expect(companiesSameEntity('Lila', 'Lila Sciences')).toBe(true);
	});
	it('is false when the extra word is a distinct proper noun', () => {
		expect(companiesSameEntity('Epic', 'Epic Kids')).toBe(false);
	});
	it('is false when a shared-position word differs', () => {
		expect(companiesSameEntity('Morgan Stanley', 'Morgan Lewis')).toBe(false);
	});
	it('is false for a different first word entirely', () => {
		expect(companiesSameEntity('Lila', 'Lilac')).toBe(false);
	});
	it('is true across spacing/punctuation/case differences (parser vs classifier disagree on spelling)', () => {
		// The exact regression: the parser reads body "JPMorganChase", the classifier reads sender "JPMorgan
		// Chase" — same employer, and they must merge instead of fragmenting the application.
		expect(companiesSameEntity('JPMorganChase', 'JPMorgan Chase')).toBe(true);
		expect(companiesSameEntity('MITRE', 'mitre')).toBe(true);
		expect(companiesSameEntity('Morgan & Morgan', 'Morgan and Morgan')).toBe(false);   // '&' vs 'and' → distinct keys, not collapsed together
	});
	it('does not let the collapse key override a genuinely different second word', () => {
		// "Epic" vs "Epic Kids" must still be distinct — collapse equality only fires on the WHOLE name.
		expect(companiesSameEntity('Epic', 'EpicKids')).toBe(false);
	});
});
