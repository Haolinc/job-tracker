import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportResultModal, { type ImportOutcome } from './ImportResultModal';

const user = userEvent.setup();
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
});
