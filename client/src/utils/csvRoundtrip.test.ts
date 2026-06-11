import { describe, it, expect } from 'vitest';
import { applicationsToCsv } from './exportCsv';
import { parseApplicationsCsv } from './importCsv';
import { makeApp } from '../test-utils';
import type { EmailRef } from '../types';

const emails: EmailRef[] = [
	{ messageId: 'm-app', category: 'applied',   date: '2026-02-01' },
	{ messageId: 'm-int', category: 'interview', date: '2026-03-10' },
];

describe('CSV export → import round-trip', () => {
	it('should preserve the Gmail account and tracked emails across an export/import', () => {
		const app = makeApp({ company: 'CVS Health', role: 'SWE', account: 'me@work.com', emails });
		const [imported] = parseApplicationsCsv(applicationsToCsv([app]));
		expect(imported.account).toBe('me@work.com');
		expect(imported.emails).toEqual(emails);
	});

	it('should default account to null and emails to [] when those columns are blank', () => {
		const app = makeApp({ company: 'Acme', role: 'SWE', account: null, emails: [] });
		const [imported] = parseApplicationsCsv(applicationsToCsv([app]));
		expect(imported.account).toBeNull();
		expect(imported.emails).toEqual([]);
	});
});
