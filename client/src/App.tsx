import { useState, useEffect } from 'react';
import Board from './components/Board';
import AddModal from './components/AddModal';
import StatsBar from './components/StatsBar';
import GmailSync from './components/GmailSync';
import Filters from './components/Filters';
import { useApplications } from './hooks/useApplications';
import { useGmailSync } from './hooks/useGmailSync';
import type { Application, ApplicationFormData, Filters as FiltersType, Status } from './types';

export default function App() {
	const { applications, loading, fetchAll, add, update, remove } = useApplications();
	const { connected, syncing, lastResult, error: syncError, checkStatus, disconnect, sync } = useGmailSync();

	const [filters, setFilters] = useState<FiltersType>({ search: '', priority: '' });
	const [modal, setModal] = useState<Partial<ApplicationFormData> | null>(null);

	useEffect(() => {
		fetchAll(filters);
	}, [filters, fetchAll]);

	useEffect(() => {
		checkStatus();
		const params = new URLSearchParams(window.location.search);
		if (params.get('gmail') === 'connected') {
			checkStatus();
			window.history.replaceState({}, '', '/');
		}
	}, [checkStatus]);

	const handleSave = async (form: ApplicationFormData) => {
		if (form.id) {
			await update(form.id, form as Partial<Application>);
		} else {
			await add({
				...form,
				date_applied: form.date_applied || null,
				job_url: form.job_url || null,
				notes: form.notes || null,
				source: 'manual',
				gmail_thread_id: null,
			});
		}
		setModal(null);
		fetchAll(filters);
	};

	const handleDelete = async (id: number) => {
		if (confirm('Delete this application?')) {
			await remove(id);
		}
	};

	const handleStatusChange = async (id: number, status: Status) => {
		await update(id, { status });
	};

	const handleSync = async () => {
		try {
			await sync();
			fetchAll(filters);
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
					<button
						onClick={() => setModal({})}
						className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
					>
						+ Add Application
					</button>
				</div>

				<Filters filters={filters} onChange={setFilters} />

				{loading ? (
					<div className="text-center text-gray-400 py-12">Loading...</div>
				) : (
					<Board
						applications={applications}
						onEdit={app => setModal(app as Partial<ApplicationFormData>)}
						onDelete={handleDelete}
						onStatusChange={handleStatusChange}
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
