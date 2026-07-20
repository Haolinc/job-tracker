import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportConfirmModal, { type PendingUpdate } from './ImportConfirmModal';
import type { ComponentProps } from 'react';

const user = userEvent.setup();
const updates: PendingUpdate[] = [
	{ company: 'Acme', role: 'SWE', fields: ['company', 'notes'], suspicious: false },
	{ company: 'Beta Corp', role: 'Backend Dev', fields: ['status'], suspicious: false },
];

// Render with sensible defaults so each test only spells out what it exercises.
const renderModal = (overrides: Partial<ComponentProps<typeof ImportConfirmModal>> = {}) =>
	render(<ImportConfirmModal
		addCount={3}
		addOnlyCount={3}
		updates={updates}
		moves={[]}
		deletes={[]}
		onConfirm={vi.fn()}
		onCancel={vi.fn()}
		{...overrides}
	/>);

describe('ImportConfirmModal', () => {
	it('should list each matched application with human-readable labels for its changed fields', () => {
		renderModal();
		const list = screen.getByTestId('import-confirm-updates');
		expect(list).toHaveTextContent('Acme — SWE');
		expect(list).toHaveTextContent('Changes: Company, Notes');
		expect(list).toHaveTextContent('Beta Corp — Backend Dev');
		expect(list).toHaveTextContent('Changes: Status');
	});

	it('should warn on a suspicious id match and stay quiet on normal ones', () => {
		renderModal({ updates: [
			{ company: 'Acme', role: 'SWE', fields: ['company'], suspicious: false },
			{ company: 'Unrelated Co', role: 'PM', fields: ['company', 'emails'], suspicious: true },
		] });
		expect(screen.getAllByTestId('import-confirm-suspicious')).toHaveLength(1);
		expect(screen.getByTestId('import-confirm-suspicious')).toHaveTextContent(/Doesn't look like the same application/);
	});

	it('should list each email move so a merge is never silent', () => {
		renderModal({ moves: [
			{ messageId: 'm-rej', fromCompany: 'Distyl', toCompany: 'Distyl AI' },
		] });
		const move = screen.getByTestId('import-confirm-move');
		expect(move).toHaveTextContent('m-rej');
		expect(move).toHaveTextContent('Distyl');
		expect(move).toHaveTextContent('Distyl AI');
	});

	it('should list each application the merge would delete', () => {
		renderModal({ deletes: [{ company: 'Distyl', role: 'SWE' }] });
		expect(screen.getByTestId('import-confirm-delete')).toHaveTextContent('Distyl — SWE');
	});

	it('should call onConfirm("all") when the overwrite button is pressed', async () => {
		const onConfirm = vi.fn();
		renderModal({ onConfirm });
		const overwriteButton = screen.getByTestId('import-confirm-overwrite');
		expect(overwriteButton).toHaveTextContent('Update 2 & add 3 new');
		await user.click(overwriteButton);
		expect(onConfirm).toHaveBeenCalledWith('all');
	});

	it('should call onConfirm("add-only") and label the button with the SAFE add count', async () => {
		const onConfirm = vi.fn();
		// One of the three creates is a conflict fallback — only two are safe to add alone.
		renderModal({ onConfirm, addCount: 3, addOnlyCount: 2 });
		const addOnlyButton = screen.getByTestId('import-confirm-add-only');
		expect(addOnlyButton).toHaveTextContent('Add 2 new only');
		await user.click(addOnlyButton);
		expect(onConfirm).toHaveBeenCalledWith('add-only');
	});

	it('should hide the add-only button when nothing can be added without updating', () => {
		renderModal({ addCount: 0, addOnlyCount: 0 });
		expect(screen.queryByTestId('import-confirm-add-only')).toBeNull();
		expect(screen.getByTestId('import-confirm-overwrite')).toHaveTextContent('Update 2 matched');
	});

	it.each([
		['Cancel button', () => user.click(screen.getByTestId('import-confirm-cancel'))],
		['Escape key', () => user.keyboard('{Escape}')],
	] as const)('should call onCancel when the %s is pressed', async (_label, act) => {
		const onCancel = vi.fn();
		renderModal({ onCancel });
		await act();
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
