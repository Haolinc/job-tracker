import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Application, InterviewStep } from '../types';

const STEP_LABELS: Record<InterviewStep, string> = {
	phone_screen: 'Phone Screen',
	technical: 'Technical',
	onsite: 'Onsite',
	final: 'Final Round',
};

interface Props {
	app: Application;
	onEdit: (app: Application) => void;
	onDelete: (id: number) => void;
}

export default function Card({ app, onEdit, onDelete }: Props) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: app.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 cursor-grab active:cursor-grabbing select-none"
			{...attributes}
			{...(listeners ?? {})}
		>
			<div className="flex justify-between items-start gap-2">
				<div className="min-w-0">
					<p className="font-semibold text-gray-800 truncate">{app.company}</p>
					<p className="text-sm text-gray-500 truncate">{app.role}</p>
				</div>
				<div className="flex gap-1 shrink-0">
					<button
						onPointerDown={e => e.stopPropagation()}
						onClick={e => { e.stopPropagation(); onEdit(app); }}
						className="text-gray-400 hover:text-blue-500 text-xs px-1"
						title="Edit"
					>✏️</button>
					<button
						onPointerDown={e => e.stopPropagation()}
						onClick={e => { e.stopPropagation(); onDelete(app.id); }}
						className="text-gray-400 hover:text-red-500 text-xs px-1"
						title="Delete"
					>🗑️</button>
				</div>
			</div>

			<div className="mt-2 flex items-center gap-2 flex-wrap">
				{app.interview_step && (
					<span className="text-xs px-2 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700">
						{STEP_LABELS[app.interview_step]}
					</span>
				)}
				{app.source === 'gmail' && (
					<span className="text-xs text-blue-400" title="Auto-detected from Gmail">📧</span>
				)}
			</div>

			<div className="mt-2 flex flex-col gap-0.5">
				{app.date_applied && (
					<span className="text-xs text-gray-400">Applied: {app.date_applied}</span>
				)}
				{app.last_activity && (
					<span className="text-xs text-gray-400">Last response: {app.last_activity}</span>
				)}
			</div>

			{app.notes && (
				<p className="mt-2 text-xs text-gray-400 line-clamp-2">{app.notes}</p>
			)}
		</div>
	);
}
