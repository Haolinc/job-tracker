import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GmailSync from './GmailSync';

const user = userEvent.setup();
const base = { connected: true, syncing: false, progress: null, lastResult: null, error: null, onConnect: vi.fn(), onDisconnect: vi.fn(), onSync: vi.fn() };

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

	it('should NOT render a sync button when disconnected', () => {
		render(<GmailSync {...base} connected={false} />);
		expect(screen.queryByTestId('gmail-sync-btn')).toBeNull();
		expect(screen.getByTestId('gmail-connect-btn')).toBeInTheDocument();
	});

	it('should render the syncing label when syncing and the result when done', () => {
		const { rerender } = render(<GmailSync {...base} syncing />);
		expect(screen.getByTestId('gmail-sync-btn')).toHaveTextContent('Syncing...');
		rerender(<GmailSync {...base} lastResult={{ added: 12, updated: 8, skipped: 30, failed: 0, durationMs: 341050 }} />);
		const r = screen.getByTestId('gmail-sync-result');
		expect(r).toHaveTextContent('+12 added · 8 updated · 30 skipped · 5m 41s');
	});
});
