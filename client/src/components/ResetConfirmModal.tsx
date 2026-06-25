interface ResetConfirmModalProps {
	applicationCount: number;
	resetting: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}

/** Confirmation dialog for the destructive "Reset DB" action (wipes applications + sync history). */
export default function ResetConfirmModal({ applicationCount, resetting, onCancel, onConfirm }: ResetConfirmModalProps) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
			<div data-testid="reset-confirm-modal" className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
				<div className="text-3xl mb-3 text-center">⚠️</div>
				<h2 className="text-lg font-bold text-gray-900 text-center mb-1">Reset database?</h2>
				<p className="text-sm text-gray-500 text-center mb-6">
					This deletes <span className="font-semibold text-gray-700">all {applicationCount} applications</span> and
					clears the Gmail sync history, so the next sync re-processes everything from scratch.
					This cannot be undone.
				</p>
				<div className="flex gap-3">
					<button
						data-testid="reset-cancel"
						onClick={onCancel}
						className="flex-1 px-4 py-2 border border-gray-200 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-50"
					>
						Cancel
					</button>
					<button
						data-testid="reset-confirm"
						onClick={onConfirm}
						disabled={resetting}
						className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
					>
						{resetting ? 'Resetting…' : 'Yes, reset everything'}
					</button>
				</div>
			</div>
		</div>
	);
}
