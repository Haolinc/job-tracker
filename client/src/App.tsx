import { useState, useEffect, useRef } from 'react';
import Board from './components/Board';
import TableView from './components/TableView';
import AddModal from './components/AddModal';
import StatsBar from './components/StatsBar';
import GmailSync from './components/GmailSync';
import Filters from './components/Filters';
import ImportResultModal, { type ImportOutcome } from './components/ImportResultModal';
import { getApplications } from './api';
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
		const { interview_step, date_applied, last_activity, job_url, notes, ...rest } = form;
		const cleaned = {
			...rest,
			interview_step: interview_step || null,
			date_applied: date_applied || null,
			last_activity: last_activity || null,
			job_url: job_url || null,
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
			<header className="bg-white border-b border-gray-200 px-6 py-4">
				<div className="max-w-screen-xl mx-auto flex flex-wrap items-center justify-between gap-4">
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

			<main className="max-w-screen-xl mx-auto px-6 py-6 space-y-5">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<StatsBar applications={applications} />
					<div className="flex items-center gap-2">
						<div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm font-medium">
							<button
								onClick={() => setView('board')}
								className={`px-3 py-2 ${view === 'board' ? 'bg-gray-100 text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
							>⊞ Board</button>
							<button
								onClick={() => setView('table')}
								className={`px-3 py-2 border-l border-gray-200 ${view === 'table' ? 'bg-gray-100 text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
							>☰ Table</button>
						</div>
                        <div className="w-px h-6 bg-gray-300 mx-4"></div>
						<input
							ref={fileInputRef}
							type="file"
							accept=".csv,text/csv"
							className="hidden"
							onChange={e => {
								const file = e.target.files?.[0];
								e.target.value = '';   // reset so re-selecting the same file fires onChange again
								if (file) handleImport(file);
							}}
						/>
						<button
							onClick={() => fileInputRef.current?.click()}
							className="px-3 py-2 border border-emerald-200 bg-white text-emerald-700 text-sm font-medium rounded-lg hover:bg-emerald-100"
							title="Import applications from a CSV file"
						>
							⤒ Import CSV
						</button>
						<button
							onClick={() => downloadApplicationsCsv(applications)}
							disabled={applications.length === 0}
							className="px-3 py-2 border border-blue-200 bg-white text-blue-600 text-sm font-medium rounded-lg hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
							title="Download the current applications as a CSV file"
						>
							⤓ Export CSV
						</button>
						<button
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
		</div>
	);
}
