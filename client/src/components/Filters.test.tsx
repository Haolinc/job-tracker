import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Filters from './Filters';

describe('Filters', () => {
	it('should call onChange with the search text when the user types', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Filters filters={{ search: '' }} onChange={onChange} />);

		await user.type(screen.getByTestId('filters-search'), 'google');
		expect(screen.getByTestId('filters-search')).toHaveValue('google');

		// 300ms debounce → wait for the settled call
		await waitFor(() => expect(onChange).toHaveBeenCalledWith({ search: 'google' }));
	});

	it('should NOT call onChange until the debounce has elapsed, then fire once', () => {
		// fireEvent (synchronous) instead of userEvent: typing-under-fake-timers is a known hang.
		vi.useFakeTimers();
		try {
			const onChange = vi.fn();
			render(<Filters filters={{ search: '' }} onChange={onChange} />);

			fireEvent.change(screen.getByTestId('filters-search'), { target: { value: 'google' } });
			act(() => { vi.advanceTimersByTime(299); });
			expect(onChange).not.toHaveBeenCalled();           // one tick short of the window — nothing fired yet

			act(() => { vi.advanceTimersByTime(1); });
			expect(onChange).toHaveBeenCalledTimes(1);          // crosses 300ms → a single trailing call
			expect(onChange).toHaveBeenCalledWith({ search: 'google' });
		} finally {
			vi.useRealTimers();
		}
	});
});
