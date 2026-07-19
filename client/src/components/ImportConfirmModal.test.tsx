import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportConfirmModal, { type PendingUpdate } from './ImportConfirmModal';

const user = userEvent.setup();
const updates: PendingUpdate[] = [
	{ company: 'Acme', role: 'SWE', fields: ['company', 'notes'] },
	{ company: 'Beta Corp', role: 'Backend Dev', fields: ['status'] },
];

describe('ImportConfirmModal', () => {
	it('should list each matched application with human-readable labels for its changed fields', () => {
		render(<ImportConfirmModal addCount={3} updates={updates} onConfirm={vi.fn()} onCancel={vi.fn()} />);
		const list = screen.getByTestId('import-confirm-updates');
		expect(list).toHaveTextContent('Acme — SWE');
		expect(list).toHaveTextContent('Changes: Company, Notes');
		expect(list).toHaveTextContent('Beta Corp — Backend Dev');
		expect(list).toHaveTextContent('Changes: Status');
	});

	it('should call onConfirm("all") when the overwrite button is pressed', async () => {
		const onConfirm = vi.fn();
		render(<ImportConfirmModal addCount={3} updates={updates} onConfirm={onConfirm} onCancel={vi.fn()} />);
		const overwriteButton = screen.getByTestId('import-confirm-overwrite');
		expect(overwriteButton).toHaveTextContent('Update 2 & add 3 new');
		await user.click(overwriteButton);
		expect(onConfirm).toHaveBeenCalledWith('all');
	});

	it('should call onConfirm("add-only") when the add-only button is pressed', async () => {
		const onConfirm = vi.fn();
		render(<ImportConfirmModal addCount={3} updates={updates} onConfirm={onConfirm} onCancel={vi.fn()} />);
		await user.click(screen.getByTestId('import-confirm-add-only'));
		expect(onConfirm).toHaveBeenCalledWith('add-only');
	});

	it('should hide the add-only button when the file has no new rows to add', () => {
		render(<ImportConfirmModal addCount={0} updates={updates} onConfirm={vi.fn()} onCancel={vi.fn()} />);
		expect(screen.queryByTestId('import-confirm-add-only')).toBeNull();
		expect(screen.getByTestId('import-confirm-overwrite')).toHaveTextContent('Update 2 matched');
	});

	it.each([
		['Cancel button', () => user.click(screen.getByTestId('import-confirm-cancel'))],
		['Escape key', () => user.keyboard('{Escape}')],
	] as const)('should call onCancel when the %s is pressed', async (_label, act) => {
		const onCancel = vi.fn();
		render(<ImportConfirmModal addCount={3} updates={updates} onConfirm={vi.fn()} onCancel={onCancel} />);
		await act();
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
