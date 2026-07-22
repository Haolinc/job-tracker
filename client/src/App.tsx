import { useState, useEffect } from 'react';
import Board from './components/Board';
import TableView from './components/TableView';
import AddModal from './components/AddModal';
import StatsBar from './components/StatsBar';
import GmailSync from './components/GmailSync';
import Filters from './components/Filters';
import Toolbar, { type View } from './components/Toolbar';
import WarningConfirmDialog from './components/WarningConfirmDialog';
import ImportResultModal, { type ImportOutcome } from './components/ImportResultModal';
import ImportConfirmModal from './components/ImportConfirmModal';
import { getApplications, importApplications, resetDatabase, type ImportApplyPayload, type ImportApplyResult } from './api';
import { useApplications } from './hooks/useApplications';
import { useGmailSync } from './hooks/useGmailSync';
import { downloadApplicationsCsv } from './utils/exportCsv';
import { parseApplicationsCsv, CsvImportError, buildImportPlan, type ParsedCsv, type ImportPlan } from './utils/importCsv';
import type { Application, ApplicationFormData, Filters as FiltersType } from './types';

export default function App() {
	const { applications, loading, fetchAll, add, update, remove } = useApplications();

	const [filters, setFilters] = useState<FiltersType>({ search: '' });

	// When a sync this tab RECONNECTED to (reopened mid-sync) finishes, refetch so the board shows its results.
	// The normal, tab-initiated sync refetches in handleSync instead (it also computes the "new" highlight).
	const { connected, syncing, progress, lastResult, error: syncError, checkStatus, disconnect, sync } =
		useGmailSync(() => { void fetchAll(filters); });
	const [modal, setModal] = useState<Partial<ApplicationFormData> | null>(null);
	const [view, setView] = useState<View>('board');

	// Ids touched by the most recent sync OR import (created OR updated) — highlighted as "new".
	// In-memory only, so a page refresh clears the effect; set once, so later edits don't light up.
	const [newlyAdded, setNewlyAdded] = useState<Set<string>>(new Set());

	const [importResult, setImportResult] = useState<ImportOutcome | null>(null);
	// An import plan waiting on the user's overwrite/add-only decision (set only when it would change the board).
	const [pendingImport, setPendingImport] = useState<ImportPlan | null>(null);
	const [showResetConfirm, setShowResetConfirm] = useState(false);
	const [resetting, setResetting] = useState(false);
	// The application awaiting delete confirmation in the styled dialog (null = dialog closed).
	const [pendingDelete, setPendingDelete] = useState<Application | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

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

	// Open the styled confirm dialog (replacing the browser's native confirm); the delete itself runs
	// in confirmDelete once the user approves.
	const handleDelete = (id: string) => {
		const applicationToDelete = applications.find(application => application.id === id);
		if (!applicationToDelete) return;
		setDeleteError(null);
		setPendingDelete(applicationToDelete);
	};

	const confirmDelete = async () => {
		if (!pendingDelete) return;
		setDeleting(true);
		try {
			await remove(pendingDelete.id);
			setPendingDelete(null);
		} catch {
			setDeleteError('Failed to delete. Please try again.');
		} finally {
			setDeleting(false);
		}
	};

	const handleImport = async (file: File) => {
		let parsed: ParsedCsv;
		try {
			parsed = parseApplicationsCsv(await file.text());
		} catch (error) {
			// A CsvImportError carries a user-facing reason (no Company column, a row missing a
			// company, …); the whole sheet is rejected and nothing is imported.
			setImportResult({
				tone: 'error',
				title: 'Import failed',
				message: error instanceof CsvImportError ? error.message : 'Could not read that file as CSV.',
			});
			return;
		}
		if (parsed.apps.length === 0) {
			setImportResult({ tone: 'warning', title: 'Nothing to import', message: 'No applications were found in that CSV.' });
			return;
		}
		// Plan against the COMPLETE board — fetched fresh and unfiltered, since the in-memory `applications`
		// list is narrowed by an active search filter and can be momentarily stale.
		const existing = await getApplications();
		const plan = buildImportPlan(parsed, existing);

		// Anything that changes existing applications — updates, emails moving off them, merges — needs
		// the user's go-ahead; a plan of pure creates (or nothing at all) applies straight away.
		if (plan.updates.length === 0 && plan.moves.length === 0 && plan.deletes.length === 0) {
			await applyPlan(plan, 'all');
			return;
		}
		setPendingImport(plan);
	};

	// Second half of an import: ship the plan (or just its safe creates) to the one-transaction import
	// endpoint and report. 'add-only' performs ZERO mutations of existing applications.
	const applyPlan = async (plan: ImportPlan, mode: 'all' | 'add-only') => {
		const creates = mode === 'all' ? plan.creates : plan.creates.filter(plannedCreate => !plannedCreate.conflictFallback);
		// Matched rows the user declined, plus conflict-fallback creates that only make sense alongside them.
		const declinedCount = mode === 'all' ? 0 : plan.updates.length + (plan.creates.length - creates.length);
		const stripsByHolderId = new Map<string, string[]>();
		if (mode === 'all') {
			for (const plannedMove of plan.moves) {
				stripsByHolderId.set(plannedMove.fromId, [...(stripsByHolderId.get(plannedMove.fromId) ?? []), plannedMove.messageId]);
			}
		}
		const payload: ImportApplyPayload = {
			creates: creates.map(plannedCreate => ({ preservedId: plannedCreate.preservedId, data: plannedCreate.fields })),
			updates: mode === 'all' ? plan.updates.map(plannedUpdate => ({ id: plannedUpdate.id, changes: plannedUpdate.changes, adoptId: plannedUpdate.adoptId })) : [],
			strips: [...stripsByHolderId].map(([holderId, messageIds]) => ({ id: holderId, messageIds })),
			deletes: mode === 'all' ? plan.deletes.map(plannedDelete => plannedDelete.id) : [],
			// Add-only must not suppress emails it didn't import — only the created rows' refs are safe
			// to mark synced (declined rows' emails stay eligible for the next sync).
			syncEmails: mode === 'all' ? plan.syncEmails : creates.flatMap(plannedCreate => plannedCreate.fields.emails),
		};

		let result: ImportApplyResult;
		try {
			result = await importApplications(payload);
		} catch (error) {
			const serverMessage = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
			setImportResult({ tone: 'error', title: 'Import failed', message: serverMessage ?? 'The server rejected the import — nothing was changed.' });
			return;
		}

		await fetchAll(filters);
		setNewlyAdded(new Set([...result.createdIds, ...result.updatedIds]));

		const touchedCount = result.added + result.updated + result.deleted;
		setImportResult({
			tone: result.staleSkipped > 0 || touchedCount === 0 ? 'warning' : 'success',
			title: touchedCount > 0 ? 'Import complete' : 'Nothing to import',
			message: touchedCount === 0
				? (declinedCount > 0
					? 'No new rows were added; the matched applications were left untouched.'
					: 'Every row was already on your board and up to date.')
				: undefined,
			stats: [
				{ label: 'Added', value: result.added, cls: 'text-emerald-600' },
				...(result.updated ? [{ label: 'Updated', value: result.updated, cls: 'text-blue-600' }] : []),
				...(result.deleted ? [{ label: 'Merged (deleted)', value: result.deleted, cls: 'text-purple-600' }] : []),
				...(plan.skipped ? [{ label: 'Unchanged', value: plan.skipped, cls: 'text-gray-500' }] : []),
				...(declinedCount ? [{ label: 'Not updated', value: declinedCount, cls: 'text-gray-500' }] : []),
				...(result.staleSkipped ? [{ label: 'Skipped (board changed)', value: result.staleSkipped, cls: 'text-red-600' }] : []),
			],
		});
	};

	const handleImportDecision = async (mode: 'all' | 'add-only') => {
		if (!pendingImport) return;
		setPendingImport(null);
		await applyPlan(pendingImport, mode);
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
					<Toolbar
						view={view}
						onViewChange={setView}
						onImportFile={handleImport}
						onExport={() => downloadApplicationsCsv(applications)}
						exportDisabled={applications.length === 0}
						onReset={() => setShowResetConfirm(true)}
						onAdd={() => setModal({})}
						addDisabled={syncing}
					/>
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

			{pendingImport && (
				<ImportConfirmModal
					addCount={pendingImport.creates.length}
					addOnlyCount={pendingImport.creates.filter(plannedCreate => !plannedCreate.conflictFallback).length}
					updates={pendingImport.updates.map(plannedUpdate => ({
						company: plannedUpdate.company,
						role: plannedUpdate.role,
						fields: Object.keys(plannedUpdate.changes),
						suspicious: plannedUpdate.suspicious,
					}))}
					moves={pendingImport.moves.map(plannedMove => ({
						messageId: plannedMove.messageId,
						fromCompany: plannedMove.fromCompany,
						toCompany: plannedMove.toCompany,
					}))}
					deletes={pendingImport.deletes.map(plannedDelete => ({ company: plannedDelete.company, role: plannedDelete.role }))}
					onConfirm={handleImportDecision}
					onCancel={() => setPendingImport(null)}
				/>
			)}

			{importResult && (
				<ImportResultModal outcome={importResult} onClose={() => setImportResult(null)} />
			)}

			{showResetConfirm && (
				<WarningConfirmDialog
					testIdPrefix="reset"
					title="Reset database?"
					confirmLabel="Reset"
					busyLabel="Resetting…"
					busy={resetting}
					onCancel={() => setShowResetConfirm(false)}
					onConfirm={handleReset}
				>
					This deletes <span className="font-semibold text-gray-700">all {applications.length} applications</span> and
					clears the Gmail sync history — the next sync re-processes everything from scratch. This cannot be undone.
				</WarningConfirmDialog>
			)}

			{pendingDelete && (
				<WarningConfirmDialog
					testIdPrefix="delete"
					title="Delete this application?"
					confirmLabel="Delete"
					busyLabel="Deleting…"
					busy={deleting}
					error={deleteError}
					onCancel={() => setPendingDelete(null)}
					onConfirm={confirmDelete}
				>
					This removes <span className="font-semibold text-gray-700">{pendingDelete.company} — {pendingDelete.role}</span> from
					your board. This cannot be undone.
				</WarningConfirmDialog>
			)}
		</div>
	);
}
