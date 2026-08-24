import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGmailSync } from './useGmailSync';
import { disconnectGmail, getAuthStatus, getSyncStatus, syncGmail } from '../api';

vi.mock('../api', () => ({
	getAuthStatus: vi.fn(),
	getSyncStatus: vi.fn(),
	disconnectGmail: vi.fn(),
	syncGmail: vi.fn(),
	cancelGmailSync: vi.fn(),
}));

const disconnectGmailMock = vi.mocked(disconnectGmail);

describe('useGmailSync disconnect', () => {
	beforeEach(() => {
		disconnectGmailMock.mockReset();
	});

	it('should clear the connection on a successful disconnect', async () => {
		disconnectGmailMock.mockResolvedValue({ success: true });
		const { result } = renderHook(() => useGmailSync());
		await act(async () => { await result.current.disconnect(); });
		expect(result.current.connected).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it("should surface the server's reason when disconnect is refused", async () => {
		// The shape axios gives a 409 — e.g. the server refusing because a sync is running.
		disconnectGmailMock.mockRejectedValue({ response: { data: { error: 'A sync is in progress — wait for it to finish before disconnecting.' } } });
		const { result } = renderHook(() => useGmailSync());
		await act(async () => { await result.current.disconnect(); });
		expect(result.current.error).toContain('sync is in progress');
	});

	it('should fall back to a generic message when the failure carries no server reason', async () => {
		disconnectGmailMock.mockRejectedValue(new Error('network down'));
		const { result } = renderHook(() => useGmailSync());
		await act(async () => { await result.current.disconnect(); });
		expect(result.current.error).toBe('Failed to disconnect');
	});
});

describe('useGmailSync connection state after a failed sync', () => {
	beforeEach(() => {
		vi.mocked(getSyncStatus).mockResolvedValue({ running: false, event: null });
	});

	it('should drop the connection when the server reports the Gmail access is gone', async () => {
		// The server clears the session tokens on invalid_grant, so a Sync button left on screen could only
		// fail the same way. The hook re-reads the server's view instead of trusting its own stale flag.
		vi.mocked(getAuthStatus).mockResolvedValue({ connected: false });
		vi.mocked(syncGmail).mockRejectedValue(new Error('Gmail access has expired or been revoked. Please reconnect your Google account.'));

		const { result } = renderHook(() => useGmailSync());
		await act(async () => { await result.current.sync().catch(() => {}); });

		expect(result.current.connected).toBe(false);
		expect(result.current.error).toContain('reconnect your Google account');
	});

	it('should keep the connection when the sync fails for an unrelated reason', async () => {
		vi.mocked(getAuthStatus).mockResolvedValue({ connected: true });
		vi.mocked(syncGmail).mockRejectedValue(new Error('Ollama is not running'));

		const { result } = renderHook(() => useGmailSync());
		await act(async () => { await result.current.sync().catch(() => {}); });

		expect(result.current.connected).toBe(true);
		expect(result.current.error).toBe('Ollama is not running');
	});
});
