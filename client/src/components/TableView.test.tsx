import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TableView from './TableView';
import { makeApp } from '../test-utils';

const user = userEvent.setup();
const cfg = { highlightIds: new Set<string>(), onEdit: vi.fn(), onDelete: vi.fn() };
const rows = (n: number) => Array.from({ length: n }, (_, i) => makeApp({ id: `p${i}` }));

describe('TableView', () => {
	it('should render a row per application and call onEdit when a company is clicked', async () => {
		const onEdit = vi.fn();
		const a = makeApp({ id: 't1', company: 'Acme' });
		render(<TableView applications={[a, makeApp({ id: 't2', company: 'Beta' })]} highlightIds={new Set()} onEdit={onEdit} onDelete={vi.fn()} />);
		expect(screen.getByTestId('table-row-t1')).toHaveTextContent('Acme');
		expect(screen.getByTestId('table-row-t2')).toHaveTextContent('Beta');
		await user.click(within(screen.getByTestId('table-row-t1')).getByText('Acme'));
		expect(onEdit).toHaveBeenCalledWith(a);
	});

	it('should render an empty state when there are no applications', () => {
		render(<TableView applications={[]} {...cfg} />);
		expect(screen.getByText('No applications found')).toBeInTheDocument();
	});

	it('should show pagination when there are more than 25 rows', () => {
        // should not show when 5 rows
		const { unmount } = render(<TableView applications={rows(5)} {...cfg} />);
		expect(screen.queryByTestId('table-next')).toBeNull();
		unmount();
        // should show when > 25 rows
		render(<TableView applications={rows(26)} {...cfg} />);
		expect(screen.getByTestId('table-next')).toBeInTheDocument();
	});

	it('should disable Prev/Next at the page bounds and not navigate past them', async () => {
		render(<TableView applications={rows(30)} {...cfg} />);   // 30 rows → 2 pages of 25 (p0–p24, p25–p29)
		const prev = screen.getByTestId('table-prev');
		const next = screen.getByTestId('table-next');

		// first page: Prev is disabled and clicking it keeps us on page 1
		expect(prev).toBeDisabled();
		expect(screen.getByTestId('table-row-p0')).toBeInTheDocument();
		await user.click(prev);
		expect(screen.getByTestId('table-row-p0')).toBeInTheDocument();

		// last page: Next becomes disabled and a further click stays put
		await user.click(next);
		expect(next).toBeDisabled();
		expect(screen.getByTestId('table-row-p25')).toBeInTheDocument();
		expect(screen.queryByTestId('table-row-p0')).toBeNull();
		await user.click(next);
		expect(screen.getByTestId('table-row-p25')).toBeInTheDocument();
	});
});
