import { useMemo, useState } from 'react';
import Card from './Card';
import type { Application, Status } from '../types';

interface Column {
	id: Status;
	label: string;
	color: string;
}

const COLUMNS: Column[] = [
	{ id: 'applied',   label: 'Applied',   color: 'bg-blue-50   border-blue-200' },
	{ id: 'interview', label: 'Interview', color: 'bg-yellow-50 border-yellow-200' },
	{ id: 'offer',     label: 'Offer',     color: 'bg-green-50  border-green-200' },
	{ id: 'rejected',  label: 'Rejected',  color: 'bg-red-50    border-red-200' },
];

interface ColumnProps {
	col: Column;
	apps: Application[];
	highlightIds: Set<string>;
	onEdit: (app: Application) => void;
	onDelete: (id: string) => void;
}

// How many cards a collapsed column previews before "Show N more". Fixed (not screen-dependent) so the
// layout is predictable and the "Show N more" count stays correct — bump this one number to taste.
const COLLAPSED_PREVIEW = 3;

function KanbanColumn({ col, apps, highlightIds, onEdit, onDelete }: ColumnProps) {
	const [collapsed, setCollapsed] = useState(true);
	const visible = collapsed ? apps.slice(0, COLLAPSED_PREVIEW) : apps;
	const hidden = apps.length - visible.length;
	return (
		<div data-testid={`board-column-${col.id}`} className={`flex flex-col rounded-xl border ${col.color} min-w-[160px] sm:min-w-[200px] flex-1 self-start`}>
			<button
				onClick={() => setCollapsed(c => !c)}
				className="px-4 py-3 flex items-center justify-between w-full text-left rounded-xl hover:bg-black/[0.03] transition-colors"
				title={collapsed ? 'Expand' : 'Collapse'}
			>
				<span className="flex items-center gap-2 font-semibold text-sm text-gray-700">
					<span className="inline-flex items-center justify-center w-4 h-4 text-base leading-none text-gray-500">
						{collapsed && hidden > 0 ? '+' : '–'}
					</span>
					{col.label}
				</span>
				<span className="text-xs text-gray-400 bg-white/70 rounded-full px-2 py-0.5">{apps.length}</span>
			</button>
			<div className="flex flex-col gap-2 px-3 pb-3 min-h-[60px]">
				{visible.map(app => (
					<Card key={app.id} app={app} isNew={highlightIds.has(app.id)} onEdit={onEdit} onDelete={onDelete} />
				))}
				{apps.length > COLLAPSED_PREVIEW && (
					<button
						onClick={() => setCollapsed(c => !c)}
						className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg border border-dashed border-gray-300 bg-white/70 text-xs font-semibold text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-white transition-colors"
					>
						{collapsed ? `▾  Show ${hidden} more` : '▴  Show less'}
					</button>
				)}
			</div>
		</div>
	);
}

interface BoardProps {
	applications: Application[];
	highlightIds: Set<string>;
	onEdit: (app: Application) => void;
	onDelete: (id: string) => void;
}

export default function Board({ applications, highlightIds, onEdit, onDelete }: BoardProps) {
	const byStatus = useMemo(() => {
		const groups: Partial<Record<Status, Application[]>> = {};
		for (const app of applications) {
			(groups[app.status] ??= []).push(app);
		}
		// Order each column by Last Response, most recent first (empty dates sort last).
		for (const list of Object.values(groups)) {
			list?.sort((a, b) => String(b.last_activity ?? '').localeCompare(String(a.last_activity ?? '')));
		}
		return groups;
	}, [applications]);

	return (
		<div data-testid="board" className="flex gap-3 sm:gap-4 overflow-x-auto pb-4 -mx-4 sm:mx-0 px-4 sm:px-0">
			{COLUMNS.map(col => (
				<KanbanColumn
					key={col.id}
					col={col}
					apps={byStatus[col.id] ?? []}
					highlightIds={highlightIds}
					onEdit={onEdit}
					onDelete={onDelete}
				/>
			))}
		</div>
	);
}
