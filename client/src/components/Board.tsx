import { DndContext, closestCorners, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
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
	onEdit: (app: Application) => void;
	onDelete: (id: number) => void;
}

function KanbanColumn({ col, apps, onEdit, onDelete }: ColumnProps) {
	const { setNodeRef } = useDroppable({ id: col.id });
	return (
		<div className={`flex flex-col rounded-xl border ${col.color} min-w-[200px] flex-1`}>
			<div className="px-4 py-3 flex items-center justify-between">
				<span className="font-semibold text-sm text-gray-700">{col.label}</span>
				<span className="text-xs text-gray-400 bg-white/70 rounded-full px-2 py-0.5">{apps.length}</span>
			</div>
			<div ref={setNodeRef} className="flex flex-col gap-2 px-3 pb-3 min-h-[120px]">
				<SortableContext items={apps.map(a => a.id)} strategy={verticalListSortingStrategy}>
					{apps.map(app => (
						<Card key={app.id} app={app} onEdit={onEdit} onDelete={onDelete} />
					))}
				</SortableContext>
			</div>
		</div>
	);
}

interface BoardProps {
	applications: Application[];
	onEdit: (app: Application) => void;
	onDelete: (id: number) => void;
	onStatusChange: (id: number, status: Status) => void;
}

export default function Board({ applications, onEdit, onDelete, onStatusChange }: BoardProps) {
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		if (!over) return;
		const app = applications.find(a => a.id === active.id);
		const newStatus = COLUMNS.find(c => c.id === over.id)?.id;
		if (app && newStatus && app.status !== newStatus) {
			onStatusChange(app.id, newStatus);
		}
	};

	return (
		<DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
			<div className="flex gap-4 overflow-x-auto pb-4">
				{COLUMNS.map(col => (
					<KanbanColumn
						key={col.id}
						col={col}
						apps={applications.filter(a => a.status === col.id)}
						onEdit={onEdit}
						onDelete={onDelete}
					/>
				))}
			</div>
		</DndContext>
	);
}
