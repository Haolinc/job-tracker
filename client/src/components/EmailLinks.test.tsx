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
	it('should render one Gmail link per email in the order they are stored', () => {
		render(<EmailLinks emails={refs} account="me@work.com" />);
		const links = screen.getAllByTestId('email-link');
		expect(links).toHaveLength(3);
		// Stored order is the display order — it's what the user arranges in the edit modal, so it is never re-sorted.
		expect(links.map(link => link.textContent?.trim())).toEqual(['✉ Rejected', '✉ Applied', '✉ Interview']);
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

	it('should keep the pills as plain links — reordering lives in the edit modal, not on the card', () => {
		render(<EmailLinks emails={refs} account="me@work.com" />);
		for (const link of screen.getAllByTestId('email-link')) expect(link).not.toHaveAttribute('draggable');
	});

	it('labels a fast-apply notice "⚡ Fast Applied" while other emails keep their stage label', () => {
		render(<EmailLinks emails={[
			{ messageId: 'm-fast', category: 'applied',  date: '2026-02-01', fast_apply: true },
			{ messageId: 'm-rej',  category: 'rejected', date: '2026-04-02' },
		]} account="me@work.com" />);
		const links = screen.getAllByTestId('email-link');
		expect(links.map(link => link.textContent?.trim())).toEqual(['⚡ Fast Applied', '✉ Rejected']);
	});
});
