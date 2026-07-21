import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import * as api from './api';
import { makeApp } from './test-utils';
import type { ImportApplyPayload, ImportApplyResult } from './api';

// Mock only the network boundary — the real buildImportPlan and App.applyPlan run, so these tests
// exercise the actual overwrite-vs-add-only decision the user makes in the confirm modal.
vi.mock('./api', () => ({
	getApplications: vi.fn(),
	importApplications: vi.fn(),
	resetDatabase: vi.fn(),
	createApplication: vi.fn(),
	updateApplication: vi.fn(),
	deleteApplication: vi.fn(),
	getAuthStatus: vi.fn(),
	disconnectGmail: vi.fn(),
	syncGmail: vi.fn(),
}));

const user = userEvent.setup();

// A one-row board: id 1, Acme / SWE, no emails.
const board = [makeApp({ id: '1', company: 'Acme', role: 'SWE', emails: [] })];

const importResult: ImportApplyResult = {
	added: 1, updated: 1, deleted: 0, staleSkipped: 0, createdIds: ['2'], updatedIds: ['1'],
};

// jsdom doesn't reliably implement Blob.text(); pin the read so handleImport gets exactly this text.
function csvFile(text: string): File {
	const file = new File([text], 'apps.csv', { type: 'text/csv' });
	Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
	return file;
}

// The visible button just forwards a click to a hidden <input type="file">; upload targets that input.
const uploadCsv = (text: string) =>
	user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, csvFile(text));
const lastImportPayload = () => vi.mocked(api.importApplications).mock.calls[0][0] as ImportApplyPayload;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(api.getApplications).mockResolvedValue(board);
	vi.mocked(api.getAuthStatus).mockResolvedValue({ connected: false });
	vi.mocked(api.importApplications).mockResolvedValue(importResult);
});

describe('App — CSV import apply path', () => {
	// One row edits the existing id-1 app (→ update), one row is brand new (→ create). The update forces
	// the confirm modal.
	const EDIT_AND_ADD = 'ID,Company,Role\r\n1,Acme Corp,SWE\r\n,NewCo,DS';

	it('should send both the update and the create when the user picks "Update & add"', async () => {
		render(<App />);
		await uploadCsv(EDIT_AND_ADD);
		await user.click(await screen.findByTestId('import-confirm-overwrite'));

		await waitFor(() => expect(api.importApplications).toHaveBeenCalledTimes(1));
		const payload = lastImportPayload();
		expect(payload.updates).toHaveLength(1);
		expect(payload.updates[0]).toMatchObject({ id: '1', changes: { company: 'Acme Corp' } });
		expect(payload.creates).toHaveLength(1);
		expect(payload.creates[0].data.company).toBe('NewCo');
	});

	it('should send ONLY the create — no updates, strips, or deletes — when the user picks "Add only"', async () => {
		render(<App />);
		await uploadCsv(EDIT_AND_ADD);
		await user.click(await screen.findByTestId('import-confirm-add-only'));

		await waitFor(() => expect(api.importApplications).toHaveBeenCalledTimes(1));
		const payload = lastImportPayload();
		expect(payload.updates).toEqual([]);
		expect(payload.strips).toEqual([]);
		expect(payload.deletes).toEqual([]);
		expect(payload.creates).toHaveLength(1);
		expect(payload.creates[0].data.company).toBe('NewCo');
	});

	it('should apply a pure-create file immediately, with no confirm modal', async () => {
		render(<App />);
		await uploadCsv('ID,Company,Role\r\n,NewCo,DS');

		await waitFor(() => expect(api.importApplications).toHaveBeenCalledTimes(1));
		expect(screen.queryByTestId('import-confirm-modal')).toBeNull();   // nothing existing changed → no prompt
		const payload = lastImportPayload();
		expect(payload.creates).toHaveLength(1);
		expect(payload.updates).toEqual([]);
	});

	it('should reject a duplicate-id file up front, showing the error and never calling the server', async () => {
		render(<App />);
		await uploadCsv('ID,Company,Role\r\n7,Acme,SWE\r\n7,Beta,PM');

		const modal = await screen.findByTestId('import-result-modal');
		expect(modal).toHaveTextContent('Import failed');
		expect(modal).toHaveTextContent('Application id 7 appears in rows 2, 3 (Acme, Beta)');
		expect(api.importApplications).not.toHaveBeenCalled();
	});
});
