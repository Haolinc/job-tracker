import { useEffect, useRef } from 'react';

// Human labels for the changed fields shown per row — mirror the export's column headers.
const FIELD_LABELS: Record<string, string> = {
	company: 'Company',
	role: 'Role',
	status: 'Status',
	interview_step: 'Stage',
	reached_interview: 'Reached Interview',
	date_applied: 'Date Applied',
	last_activity: 'Last Response',
	job_url: 'Job URL',
	notes: 'Notes',
	external_id: 'Job ID',
	account: 'Gmail Account',
	emails: 'Emails',
};

/** One board application the CSV would overwrite: who it is + which fields would change. */
export interface PendingUpdate {
	company: string;
	role: string;
	fields: string[];   // raw field names of the cells that differ (labelled via FIELD_LABELS)
}

interface Props {
	addCount: number;          // brand-new rows that will be added either way
	updates: PendingUpdate[];  // matched rows whose edits need the user's go-ahead
	onConfirm: (mode: 'all' | 'add-only') => void;
	onCancel: () => void;
}

/**
 * Shown when an imported CSV matches applications already on the board with edited cells.
 * The user decides whether the file's values overwrite the board ("all"), or whether only the
 * brand-new rows are added ("add-only") — the guard against a CSV from another machine whose
 * ids happen to collide with unrelated local applications.
 */
export default function ImportConfirmModal({ addCount, updates, onConfirm, onCancel }: Props) {
	const overwriteButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		overwriteButtonRef.current?.focus();
		const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [onCancel]);

	return (
		<div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onCancel}>
			<div
				data-testid="import-confirm-modal"
				role="dialog"
				aria-modal="true"
				onClick={event => event.stopPropagation()}
				className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6"
			>
				<div className="mx-auto mb-4 flex items-center justify-center w-12 h-12 rounded-full text-2xl font-bold bg-amber-100 text-amber-600">!</div>

				<h2 className="text-lg font-semibold text-gray-800 text-center">Overwrite matched applications?</h2>
				<p className="mt-2 text-sm text-gray-500 text-center">
					This file matches <span className="font-semibold text-gray-700">{updates.length} application{updates.length === 1 ? '' : 's'}</span> already
					on your board with edited cells{addCount > 0 && <> and adds <span className="font-semibold text-gray-700">{addCount} new</span></>}.
					Check the list — if these aren&apos;t rows you edited, add only.
				</p>

				<div data-testid="import-confirm-updates" className="mt-4 rounded-xl border border-gray-100 divide-y divide-gray-100 max-h-48 overflow-y-auto">
					{updates.map((pendingUpdate, index) => (
						<div key={index} className="px-4 py-2.5 text-sm">
							<div className="font-medium text-gray-800">{pendingUpdate.company} — {pendingUpdate.role}</div>
							<div className="text-xs text-gray-500">Changes: {pendingUpdate.fields.map(fieldName => FIELD_LABELS[fieldName] ?? fieldName).join(', ')}</div>
						</div>
					))}
				</div>

				<div className="mt-5 flex flex-col gap-2">
					<button
						data-testid="import-confirm-overwrite"
						ref={overwriteButtonRef}
						onClick={() => onConfirm('all')}
						className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
					>
						{addCount > 0
							? `Update ${updates.length} & add ${addCount} new`
							: `Update ${updates.length} matched`}
					</button>
					{addCount > 0 && (
						<button
							data-testid="import-confirm-add-only"
							onClick={() => onConfirm('add-only')}
							className="w-full px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50"
						>
							Add {addCount} new only
						</button>
					)}
					<button
						data-testid="import-confirm-cancel"
						onClick={onCancel}
						className="w-full px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-50"
					>
						Cancel import
					</button>
				</div>
			</div>
		</div>
	);
}
