import { useState, useEffect } from 'react';
import Board from './components/Board';
import TableView from './components/TableView';
import AddModal from './components/AddModal';
import StatsBar from './components/StatsBar';
import GmailSync from './components/GmailSync';
import Filters from './components/Filters';
import { useApplications } from './hooks/useApplications';
import { useGmailSync } from './hooks/useGmailSync';
import type { Application, ApplicationFormData, Filters as FiltersType, Status } from './types';

type View = 'board' | 'table';

export default function App() {
	const { applications, loading, fetchAll, add, update, remove } = useApplications();
	const { connected, syncing, progress, lastResult, error: syncError, checkStatus, disconnect, sync } = useGmailSync();

	const [filters, setFilters] = useState<FiltersType>({ search: '' });
	const [modal, setModal] = useState<Partial<ApplicationFormData> | null>(null);
	const [view, setView] = useState<View>('board');

	// Ids touched by the most recent sync (created OR updated) — highlighted as "new". In-memory only,
	// so a page refresh clears the effect. Set once per sync, so later manual edits don't light up.
	const [newlyAdded, setNewlyAdded] = useState<Set<string>>(new Set());

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

	const handleStatusChange = async (id: string, status: Status) => {
		try {
			await update(id, { status });
		} catch {
			alert('Failed to update status. Please try again.');
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
						onStatusChange={handleStatusChange}
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
		</div>
	);
}
