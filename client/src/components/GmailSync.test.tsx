import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GmailSync from './GmailSync';

const user = userEvent.setup();
const base = { connected: true, syncing: false, cancelling: false, progress: null, lastResult: null, error: null, onConnect: vi.fn(), onDisconnect: vi.fn(), onSync: vi.fn(), onCancel: vi.fn() };

describe('GmailSync', () => {
	it('should call onConnect when disconnected', async () => {
		const onConnect = vi.fn();
		render(<GmailSync {...base} connected={false} onConnect={onConnect} />);
		await user.click(screen.getByTestId('gmail-connect-btn'));
		expect(onConnect).toHaveBeenCalledTimes(1);
	});

	it('should call onDisconnect when connected', async () => {
		const onDisconnect = vi.fn();
		render(<GmailSync {...base} onDisconnect={onDisconnect} />);
		await user.click(screen.getByTestId('gmail-disconnect-btn'));
		expect(onDisconnect).toHaveBeenCalledTimes(1);
	});

	it.each([30, 60, 90, 180] as const)('should call onSync with the %s scan window when syncing', async (scanDay) => {
		const onSync = vi.fn();
		render(<GmailSync {...base} onSync={onSync} />);
		await user.click(screen.getByTestId('gmail-sync-btn'));      // default 30 days
		await user.selectOptions(screen.getByTestId('gmail-scan-window'), String(scanDay));
		await user.click(screen.getByTestId('gmail-sync-btn'));
		expect(onSync.mock.calls).toEqual([[30], [scanDay]]);
	});

	it('should NOT call onSync when the button is clicked while already syncing', async () => {
		const onSync = vi.fn();
		render(<GmailSync {...base} syncing onSync={onSync} />);
		const btn = screen.getByTestId('gmail-sync-btn');
		expect(btn).toBeDisabled();                  // guarded so a sync can't be fired on top of one in flight
		await user.click(btn);
		expect(onSync).not.toHaveBeenCalled();
	});

	it('should NOT call onDisconnect when clicked while syncing', async () => {
		const onDisconnect = vi.fn();
		render(<GmailSync {...base} syncing onDisconnect={onDisconnect} />);
		const disconnectButton = screen.getByTestId('gmail-disconnect-btn');
		expect(disconnectButton).toBeDisabled();     // disconnecting mid-sync would revoke the tokens the sync is using
		await user.click(disconnectButton);
		expect(onDisconnect).not.toHaveBeenCalled();
	});

	it('should NOT render a sync button when disconnected', () => {
		render(<GmailSync {...base} connected={false} />);
		expect(screen.queryByTestId('gmail-sync-btn')).toBeNull();
		expect(screen.getByTestId('gmail-connect-btn')).toBeInTheDocument();
	});

	it('should show a Cancel button only while syncing', () => {
		const { rerender } = render(<GmailSync {...base} />);
		expect(screen.queryByTestId('gmail-cancel-btn')).toBeNull();   // nothing to cancel when idle
		rerender(<GmailSync {...base} syncing />);
		expect(screen.getByTestId('gmail-cancel-btn')).toBeInTheDocument();
	});

	it('should confirm before cancelling: Cancel opens a dialog, and only Stop sync calls onCancel', async () => {
		const onCancel = vi.fn();
		render(<GmailSync {...base} syncing onCancel={onCancel} />);
		await user.click(screen.getByTestId('gmail-cancel-btn'));
		expect(screen.getByTestId('gmail-cancel-sync-confirm-modal')).toBeInTheDocument();
		expect(onCancel).not.toHaveBeenCalled();                     // opening the dialog must not cancel yet
		await user.click(screen.getByTestId('gmail-cancel-sync-confirm'));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('should dismiss the confirm dialog without cancelling when "Keep syncing" is clicked', async () => {
		const onCancel = vi.fn();
		render(<GmailSync {...base} syncing onCancel={onCancel} />);
		await user.click(screen.getByTestId('gmail-cancel-btn'));
		await user.click(screen.getByTestId('gmail-cancel-sync-cancel'));
		expect(onCancel).not.toHaveBeenCalled();
		expect(screen.queryByTestId('gmail-cancel-sync-confirm-modal')).toBeNull();
	});

	it('should auto-dismiss the confirm dialog if the sync finishes while it is open', async () => {
		const onCancel = vi.fn();
		const { rerender } = render(<GmailSync {...base} syncing onCancel={onCancel} />);
		await user.click(screen.getByTestId('gmail-cancel-btn'));
		expect(screen.getByTestId('gmail-cancel-sync-confirm-modal')).toBeInTheDocument();
		rerender(<GmailSync {...base} syncing={false} onCancel={onCancel} />);   // sync finished on its own
		expect(screen.queryByTestId('gmail-cancel-sync-confirm-modal')).toBeNull();
		expect(onCancel).not.toHaveBeenCalled();                     // the moot question is dropped, not answered
	});

	// The dialog's visibility is derived from `syncing`, so an abandoned confirm request outlives the sync it
	// belonged to. Starting the next sync must clear it, or the user would be greeted by a dialog they never opened.
	it('should not reopen an abandoned confirm dialog when the next sync starts', async () => {
		const { rerender } = render(<GmailSync {...base} syncing />);
		await user.click(screen.getByTestId('gmail-cancel-btn'));
		expect(screen.getByTestId('gmail-cancel-sync-confirm-modal')).toBeInTheDocument();
		rerender(<GmailSync {...base} syncing={false} />);            // sync finished with the dialog still open
		await user.click(screen.getByTestId('gmail-sync-btn'));       // the user starts a fresh sync
		rerender(<GmailSync {...base} syncing />);
		expect(screen.queryByTestId('gmail-cancel-sync-confirm-modal')).toBeNull();
	});

	it('should disable the Cancel button and show "Cancelling…" once a cancel is in flight', () => {
		render(<GmailSync {...base} syncing cancelling />);
		const cancelButton = screen.getByTestId('gmail-cancel-btn');
		expect(cancelButton).toBeDisabled();
		expect(cancelButton).toHaveTextContent('Cancelling');
	});

	it('should label a cancelled result as cancelled while still showing its partial counts', () => {
		render(<GmailSync {...base} lastResult={{ added: 3, updated: 1, skipped: 5, failed: 0, durationMs: 12000, cancelled: true }} />);
		const syncResult = screen.getByTestId('gmail-sync-result');
		expect(syncResult).toHaveTextContent('Sync cancelled');
		expect(syncResult).toHaveTextContent('+3 added');
	});

	it('should render the syncing label when syncing and the result when done', () => {
		const { rerender } = render(<GmailSync {...base} syncing />);
		expect(screen.getByTestId('gmail-sync-btn')).toHaveTextContent('Syncing...');
		rerender(<GmailSync {...base} lastResult={{ added: 12, updated: 8, skipped: 30, failed: 0, durationMs: 341050 }} />);
		const syncResult = screen.getByTestId('gmail-sync-result');
		expect(syncResult).toHaveTextContent('+12 added · 8 updated · 30 skipped · 5m 41s');
	});
});
