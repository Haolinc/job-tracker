import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import Board from './Board';
import { makeApp } from '../test-utils';

const cfg = { highlightIds: new Set<string>(), onEdit: vi.fn(), onDelete: vi.fn() };

describe('Board', () => {
	it('should render the four status columns when there are no applications', () => {
		render(<Board applications={[]} {...cfg} />);
		for (const s of ['applied', 'interview', 'offer', 'rejected'])
			expect(screen.getByTestId(`board-column-${s}`)).toBeInTheDocument();
	});

	it('should place each application in its column when grouped by status', () => {
		render(<Board applications={[
			makeApp({ id: 'a1', status: 'applied', role: 'Software Engineer' }),
            makeApp({ id: 'i1', status: 'interview', role: 'Product Manager' }),
            makeApp({ id: 'o1', status: 'offer', role: 'Data Scientist' }),
			makeApp({ id: 'r1', status: 'rejected', role: 'UX Designer' }),
		]} {...cfg} />);
		expect(within(screen.getByTestId('board-column-applied')).getByTestId('app-card-a1')).toBeInTheDocument();
		expect(within(screen.getByTestId('board-column-interview')).getByTestId('app-card-i1')).toBeInTheDocument();
		expect(within(screen.getByTestId('board-column-offer')).getByTestId('app-card-o1')).toBeInTheDocument();
		expect(within(screen.getByTestId('board-column-rejected')).getByTestId('app-card-r1')).toBeInTheDocument();
	});
});
