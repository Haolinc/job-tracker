import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddModal from './AddModal';
import type { ApplicationFormData } from '../types';

// Elements are located by stable data-testid (decoupled from copy/placeholder/styling); text and values
// are asserted separately. So a wording change to a label/button won't break "find the element".

describe('AddModal', () => {
    // Fills every field EXCEPT `skip`, so each negative test proves a single missing required field
	// is enough to block the save even when the rest of the form is complete.
    // USER SIMULLATION VERSION
	const fillAllExcept = async (user: ReturnType<typeof userEvent.setup>, skip: string) => {
		const text: [string, string][] = [
			['field-company', 'CVS Health'], ['field-role', 'Software Engineer'],
			['field-job-url', 'https://careers.example.com'], ['field-external-id', 'R0859802'], ['field-notes', 'a note'],
		];
		for (const [id, v] of text) if (id !== skip) await user.type(screen.getByTestId(id), v);
		// type="date" inputs: set directly (userEvent.type is unreliable on date inputs in jsdom)
		for (const [id, v] of [['field-date-applied', '2026-02-01'], ['field-last-activity', '2026-03-15']] as const)
			if (id !== skip) fireEvent.change(screen.getByTestId(id), { target: { value: v } });
	};

    // Sets every field EXCEPT `skip`, so each negative test proves a single missing required field
	// is enough to block the save even when the rest of the form is complete.
    // FAST VERSION
	const setAllExcept = (skip: string) => {
		const text: [string, string][] = [
			['field-company', 'CVS Health'], ['field-role', 'Software Engineer'],
			['field-job-url', 'https://careers.example.com'], ['field-external-id', 'R0859802'], ['field-notes', 'a note'],
            ['field-date-applied', '2026-02-01'], ['field-last-activity', '2026-03-15']
		];
		for (const [id, v] of text) if (id !== skip) fireEvent.change(screen.getByTestId(id), { target: { value: v } });
	};

    // Tests
	it('should render an empty form when adding a new application', () => {
		render(<AddModal initial={{}} onSave={vi.fn()} onClose={vi.fn()} />);
		expect(screen.getByTestId('modal-title')).toHaveTextContent('Add Application');
		// every text/date field blank...
		for (const id of ['field-company', 'field-role', 'field-date-applied', 'field-last-activity', 'field-job-url', 'field-external-id', 'field-notes'])
			expect(screen.getByTestId(id)).toHaveValue('');
		// ...and status defaults to "applied" (interview-stage / reached-interview fields only render for those statuses)
		expect(screen.getByTestId('field-status')).toHaveValue('applied');
	});

	it('should enter all values successfully and call onSave with the all the entered values when submitted', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		render(<AddModal initial={{}} onSave={onSave} onClose={vi.fn()} />);

        await fillAllExcept(user, '');
		await user.click(screen.getByTestId('modal-submit'));

		expect(onSave).toHaveBeenCalledTimes(1);
		// Exact match (not toMatchObject): the three typed fields carry their values and EVERY untouched
		// field is its empty default — guards against stale/garbage data leaking into the saved record.
		expect(onSave.mock.calls[0][0]).toEqual<ApplicationFormData>({
			company: 'CVS Health',
			role: 'Software Engineer',
			external_id: 'R0859802',
			status: 'applied',
			reached_interview: false,
			interview_step: '',
			date_applied: '2026-02-01',
			last_activity: '2026-03-15',
			job_url: 'https://careers.example.com',
			notes: 'a note',
		});
	});

    it('should call onSave with the all the entered values when submitted with default apply', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		render(<AddModal initial={{}} onSave={onSave} onClose={vi.fn()} />);

        setAllExcept('');
		await user.click(screen.getByTestId('modal-submit'));

		expect(onSave).toHaveBeenCalledTimes(1);
		// Exact match (not toMatchObject): the three typed fields carry their values and EVERY untouched
		// field is its empty default — guards against stale/garbage data leaking into the saved record.
		expect(onSave.mock.calls[0][0]).toEqual<ApplicationFormData>({
			company: 'CVS Health',
			role: 'Software Engineer',
			external_id: 'R0859802',
			status: 'applied',
			reached_interview: false,
			interview_step: '',
			date_applied: '2026-02-01',
			last_activity: '2026-03-15',
			job_url: 'https://careers.example.com',
			notes: 'a note',
		});
	});

    it('should call onSave with the all the entered values when submitted with default interview', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		render(<AddModal initial={{}} onSave={onSave} onClose={vi.fn()} />);

        setAllExcept('');
        // keep the interview field using select option to verify the select functionality
        await user.selectOptions(screen.getByTestId('field-status'), 'interview');
        await user.selectOptions(screen.getByTestId('field-interview-step'), 'phone_screen');
		await user.click(screen.getByTestId('modal-submit'));
        

		expect(onSave).toHaveBeenCalledTimes(1);
		// Exact match (not toMatchObject): the three typed fields carry their values and EVERY untouched
		// field is its empty default — guards against stale/garbage data leaking into the saved record.
		expect(onSave.mock.calls[0][0]).toEqual<ApplicationFormData>({
			company: 'CVS Health',
			role: 'Software Engineer',
			external_id: 'R0859802',
			status: 'interview',
			reached_interview: true,   // interview status auto-checks reached_interview
			interview_step: 'phone_screen',
			date_applied: '2026-02-01',
			last_activity: '2026-03-15',
			job_url: 'https://careers.example.com',
			notes: 'a note',
		});
	});

    it('should call onSave with the all the entered values when submitted with default reject', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		render(<AddModal initial={{}} onSave={onSave} onClose={vi.fn()} />);

        setAllExcept('');
        // keep the reject field using select option to verify the select functionality
        await user.selectOptions(screen.getByTestId('field-status'), 'rejected');
		await user.click(screen.getByTestId('modal-submit'));
        

		expect(onSave).toHaveBeenCalledTimes(1);
		// Exact match (not toMatchObject): the three typed fields carry their values and EVERY untouched
		// field is its empty default — guards against stale/garbage data leaking into the saved record.
		expect(onSave.mock.calls[0][0]).toEqual<ApplicationFormData>({
			company: 'CVS Health',
			role: 'Software Engineer',
			external_id: 'R0859802',
			status: 'rejected',
			reached_interview: false,
			interview_step: '',
			date_applied: '2026-02-01',
			last_activity: '2026-03-15',
			job_url: 'https://careers.example.com',
			notes: 'a note',
		});
	});

    it('should call onSave with the all the entered values when submitted with reached interview reject', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		render(<AddModal initial={{}} onSave={onSave} onClose={vi.fn()} />);

        setAllExcept('');
        // keep the reject related fields using select option and checkbox to verify functionality
        await user.selectOptions(screen.getByTestId('field-status'), 'rejected');
        await user.click(screen.getByTestId('field-reached-interview'));
		await user.click(screen.getByTestId('modal-submit'));
        

		expect(onSave).toHaveBeenCalledTimes(1);
		// Exact match (not toMatchObject): the three typed fields carry their values and EVERY untouched
		// field is its empty default — guards against stale/garbage data leaking into the saved record.
		expect(onSave.mock.calls[0][0]).toEqual<ApplicationFormData>({
			company: 'CVS Health',
			role: 'Software Engineer',
			external_id: 'R0859802',
			status: 'rejected',
			reached_interview: true,
			interview_step: '',
			date_applied: '2026-02-01',
			last_activity: '2026-03-15',
			job_url: 'https://careers.example.com',
			notes: 'a note',
		});
	});

    it('should call onSave with only company and role fields filled when submitted', async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		render(<AddModal initial={{}} onSave={onSave} onClose={vi.fn()} />);

        fireEvent.change(screen.getByTestId('field-company'), { target: { value: 'CVS Health' } });
		fireEvent.change(screen.getByTestId('field-role'), { target: { value: 'Software Engineer' } });
		await user.click(screen.getByTestId('modal-submit'));

		expect(onSave).toHaveBeenCalledTimes(1);
		// Exact match (not toMatchObject): the three typed fields carry their values and EVERY untouched
		// field is its empty default — guards against stale/garbage data leaking into the saved record.
		expect(onSave.mock.calls[0][0]).toEqual<ApplicationFormData>({
			company: 'CVS Health',
			role: 'Software Engineer',
			external_id: '',
			status: 'applied',
			reached_interview: false,
			interview_step: '',
			date_applied: '',
			last_activity: '',
			job_url: '',
			notes: '',
		});
	});

	it.each(['field-company', 'field-role'] as const)(
		'should NOT save when %s is empty even though every other field is filled', async (missing) => {
			const user = userEvent.setup();
			const onSave = vi.fn();
			render(<AddModal initial={{}} onSave={onSave} onClose={vi.fn()} />);
			setAllExcept(missing);
			await user.click(screen.getByTestId('modal-submit'));
			expect(onSave).not.toHaveBeenCalled();
			// the empty required field is flagged invalid → the browser keeps the modal open and prompts for input
			expect(screen.getByTestId(missing)).toBeInvalid();
		});

	it.each(['field-company', 'field-role'] as const)(
		'should NOT save when %s is only whitespace even though every other field is filled', async (ws) => {
			const user = userEvent.setup();
			const onSave = vi.fn();
			render(<AddModal initial={{}} onSave={onSave} onClose={vi.fn()} />);
			setAllExcept(ws);
			await user.type(screen.getByTestId(ws), '   ');   // passes HTML `required` (non-empty), caught by the trim() guard
			await user.click(screen.getByTestId('modal-submit'));
			expect(onSave).not.toHaveBeenCalled();
		});

	it('should pre-fill every field when editing an application', () => {
		const initial: Partial<ApplicationFormData> = {
			id: 'abc123', company: 'Lockheed Martin', role: 'Staff Engineer', status: 'applied',
			date_applied: '2026-02-01', last_activity: '2026-03-15', job_url: 'https://careers.example.com',
			external_id: '722493BR', notes: 'recruiter call scheduled',
		};
		render(<AddModal initial={initial} onSave={vi.fn()} onClose={vi.fn()} />);
		expect(screen.getByTestId('modal-title')).toHaveTextContent('Edit Application');
		const expected: Record<string, string> = {
			'field-company': 'Lockheed Martin', 'field-role': 'Staff Engineer', 'field-status': 'applied',
			'field-date-applied': '2026-02-01', 'field-last-activity': '2026-03-15',
			'field-job-url': 'https://careers.example.com', 'field-external-id': '722493BR',
			'field-notes': 'recruiter call scheduled',
		};
		for (const [id, val] of Object.entries(expected))
			expect(screen.getByTestId(id)).toHaveValue(val);
	});

	it('should render an empty input when the job id is null', () => {
		// records store external_id as string | null; the modal must keep the input controlled
		const initial = { id: 'x', company: 'Acme', role: 'SWE', external_id: null } as unknown as Partial<ApplicationFormData>;
		render(<AddModal initial={initial} onSave={vi.fn()} onClose={vi.fn()} />);
		expect(screen.getByTestId('field-external-id')).toHaveValue('');
	});

	it('should call onClose when the × button is clicked', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(<AddModal initial={{}} onSave={vi.fn()} onClose={onClose} />);
		await user.click(screen.getByTestId('modal-close'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
