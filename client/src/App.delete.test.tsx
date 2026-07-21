import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import * as api from './api';
import { makeApp } from './test-utils';

// Mock the network boundary; the real App delete flow (styled dialog → deleteApplication) runs.
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
const board = [makeApp({ id: '1', company: 'Acme', role: 'SWE' })];

// This file mounts the whole App per test; under the full suite's parallel jsdom environments a cold
// first mount can outrun the 1s findBy / 5s test defaults purely from CPU contention (the suite passes
// sequentially). Give the async waits headroom — they still resolve the moment the element appears.
const WAIT = 10_000;
vi.setConfig({ testTimeout: 20_000 });

// Open the confirm dialog by clicking a card's trash button. The board can briefly re-render while
// its initial fetch settles (worse under the full suite's parallel load), so retry the click until
// the dialog actually opens — never clicking a card mid-re-render.
async function openDeleteDialog() {
	render(<App />);
	await waitFor(async () => {
		await user.click(screen.getByTestId('card-delete'));
		expect(screen.getByTestId('delete-confirm-modal')).toBeInTheDocument();
	}, { timeout: WAIT });
	return screen.getByTestId('delete-confirm-modal');
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(api.getApplications).mockResolvedValue(board);
	vi.mocked(api.getAuthStatus).mockResolvedValue({ connected: false });
	vi.mocked(api.deleteApplication).mockResolvedValue(undefined);
});

describe('App — delete confirmation dialog', () => {
	it('should open the styled dialog naming the application, not a native confirm', async () => {
		const confirmSpy = vi.spyOn(window, 'confirm');
		const modal = await openDeleteDialog();
		expect(modal).toHaveTextContent('Acme — SWE');
		expect(confirmSpy).not.toHaveBeenCalled();   // native confirm is fully replaced
	});

	it('should delete via the API when the user confirms', async () => {
		await openDeleteDialog();
		await user.click(screen.getByTestId('delete-confirm'));
		await waitFor(() => expect(api.deleteApplication).toHaveBeenCalledWith('1'), { timeout: WAIT });
		await waitFor(() => expect(screen.queryByTestId('delete-confirm-modal')).toBeNull(), { timeout: WAIT });   // closes on success
	});

	it('should close without deleting when the user cancels', async () => {
		await openDeleteDialog();
		await user.click(screen.getByTestId('delete-cancel'));
		expect(screen.queryByTestId('delete-confirm-modal')).toBeNull();
		expect(api.deleteApplication).not.toHaveBeenCalled();
	});

	it('should surface an error in the dialog when the delete fails, keeping it open', async () => {
		vi.mocked(api.deleteApplication).mockRejectedValue(new Error('network down'));
		await openDeleteDialog();
		await user.click(screen.getByTestId('delete-confirm'));
		expect(await screen.findByTestId('delete-error', {}, { timeout: WAIT })).toHaveTextContent('Failed to delete');
		expect(screen.getByTestId('delete-confirm-modal')).toBeTruthy();   // stays open so the user can retry
	});
});
