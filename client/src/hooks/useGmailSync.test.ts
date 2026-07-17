import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGmailSync } from './useGmailSync';
import { disconnectGmail } from '../api';

vi.mock('../api', () => ({
	getAuthStatus: vi.fn(),
	disconnectGmail: vi.fn(),
	syncGmail: vi.fn(),
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
