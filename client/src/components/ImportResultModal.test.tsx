import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportResultModal, { type ImportOutcome } from './ImportResultModal';
import { parseApplicationsCsv } from '../utils/importCsv';
import { applicationsToCsv } from '../utils/exportCsv';
import { makeApp } from '../test-utils';
import type { EmailRef } from '../types';

const user = userEvent.setup();

// Run a CSV through the real parser and return the rejection message it throws — so the modal tests
// below assert against the exact duplicate-id text the user would see, not a hand-written copy of it.
function rejectionMessageFor(csv: string): string {
	try { parseApplicationsCsv(csv); } catch (error) { return (error as Error).message; }
	throw new Error('expected the file to be rejected, but it parsed cleanly');
}
const outcome: ImportOutcome = {
	tone: 'success', title: 'Import complete',
	stats: [{ label: 'Imported', value: 12 }, { label: 'Skipped', value: 3 }],
};

describe('ImportResultModal', () => {
	it('should render the title and stats when given an outcome', () => {
		render(<ImportResultModal outcome={outcome} onClose={vi.fn()} />);
		const modal = screen.getByTestId('import-result-modal');
		expect(modal).toHaveTextContent('Import complete');
		expect(modal).toHaveTextContent('Imported');
		expect(modal).toHaveTextContent('12');
		expect(modal).toHaveTextContent('✓');                       // success icon
	});

	it('should render an error outcome with its message and NO stats table', () => {
		const errored: ImportOutcome = { tone: 'error', title: 'Import failed', message: 'Could not parse the CSV file.' };
		render(<ImportResultModal outcome={errored} onClose={vi.fn()} />);
		const modal = screen.getByTestId('import-result-modal');
		expect(modal).toHaveTextContent('Import failed');
		expect(modal).toHaveTextContent('Could not parse the CSV file.');
		expect(modal).toHaveTextContent('✕');                       // error icon
		expect(screen.queryByTestId('import-result-stats')).toBeNull();   // breakdown absent when there are no stats
	});

	it('should render a "nothing imported" outcome as a message with NO breakdown', () => {
		const nothing: ImportOutcome = { tone: 'warning', title: 'Nothing to import', message: 'No new applications were found in the file.' };
		render(<ImportResultModal outcome={nothing} onClose={vi.fn()} />);
		const modal = screen.getByTestId('import-result-modal');
		expect(modal).toHaveTextContent('Nothing to import');
		expect(modal).toHaveTextContent('No new applications were found in the file.');
		expect(modal).toHaveTextContent('!');                       // warning icon
		expect(screen.queryByTestId('import-result-stats')).toBeNull();
	});

	it('should NOT render the stats table when the stats array is empty', () => {
		render(<ImportResultModal outcome={{ tone: 'success', title: 'Done', stats: [] }} onClose={vi.fn()} />);
		expect(screen.queryByTestId('import-result-stats')).toBeNull();   // length-0 guard, not just the undefined case
	});

	it.each([
		['Done button', () => user.click(screen.getByTestId('import-result-done'))],
		['Escape key', () => user.keyboard('{Escape}')],
	] as const)('should call onClose when the %s is pressed', async (_label, act) => {
		const onClose = vi.fn();
		render(<ImportResultModal outcome={outcome} onClose={onClose} />);
		await act();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// The duplicate-id rejection is the one place the modal's freeform message carries user-actionable
	// detail (which ids, which rows). These assert the real parser text reaches the screen intact.
	describe('duplicate-id file rejection', () => {
		it('should show both the duplicate application id and duplicate email id lines', () => {
			const shared: EmailRef = { messageId: 'm-shared', category: 'rejected', date: '2026-06-30' };
			const acme = makeApp({ id: '7', company: 'Acme', role: 'SWE' });
			const distyl = makeApp({ id: '9', company: 'Distyl', role: 'DS', emails: [shared] });
			const distylAi = makeApp({ id: '10', company: 'Distyl AI', role: 'DS', emails: [shared] });
			const message = rejectionMessageFor(applicationsToCsv([acme, { ...acme, company: 'Acme Corp' }, distyl, distylAi]));

			render(<ImportResultModal outcome={{ tone: 'error', title: 'Import failed', message }} onClose={vi.fn()} />);
			const modal = screen.getByTestId('import-result-modal');
			expect(modal).toHaveTextContent('Application id 7 appears in rows 2, 3 (Acme, Acme Corp) — remove it from all but one row.');
			expect(modal).toHaveTextContent('Email m-shared appears in rows 4, 5 (Distyl, Distyl AI) — remove it from all but one row.');
			expect(modal).toHaveTextContent('✕');                            // error icon, not a stats breakdown
			expect(screen.queryByTestId('import-result-stats')).toBeNull();
		});

		it('should show the in-cell duplicate email message, naming the row', () => {
			const message = rejectionMessageFor('Company,Role,Emails\r\nAcme,SWE,applied|m-dup|2026-01-01 ; rejected|m-dup|2026-02-01');
			render(<ImportResultModal outcome={{ tone: 'error', title: 'Import failed', message }} onClose={vi.fn()} />);
			expect(screen.getByTestId('import-result-modal'))
				.toHaveTextContent('Email m-dup is listed 2 times in row 2 (Acme) — remove the extra copies.');
		});

		it('should keep each problem on its own line (whitespace-pre-line, real newlines preserved)', () => {
			const shared: EmailRef = { messageId: 'm-2', category: 'applied', date: '2026-01-01' };
			const one = makeApp({ id: '3', company: 'Beta', role: 'PM', emails: [shared] });
			const two = makeApp({ id: '4', company: 'Gamma', role: 'PM', emails: [shared] });
			const message = rejectionMessageFor(applicationsToCsv([one, two, { ...one, id: '3', company: 'Beta 2' }]));

			render(<ImportResultModal outcome={{ tone: 'error', title: 'Import failed', message }} onClose={vi.fn()} />);
			const paragraph = screen.getByTestId('import-result-modal').querySelector('p');
			// Two distinct problems (id 3 twice, email m-2 twice) joined by a newline the CSS renders as a break.
			expect(paragraph?.textContent).toContain('\n');
			expect(paragraph?.className).toContain('whitespace-pre-line');
		});
	});
});
