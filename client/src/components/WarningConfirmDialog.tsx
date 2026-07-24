import type { ReactNode } from 'react';

interface WarningConfirmDialogProps {
	// Prefix for the dialog's test ids: renders `${testIdPrefix}-confirm-modal` (root),
	// `${testIdPrefix}-confirm`, `${testIdPrefix}-cancel`, and `${testIdPrefix}-error`.
	testIdPrefix: string;
	title: string;
	confirmLabel: string;
	busyLabel: string;
	busy: boolean;
	error?: string | null;
	children: ReactNode;   // the warning message body
	onCancel: () => void;
	onConfirm: () => void;
	// Label for the decline button — defaults to "Cancel", but a dialog about cancelling something wants a
	// clearer word (e.g. "Keep syncing") so the two buttons don't both read like "cancel".
	cancelLabel?: string;
}

/**
 * Shared dialog for DESTRUCTIVE, irreversible confirmations (delete an application, reset the
 * database, …): a ⚠️ header, a caller-supplied message, and Cancel / danger-Confirm buttons with a
 * busy state and an optional inline error. Click-outside cancels. Deliberately scoped to warnings —
 * not a general-purpose yes/no prompt — so the red confirm button always signals real consequences.
 */
export default function WarningConfirmDialog({
	testIdPrefix, title, confirmLabel, busyLabel, busy, error, children, onCancel, onConfirm, cancelLabel = 'Cancel',
}: WarningConfirmDialogProps) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
			<div
				data-testid={`${testIdPrefix}-confirm-modal`}
				className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4"
				onClick={event => event.stopPropagation()}
			>
				<div className="text-3xl mb-3 text-center">⚠️</div>
				<h2 className="text-lg font-bold text-gray-900 text-center mb-1">{title}</h2>
				<div className="text-sm text-gray-500 text-center mb-6">{children}</div>
				{error && <p data-testid={`${testIdPrefix}-error`} className="text-sm text-red-600 text-center mb-4">{error}</p>}
				<div className="flex gap-3">
					<button
						data-testid={`${testIdPrefix}-cancel`}
						onClick={onCancel}
						className="flex-1 px-4 py-2 border border-gray-200 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-50"
					>
						{cancelLabel}
					</button>
					<button
						data-testid={`${testIdPrefix}-confirm`}
						onClick={onConfirm}
						disabled={busy}
						className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
					>
						{busy ? busyLabel : confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
