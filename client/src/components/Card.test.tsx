import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Card from './Card';
import { makeApp } from '../test-utils';

const user = userEvent.setup();

describe('Card', () => {
	it('should call onEdit and onDelete when the buttons are clicked', async () => {
		const onEdit = vi.fn(), onDelete = vi.fn();
		const app = makeApp({ id: 'x1', company: 'CVS Health', role: 'Software Engineer' });
		render(<Card app={app} onEdit={onEdit} onDelete={onDelete} />);
		const card = screen.getByTestId('app-card-x1');
		expect(card).toHaveTextContent('CVS Health');
		expect(card).toHaveTextContent('Software Engineer');
		await user.click(within(card).getByTestId('card-edit'));
		await user.click(within(card).getByTestId('card-delete'));
		expect(onEdit).toHaveBeenCalledWith(app);
		expect(onDelete).toHaveBeenCalledWith('x1');
	});

	it.each([
		['Unknown role', makeApp({ id: 'c', role: 'Unknown Role' }), false],
		['New', makeApp({ id: 'c' }), true],
		['Imported', makeApp({ id: 'c', source: 'csv' }), false],
	] as const)('should render the "%s" indicator when applicable', (text, app, isNew) => {
		render(<Card app={app} isNew={isNew} onEdit={vi.fn()} onDelete={vi.fn()} />);
		expect(screen.getByTestId('app-card-c')).toHaveTextContent(text);
	});
});
