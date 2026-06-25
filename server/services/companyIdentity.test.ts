import { describe, it, expect } from 'vitest';
import { normalizeCompany, companyDomainFromSender, companiesSameEntity } from './companyIdentity';

describe('normalizeCompany', () => {
	it('strips trailing legal suffixes', () => {
		expect(normalizeCompany('Sun West Mortgage Company')).toBe('Sun West Mortgage');
		expect(normalizeCompany('Acme, Inc.')).toBe('Acme');
		expect(normalizeCompany('Globex LLC')).toBe('Globex');
		expect(normalizeCompany('Initech Corp.')).toBe('Initech');
	});
	it('does NOT strip "Co." when it is part of "& Co." (no word char before it)', () => {
		expect(normalizeCompany('Foo & Co.')).toBe('Foo & Co.');
	});
	it('resolves a "dba" trade name', () => {
		expect(normalizeCompany('CP Payroll, LLC dba ConnectPay')).toBe('ConnectPay');
		expect(normalizeCompany('Big Box d/b/a Shopwise')).toBe('Shopwise');
	});
	it('drops a LinkedIn company-page qualifier', () => {
		expect(normalizeCompany('CLEAR - Corporate')).toBe('CLEAR');
		expect(normalizeCompany('Acme - North America')).toBe('Acme');
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
});
