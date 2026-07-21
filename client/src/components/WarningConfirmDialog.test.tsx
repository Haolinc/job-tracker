import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WarningConfirmDialog from './WarningConfirmDialog';

const user = userEvent.setup();

const renderDialog = (overrides: Partial<React.ComponentProps<typeof WarningConfirmDialog>> = {}) =>
	render(
		<WarningConfirmDialog
			testIdPrefix="delete"
			title="Delete this application?"
			confirmLabel="Delete"
			busyLabel="Deleting…"
			busy={false}
			onCancel={vi.fn()}
			onConfirm={vi.fn()}
			{...overrides}
		>
			Body <span>content</span>
		</WarningConfirmDialog>,
	);

describe('WarningConfirmDialog', () => {
	it('should derive its test ids from the testIdPrefix prop', () => {
		renderDialog({ testIdPrefix: 'reset' });
		expect(screen.getByTestId('reset-confirm-modal')).toBeTruthy();
		expect(screen.getByTestId('reset-confirm')).toBeTruthy();
		expect(screen.getByTestId('reset-cancel')).toBeTruthy();
	});

	it('should render the title, body, and confirm label', () => {
		renderDialog();
		const modal = screen.getByTestId('delete-confirm-modal');
		expect(modal).toHaveTextContent('Delete this application?');
		expect(modal).toHaveTextContent('Body content');
		expect(screen.getByTestId('delete-confirm')).toHaveTextContent('Delete');
	});

	it('should call onConfirm and onCancel from the two buttons', async () => {
		const onConfirm = vi.fn(), onCancel = vi.fn();
		renderDialog({ onConfirm, onCancel });
		await user.click(screen.getByTestId('delete-confirm'));
		await user.click(screen.getByTestId('delete-cancel'));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('should show the busy label and disable the confirm button while busy', () => {
		renderDialog({ busy: true });
		const confirmButton = screen.getByTestId('delete-confirm') as HTMLButtonElement;
		expect(confirmButton).toHaveTextContent('Deleting…');
		expect(confirmButton.disabled).toBe(true);
	});

	it('should render an inline error only when one is supplied', () => {
		const { rerender } = renderDialog();
		expect(screen.queryByTestId('delete-error')).toBeNull();
		rerender(
			<WarningConfirmDialog testIdPrefix="delete" title="t" confirmLabel="Delete" busyLabel="…" busy={false} error="Failed to delete" onCancel={vi.fn()} onConfirm={vi.fn()}>
				body
			</WarningConfirmDialog>,
		);
		expect(screen.getByTestId('delete-error')).toHaveTextContent('Failed to delete');
	});
});
