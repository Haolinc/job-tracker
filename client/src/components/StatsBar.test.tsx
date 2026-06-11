import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatsBar from './StatsBar';
import { makeApp } from '../test-utils';

describe('StatsBar', () => {
	it('should compute the summary counts and interview rate when given applications', () => {
		render(<StatsBar applications={[
			makeApp({ status: 'applied' }), makeApp({ status: 'applied' }),
			makeApp({ status: 'interview' }), makeApp({ status: 'offer' }),         // both interviewed
			makeApp({ status: 'rejected', reached_interview: true }),               // interviewed
			makeApp({ status: 'rejected' }),
		]} />);
		expect(screen.getByTestId('stat-total')).toHaveTextContent('6');
		expect(screen.getByTestId('stat-active')).toHaveTextContent('4');           // non-rejected
		expect(screen.getByTestId('stat-offers')).toHaveTextContent('1');
		expect(screen.getByTestId('stat-interview-rate')).toHaveTextContent('50.0%'); // 3 of 6
	});

	it('should render zeros when the list is empty', () => {
		render(<StatsBar applications={[]} />);
		expect(screen.getByTestId('stat-total')).toHaveTextContent('0');
        expect(screen.getByTestId('stat-active')).toHaveTextContent('0');           // non-rejected
		expect(screen.getByTestId('stat-offers')).toHaveTextContent('0');
		expect(screen.getByTestId('stat-interview-rate')).toHaveTextContent('0.0%');
	});
});
