import { useState, type ReactNode, type SubmitEventHandler } from 'react';
import type { ApplicationFormData, Status, InterviewStep } from '../types';
import { STATUS_LABELS, STEP_LABELS, emailOriginBadge, emailStageLabel } from '../constants';
import { extractMessageId } from '../utils/emailRefs';
import { todayLocalDate } from '../utils/localDate';

const EMPTY: ApplicationFormData = {
	company: '', role: '', status: 'applied', reached_interview: false,
	interview_step: '', date_applied: '', last_activity: '', job_url: '', external_id: '', notes: '',
	account: '', emails: [],
};

const todayIso = () => todayLocalDate();

interface Props {
	initial: Partial<ApplicationFormData> | null;
	onSave: (form: ApplicationFormData) => void;
	onClose: () => void;
}

export default function AddModal({ initial, onSave, onClose }: Props) {
	const [form, setForm] = useState<ApplicationFormData>(
		// external_id and account are string | null on the record; coerce null → '' so the inputs stay controlled.
		initial ? { ...EMPTY, ...initial, external_id: initial.external_id ?? '', account: initial.account ?? '', emails: initial.emails ?? [] } : EMPTY
	);
	// Draft for the "attach an email" row (a pasted Gmail link/id + the stage it represents).
	const [emailDraft, setEmailDraft] = useState('');
	const [emailDraftCat, setEmailDraftCat] = useState<Status>('applied');
	// The email row being dragged, and the one it is hovering over — together they drive the "lifted" and
	// "drop here" styling. Both reset when the drag ends, however it ends.
	const [draggedEmailIndex, setDraggedEmailIndex] = useState<number | null>(null);
	const [dropTargetEmailIndex, setDropTargetEmailIndex] = useState<number | null>(null);

	const set = <K extends keyof ApplicationFormData>(k: K, v: ApplicationFormData[K]) =>
		setForm(f => ({ ...f, [k]: v }));

	// A tracked email must say which inbox it lives in, so the account is required before attaching one.
	const account = form.account.trim();
	const draftId = extractMessageId(emailDraft);   // accepts a pasted Gmail link or a bare id
	// Reject a duplicate id too — two rows sharing a messageId collide on React's key and make remove ambiguous.
	const canAddEmail = !!account && draftId !== null && !form.emails.some(e => e.messageId === draftId);

	// Attaching here IS the manual procedure, so origin is stamped at the source. Every other ref passes
	// through untouched — reordering moves objects, it never edits them — so a save can't relabel one.
	const addEmail = () => {
		if (!account || !draftId) return;
		set('emails', [...form.emails, { messageId: draftId, category: emailDraftCat, date: todayIso(), origin: 'manual' }]);
		setEmailDraft('');
	};
	const removeEmail = (messageId: string) => set('emails', form.emails.filter(e => e.messageId !== messageId));

	// Reordering only touches the draft form — like every other field, it reaches the server on Save.
	// The stored order is what the card and table display, so this is how the user arranges those pills.
	const emailsAreReorderable = form.emails.length > 1;
	const endEmailDrag = () => { setDraggedEmailIndex(null); setDropTargetEmailIndex(null); };
	const moveEmail = (fromIndex: number, toIndex: number) => {
		if (fromIndex === toIndex) return;
		const reorderedEmails = [...form.emails];
		const [movedEmail] = reorderedEmails.splice(fromIndex, 1);
		reorderedEmails.splice(toIndex, 0, movedEmail);
		set('emails', reorderedEmails);
	};

	const handleSubmit: SubmitEventHandler<HTMLFormElement> = (e) => {
		e.preventDefault();
		if (!form.company.trim() || !form.role.trim()) return;
		onSave(form);
	};

	return (
		<div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
			<div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-xl w-full max-w-md max-h-[92dvh] flex flex-col">
				<div className="flex justify-between items-center px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-gray-100 shrink-0">
					<h2 data-testid="modal-title" className="text-lg font-semibold text-gray-800">
						{initial?.id ? 'Edit Application' : 'Add Application'}
					</h2>
					<button data-testid="modal-close" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
				</div>

				<form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4 overflow-y-auto">
					<Field label="Company *">
						<input data-testid="field-company" value={form.company} onChange={e => set('company', e.target.value)}
							required className={inputCls} placeholder="Acme Corp" />
					</Field>
					<Field label="Role *">
						<input data-testid="field-role" value={form.role} onChange={e => set('role', e.target.value)}
							required className={inputCls} placeholder="Software Engineer" />
					</Field>
					<Field label="Status">
						<select
							data-testid="field-status"
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
							<select data-testid="field-interview-step" value={form.interview_step} onChange={e => set('interview_step', e.target.value as InterviewStep | '')} className={inputCls}>
								<option value="">— Select Stage —</option>
								{(Object.entries(STEP_LABELS) as [InterviewStep, string][]).map(([v, label]) => (
									<option key={v} value={v}>{label}</option>
								))}
							</select>
						</Field>
					)}
					{form.status === 'rejected' && (
						<label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer select-none">
							<input
                                data-testid="field-reached-interview"
								type="checkbox"
								checked={form.reached_interview}
								onChange={e => set('reached_interview', e.target.checked)}
								className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
							/>
							<span>Interviewed before rejection <span className="text-gray-400">(counts toward interview rate)</span></span>
						</label>
					)}
					<div className="grid grid-cols-2 gap-3">
						<Field label="Date Applied">
							<input data-testid="field-date-applied" type="date" value={form.date_applied} onChange={e => set('date_applied', e.target.value)} className={inputCls} />
						</Field>
						<Field label="Last Response">
							<input data-testid="field-last-activity" type="date" value={form.last_activity} onChange={e => set('last_activity', e.target.value)} className={inputCls} />
						</Field>
					</div>
					<Field label="Job URL">
						<input data-testid="field-job-url" value={form.job_url} onChange={e => set('job_url', e.target.value)}
							className={inputCls} placeholder="https://..." />
					</Field>
					<Field label="Job / Req ID">
						<input data-testid="field-external-id" value={form.external_id} onChange={e => set('external_id', e.target.value)}
							className={inputCls} placeholder="e.g. 2026-0013799" />
					</Field>
					{/* Account + the emails that live in it, grouped in one box so they clearly belong together. */}
					<Field label="Tracked Emails">
						<div data-testid="field-emails" className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3">
							<input data-testid="field-account" type="email" value={form.account} onChange={e => set('account', e.target.value)}
								className={inputCls} placeholder="Gmail account these emails live in, e.g. you@gmail.com" />

							{form.emails.length > 0 && (
								<div className="flex flex-col gap-1 border-t border-gray-100 pt-2">
									{emailsAreReorderable && (
										<p data-testid="email-reorder-hint" className="text-xs text-gray-400">Drag to reorder</p>
									)}
									{form.emails.map((e, emailIndex) => {
										const isDragged = draggedEmailIndex === emailIndex;
										const isDropTarget = dropTargetEmailIndex === emailIndex && draggedEmailIndex !== emailIndex;
										const originBadge = emailOriginBadge(e);
										return (
											<div
												key={e.messageId}
												data-testid="email-row"
												// Leave the attribute off entirely for a lone email — it has nothing to swap with.
												draggable={emailsAreReorderable || undefined}
												onDragStart={emailsAreReorderable ? event => {
													setDraggedEmailIndex(emailIndex);
													event.dataTransfer.effectAllowed = 'move';
													// Some browsers refuse to start a drag unless some payload is set.
													event.dataTransfer.setData('text/plain', String(emailIndex));
												} : undefined}
												onDragOver={emailsAreReorderable ? event => {
													event.preventDefault();   // required, or onDrop never fires
													event.dataTransfer.dropEffect = 'move';
													setDropTargetEmailIndex(emailIndex);
												} : undefined}
												onDragLeave={emailsAreReorderable ? () => {
													setDropTargetEmailIndex(current => (current === emailIndex ? null : current));
												} : undefined}
												onDrop={emailsAreReorderable ? event => {
													event.preventDefault();
													if (draggedEmailIndex !== null) moveEmail(draggedEmailIndex, emailIndex);
													endEmailDrag();
												} : undefined}
												onDragEnd={emailsAreReorderable ? endEmailDrag : undefined}
												className={`flex items-center gap-2 text-xs rounded px-1 py-0.5${
													emailsAreReorderable ? ' cursor-grab active:cursor-grabbing' : ''
												}${isDragged ? ' opacity-40' : ''}${isDropTarget ? ' ring-2 ring-blue-400' : ''}`}
											>
												{emailsAreReorderable && <span aria-hidden className="text-gray-300 select-none">⠿</span>}
												<span data-testid="email-row-stage" data-fast-apply={e.fast_apply ? 'true' : 'false'}
													className="px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-gray-100 text-gray-600">
													{emailStageLabel(e)}</span>
												<span className="flex-1 truncate text-gray-500" title={e.messageId}>{e.messageId}</span>
												{/* Shown here and nowhere else: the board is for scanning, this is where emails get curated. */}
												<span data-testid="email-origin-badge" data-origin={e.origin ?? 'unknown'} title={originBadge.title}
													className={`px-1.5 py-0.5 rounded font-medium shrink-0 ${originBadge.cls}`}>{originBadge.label}</span>
												<button data-testid="email-row-remove" type="button" onClick={() => removeEmail(e.messageId)}
													className="text-gray-400 hover:text-red-500 px-1" title="Remove">&times;</button>
											</div>
										);
									})}
								</div>
							)}

							<div className="flex items-center gap-2 border-t border-gray-100 pt-2">
								<select data-testid="email-draft-category" value={emailDraftCat} onChange={e => setEmailDraftCat(e.target.value as Status)}
									disabled={!account}
									className="border border-gray-300 rounded-lg px-2 py-2 text-sm text-gray-700 bg-white disabled:opacity-50">
									{(Object.entries(STATUS_LABELS) as [Status, string][]).map(([v, label]) => (
										<option key={v} value={v}>{label}</option>
									))}
								</select>
								<input data-testid="email-draft-input" value={emailDraft} onChange={e => setEmailDraft(e.target.value)}
									disabled={!account} className={`${inputCls} disabled:opacity-50`} placeholder="paste a Gmail link or message id" />
								<button data-testid="email-draft-add" type="button" onClick={addEmail} disabled={!canAddEmail}
									className="px-3 py-2 rounded-lg text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium shrink-0 disabled:opacity-50">Add</button>
							</div>
							{!account && <p data-testid="email-account-hint" className="text-xs text-gray-400">Enter the Gmail account above to attach tracked emails.</p>}
						</div>
					</Field>
					<Field label="Notes">
						<textarea data-testid="field-notes" value={form.notes} onChange={e => set('notes', e.target.value)}
							rows={3} className={inputCls} placeholder="Any notes..." />
					</Field>

					<div className="flex justify-end gap-2 pt-1">
						<button data-testid="modal-cancel" type="button" onClick={onClose}
							className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100">Cancel</button>
						<button data-testid="modal-submit" type="submit"
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
