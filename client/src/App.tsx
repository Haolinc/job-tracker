import { useState, useEffect, useRef } from 'react';
import Board from './components/Board';
import TableView from './components/TableView';
import AddModal from './components/AddModal';
import StatsBar from './components/StatsBar';
import GmailSync from './components/GmailSync';
import Filters from './components/Filters';
import ImportResultModal, { type ImportOutcome } from './components/ImportResultModal';
import { getApplications, resetDatabase } from './api';
import { useApplications } from './hooks/useApplications';
import { useGmailSync } from './hooks/useGmailSync';
import { downloadApplicationsCsv } from './utils/exportCsv';
import { parseApplicationsCsv, CsvImportError } from './utils/importCsv';
import type { Application, ApplicationFormData, Filters as FiltersType } from './types';

type View = 'board' | 'table';

export default function App() {
	const { applications, loading, fetchAll, add, update, remove } = useApplications();
	const { connected, syncing, progress, lastResult, error: syncError, checkStatus, disconnect, sync } = useGmailSync();

	const [filters, setFilters] = useState<FiltersType>({ search: '' });
	const [modal, setModal] = useState<Partial<ApplicationFormData> | null>(null);
	const [view, setView] = useState<View>('board');

	// Ids touched by the most recent sync OR import (created OR updated) — highlighted as "new".
	// In-memory only, so a page refresh clears the effect; set once, so later edits don't light up.
	const [newlyAdded, setNewlyAdded] = useState<Set<string>>(new Set());

	const fileInputRef = useRef<HTMLInputElement>(null);
	const [importResult, setImportResult] = useState<ImportOutcome | null>(null);
	const [showResetConfirm, setShowResetConfirm] = useState(false);
	const [resetting, setResetting] = useState(false);

	useEffect(() => {
		fetchAll(filters);
	}, [filters, fetchAll]);

	useEffect(() => {
		checkStatus();
		const params = new URLSearchParams(window.location.search);
		if (params.get('gmail') === 'connected') {
			window.history.replaceState({}, '', '/');
		}
	}, [checkStatus]);

	const handleSave = async (form: ApplicationFormData) => {
		const { interview_step, date_applied, last_activity, job_url, external_id, notes, ...rest } = form;
		const cleaned = {
			...rest,
			interview_step: interview_step || null,
			date_applied: date_applied || null,
			last_activity: last_activity || null,
			job_url: job_url || null,
			external_id: external_id.trim() || null,
			notes: notes || null,
		};
		if (form.id) {
			await update(form.id, cleaned as Partial<Application>);
		} else {
			await add({ ...cleaned, source: 'manual', gmail_thread_id: null });
		}
		setModal(null);
		fetchAll(filters);
	};

	const handleDelete = async (id: string) => {
		if (confirm('Delete this application?')) {
			try {
				await remove(id);
			} catch {
				alert('Failed to delete. Please try again.');
			}
		}
	};

	const handleImport = async (file: File) => {
		let parsed;
		try {
			parsed = parseApplicationsCsv(await file.text());
		} catch (e) {
			// A CsvImportError carries a user-facing reason (no Company column, a row missing a
			// company, …); the whole sheet is rejected and nothing is imported.
			setImportResult({
				tone: 'error',
				title: 'Import failed',
				message: e instanceof CsvImportError ? e.message : 'Could not read that file as CSV.',
			});
			return;
		}
		if (parsed.length === 0) {
			setImportResult({ tone: 'warning', title: 'Nothing to import', message: 'No applications were found in that CSV.' });
			return;
		}
		// Same company + role (case-insensitive) == same application, so skip it. Dedup against the
		// COMPLETE board — fetched fresh and unfiltered, since the in-memory `applications` list is
		// narrowed by an active search filter and can be momentarily stale — AND against earlier rows
		// in this same file, since a CSV can list the same company+role more than once (e.g. rows that
		// differ only by date/status). Without the in-file guard, those rows would all be added.
		const key = (company: string, role: string) => `${company.trim().toLowerCase()}|||${role.trim().toLowerCase()}`;
		const seen = new Set((await getApplications()).map(a => key(a.company, a.role)));
		const toAdd = parsed.filter(a => {
			const k = key(a.company, a.role);
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
		const duplicates = parsed.length - toAdd.length;

		const results = await Promise.allSettled(toAdd.map(a => add(a)));
		const created = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
		const failed = results.length - created.length;

		await fetchAll(filters);
		setNewlyAdded(new Set(created.map(a => a.id)));

		setImportResult({
			tone: failed > 0 || created.length === 0 ? 'warning' : 'success',
			title: created.length > 0 ? 'Import complete' : 'Nothing new to import',
			message: created.length === 0 ? 'Every row was already on your board.' : undefined,
			stats: [
				{ label: 'Imported', value: created.length, cls: 'text-emerald-600' },
				...(duplicates ? [{ label: 'Skipped (already on board)', value: duplicates, cls: 'text-gray-500' }] : []),
				...(failed ? [{ label: 'Failed', value: failed, cls: 'text-red-600' }] : []),
			],
		});
	};

	const handleReset = async () => {
		setResetting(true);
		try {
			await resetDatabase();
			setNewlyAdded(new Set());
			await fetchAll(filters);
		} finally {
			setResetting(false);
			setShowResetConfirm(false);
		}
	};

	const handleSync = async (days: number) => {
		// Snapshot updated_at per id before syncing; after the refetch, anything new or with a bumped
		// updated_at was touched by this sync and gets the "new" highlight.
		const before = new Map(applications.map(a => [a.id, a.updated_at]));
		try {
			await sync(days);
			const fresh = await fetchAll(filters);
			setNewlyAdded(new Set((fresh ?? []).filter(a => before.get(a.id) !== a.updated_at).map(a => a.id)));
		} catch { /* error shown in GmailSync via syncError */ }
	};

	return (
		<div className="min-h-screen bg-gray-50">
			<header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4">
				<div className="max-w-screen-xl mx-auto flex flex-wrap items-center justify-between gap-3">
					<h1 className="text-xl font-bold text-gray-900">Job Tracker</h1>
					<GmailSync
						connected={connected}
						syncing={syncing}
						progress={progress}
						lastResult={lastResult}
						error={syncError}
						onConnect={() => { window.location.href = '/api/auth/google'; }}
						onDisconnect={disconnect}
						onSync={handleSync}
					/>
				</div>
			</header>

			<main className="max-w-screen-xl mx-auto px-4 sm:px-6 py-4 sm:py-6 space-y-4">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<StatsBar applications={applications} />
					<div className="flex flex-wrap items-center gap-2">
						<div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm font-medium">
							<button
								data-testid="view-board"
								onClick={() => setView('board')}
								className={`px-3 py-2 ${view === 'board' ? 'bg-gray-100 text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
							>⊞ Board</button>
							<button
								data-testid="view-table"
								onClick={() => setView('table')}
								className={`px-3 py-2 border-l border-gray-200 ${view === 'table' ? 'bg-gray-100 text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
							>☰ Table</button>
						</div>
						<div className="w-px h-6 bg-gray-300 mx-1" />
						<input
							ref={fileInputRef}
							type="file"
							accept=".csv,text/csv"
							className="hidden"
							onChange={e => {
								const file = e.target.files?.[0];
								e.target.value = '';
								if (file) handleImport(file);
							}}
						/>
						<button
							data-testid="btn-import-csv"
							onClick={() => fileInputRef.current?.click()}
							className="px-3 py-2 border border-emerald-200 bg-white text-emerald-700 text-sm font-medium rounded-lg hover:bg-emerald-100"
							title="Import applications from a CSV file"
						>
							⤒ Import CSV
						</button>
						<button
							data-testid="btn-export-csv"
							onClick={() => downloadApplicationsCsv(applications)}
							disabled={applications.length === 0}
							className="px-3 py-2 border border-blue-200 bg-white text-blue-600 text-sm font-medium rounded-lg hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
							title="Download the current applications as a CSV file"
						>
							⤓ Export CSV
						</button>
						<button
							data-testid="btn-reset-db"
							onClick={() => setShowResetConfirm(true)}
							className="px-3 py-2 border border-red-200 bg-white text-red-500 text-sm font-medium rounded-lg hover:bg-red-50"
							title="Wipe all applications and sync history"
						>
							⚠ Reset DB
						</button>
						<button
							data-testid="btn-add-application"
							onClick={() => setModal({})}
							className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
						>
							+ Add Application
						</button>
					</div>
				</div>

				<Filters filters={filters} onChange={setFilters} />

				{loading ? (
					<div className="text-center text-gray-400 py-12">Loading...</div>
				) : view === 'board' ? (
					<Board
						applications={applications}
						highlightIds={newlyAdded}
						onEdit={app => setModal(app as Partial<ApplicationFormData>)}
						onDelete={handleDelete}
					/>
				) : (
					<TableView
						applications={applications}
						highlightIds={newlyAdded}
						onEdit={app => setModal(app as Partial<ApplicationFormData>)}
						onDelete={handleDelete}
					/>
				)}
			</main>

			{modal !== null && (
				<AddModal
					key={modal?.id ?? 'new'}
					initial={modal}
					onSave={handleSave}
					onClose={() => setModal(null)}
				/>
			)}

			{importResult && (
				<ImportResultModal outcome={importResult} onClose={() => setImportResult(null)} />
			)}

			{showResetConfirm && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowResetConfirm(false)}>
					<div data-testid="reset-confirm-modal" className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
						<div className="text-3xl mb-3 text-center">⚠️</div>
						<h2 className="text-lg font-bold text-gray-900 text-center mb-1">Reset database?</h2>
						<p className="text-sm text-gray-500 text-center mb-6">
							This deletes <span className="font-semibold text-gray-700">all {applications.length} applications</span> and
							clears the Gmail sync history, so the next sync re-processes everything from scratch.
							This cannot be undone.
						</p>
						<div className="flex gap-3">
							<button
								data-testid="reset-cancel"
								onClick={() => setShowResetConfirm(false)}
								className="flex-1 px-4 py-2 border border-gray-200 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-50"
							>
								Cancel
							</button>
							<button
								data-testid="reset-confirm"
								onClick={handleReset}
								disabled={resetting}
								className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
							>
								{resetting ? 'Resetting…' : 'Yes, reset everything'}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
