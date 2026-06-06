import { useState, type ReactNode, type SubmitEventHandler } from 'react';
import type { ApplicationFormData, Status, InterviewStep } from '../types';
import { STATUS_LABELS, STEP_LABELS } from '../constants';

const EMPTY: ApplicationFormData = {
	company: '', role: '', status: 'applied', reached_interview: false,
	interview_step: '', date_applied: '', last_activity: '', job_url: '', notes: '',
};

interface Props {
	initial: Partial<ApplicationFormData> | null;
	onSave: (form: ApplicationFormData) => void;
	onClose: () => void;
}

export default function AddModal({ initial, onSave, onClose }: Props) {
	const [form, setForm] = useState<ApplicationFormData>(
		initial ? { ...EMPTY, ...initial } : EMPTY
	);

	const set = <K extends keyof ApplicationFormData>(k: K, v: ApplicationFormData[K]) =>
		setForm(f => ({ ...f, [k]: v }));

	const handleSubmit: SubmitEventHandler<HTMLFormElement> = (e) => {
		e.preventDefault();
		if (!form.company.trim() || !form.role.trim()) return;
		onSave(form);
	};

	return (
		<div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
			<div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-xl w-full max-w-md max-h-[92dvh] flex flex-col">
				<div className="flex justify-between items-center px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-gray-100 shrink-0">
					<h2 className="text-lg font-semibold text-gray-800">
						{initial?.id ? 'Edit Application' : 'Add Application'}
					</h2>
					<button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
				</div>

				<form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4 overflow-y-auto">
					<Field label="Company *">
						<input value={form.company} onChange={e => set('company', e.target.value)}
							required className={inputCls} placeholder="Acme Corp" />
					</Field>
					<Field label="Role *">
						<input value={form.role} onChange={e => set('role', e.target.value)}
							required className={inputCls} placeholder="Software Engineer" />
					</Field>
					<Field label="Status">
						<select
							value={form.status}
							onChange={e => {
								const status = e.target.value as Status;
								set('status', status);
								// Reaching interview/offer means the app has interviewed — auto-check (sticky; never auto-unchecks).
								if (status === 'interview' || status === 'offer') set('reached_interview', true);
							}}
							className={inputCls}
						>
							{(Object.entries(STATUS_LABELS) as [Status, string][]).map(([v, label]) => (
								<option key={v} value={v}>{label}</option>
							))}
						</select>
					</Field>
					{form.status === 'interview' && (
						<Field label="Interview Stage">
							<select value={form.interview_step} onChange={e => set('interview_step', e.target.value as InterviewStep | '')} className={inputCls}>
								<option value="">— Select Stage —</option>
								{(Object.entries(STEP_LABELS) as [InterviewStep, string][]).map(([v, label]) => (
									<option key={v} value={v}>{label}</option>
								))}
							</select>
						</Field>
					)}
					{form.status === 'rejected' && (
						<label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
							<input
								type="checkbox"
								checked={form.reached_interview}
								onChange={e => set('reached_interview', e.target.checked)}
								className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
							/>
							Interviewed before rejection <span className="text-gray-400">(counts toward interview rate)</span>
						</label>
					)}
					<div className="grid grid-cols-2 gap-3">
						<Field label="Date Applied">
							<input type="date" value={form.date_applied} onChange={e => set('date_applied', e.target.value)} className={inputCls} />
						</Field>
						<Field label="Last Response">
							<input type="date" value={form.last_activity} onChange={e => set('last_activity', e.target.value)} className={inputCls} />
						</Field>
					</div>
					<Field label="Job URL">
						<input value={form.job_url} onChange={e => set('job_url', e.target.value)}
							className={inputCls} placeholder="https://..." />
					</Field>
					<Field label="Notes">
						<textarea value={form.notes} onChange={e => set('notes', e.target.value)}
							rows={3} className={inputCls} placeholder="Any notes..." />
					</Field>

					<div className="flex justify-end gap-2 pt-1">
						<button type="button" onClick={onClose}
							className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100">Cancel</button>
						<button type="submit"
							className="px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700 font-medium">
							{initial?.id ? 'Save Changes' : 'Add Application'}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<label className="text-xs font-medium text-gray-600">{label}</label>
			{children}
		</div>
	);
}

const inputCls = 'border border-gray-300 rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-400';
