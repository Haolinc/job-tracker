import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EmailLinks from './EmailLinks';
import type { EmailRef } from '../types';

const refs: EmailRef[] = [
	{ messageId: 'm-rej', category: 'rejected',  date: '2026-04-02' },
	{ messageId: 'm-app', category: 'applied',   date: '2026-02-01' },
	{ messageId: 'm-int', category: 'interview', date: '2026-03-10' },
];

describe('EmailLinks', () => {
	it('should render one Gmail link per email, ordered chronologically by date', () => {
		render(<EmailLinks emails={refs} account="me@work.com" />);
		const links = screen.getAllByTestId('email-link');
		expect(links).toHaveLength(3);
		// sorted by date asc → applied, interview, rejected (regardless of input order)
		expect(links.map(a => a.textContent?.trim())).toEqual(['✉ Applied', '✉ Interview', '✉ Rejected']);
	});

	it("should point every link at the application's Gmail account, opening in a new tab", () => {
		render(<EmailLinks emails={[refs[1]]} account="me@work.com" />);   // the 'applied' one
		const link = screen.getByTestId('email-link');
		// authuser=<account> resolves the right mailbox even when it isn't the browser's primary (u/0)
		expect(link).toHaveAttribute('href', 'https://mail.google.com/mail/u/0/?authuser=me%40work.com#all/m-app');
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', 'noopener noreferrer');   // no reverse-tabnabbing
	});

	it('should fall back to the u/0 mailbox when the application has no account', () => {
		render(<EmailLinks emails={[{ messageId: 'm-old', category: 'applied', date: '2026-01-01' }]} />);
		expect(screen.getByTestId('email-link')).toHaveAttribute('href', 'https://mail.google.com/mail/u/0/#all/m-old');
	});

	it('should render nothing when there are no tracked emails', () => {
		render(<EmailLinks emails={[]} />);
		expect(screen.queryByTestId('email-links')).toBeNull();
		expect(screen.queryByTestId('email-link')).toBeNull();
	});
});
