import { useState } from 'react';
import type { Application, InterviewStep, Status } from '../types';

const STATUS_COLORS: Record<Status, string> = {
	applied:   'bg-blue-100 text-blue-700',
	interview: 'bg-yellow-100 text-yellow-700',
	offer:     'bg-green-100 text-green-700',
	rejected:  'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<Status, string> = {
	applied:   'Applied',
	interview: 'Interview',
	offer:     'Offer',
	rejected:  'Rejected',
};

const STEP_LABELS: Record<InterviewStep, string> = {
	phone_screen: 'Phone Screen',
	technical:    'Technical',
	onsite:       'Onsite',
	final:        'Final Round',
};

type SortKey = 'company' | 'role' | 'status' | 'date_applied' | 'last_activity';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 25;

interface Props {
	applications: Application[];
	onEdit: (app: Application) => void;
	onDelete: (id: number) => void;
}

interface ThProps {
	label: string;
	col?: SortKey;
	sortKey: SortKey;
	sortDir: SortDir;
	onSort: (col: SortKey) => void;
}

function Th({ label, col, sortKey, sortDir, onSort }: ThProps) {
	const active = col && col === sortKey;
	return (
		<th
			onClick={col ? () => onSort(col) : undefined}
			className={`px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap
				${col ? 'cursor-pointer select-none hover:text-gray-800' : ''}
				${active ? 'text-gray-800' : ''}`}
		>
			{label}
			{active && <span className="ml-1 text-gray-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
		</th>
	);
}

export default function TableView({ applications, onEdit, onDelete }: Props) {
	const [sortKey, setSortKey] = useState<SortKey>('date_applied');
	const [sortDir, setSortDir] = useState<SortDir>('desc');
	const [page, setPage] = useState(0);

	const handleSort = (col: SortKey) => {
		if (col === sortKey) {
			setSortDir(d => d === 'asc' ? 'desc' : 'asc');
		} else {
			setSortKey(col);
			setSortDir('asc');
		}
		setPage(0);
	};

	const sorted = [...applications].sort((a, b) => {
		const av = a[sortKey] ?? '';
		const bv = b[sortKey] ?? '';
		const cmp = String(av).localeCompare(String(bv));
		return sortDir === 'asc' ? cmp : -cmp;
	});

	const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
	// Clamp page to valid range — handles filter changes that shrink total pages
	const effectivePage = totalPages > 0 ? Math.min(page, totalPages - 1) : 0;
	const pageData = sorted.slice(effectivePage * PAGE_SIZE, (effectivePage + 1) * PAGE_SIZE);

	const thProps = { sortKey, sortDir, onSort: handleSort };

	return (
		<div className="space-y-3">
			<div className="rounded-xl border border-gray-200 overflow-x-auto">
				<table className="w-full text-sm">
					<thead className="bg-gray-50 border-b border-gray-200">
						<tr>
							<Th label="Company"       col="company"       {...thProps} />
							<Th label="Role"          col="role"          {...thProps} />
							<Th label="Status"        col="status"        {...thProps} />
							<Th label="Stage"                             {...thProps} />
							<Th label="Applied"       col="date_applied"  {...thProps} />
							<Th label="Last Response" col="last_activity" {...thProps} />
							<Th label=""                                  {...thProps} />
						</tr>
					</thead>
					<tbody className="divide-y divide-gray-100">
						{pageData.length === 0 ? (
							<tr>
								<td colSpan={7} className="px-4 py-12 text-center text-gray-400">
									No applications found
								</td>
							</tr>
						) : pageData.map(app => (
							<tr key={app.id} className="hover:bg-gray-50 group">
								<td className="px-4 py-3 font-medium text-gray-800 whitespace-nowrap max-w-[200px] truncate">
									<button onClick={() => onEdit(app)} className="hover:text-blue-600 text-left truncate w-full">
										{app.company}
										{app.source === 'gmail' && (
											<span className="ml-1.5 text-xs text-blue-400" title="Auto-detected from Gmail">📧</span>
										)}
									</button>
								</td>
								<td className="px-4 py-3 text-gray-600 whitespace-nowrap max-w-[200px] truncate">{app.role}</td>
								<td className="px-4 py-3 whitespace-nowrap">
									<span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[app.status]}`}>
										{STATUS_LABELS[app.status]}
									</span>
								</td>
								<td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
									{app.interview_step ? (
										<span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">
											{STEP_LABELS[app.interview_step]}
										</span>
									) : '—'}
								</td>
								<td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">{app.date_applied ?? '—'}</td>
								<td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">{app.last_activity ?? '—'}</td>
								<td className="px-4 py-3 whitespace-nowrap">
									<div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
										<button
											onClick={() => onEdit(app)}
											className="text-gray-400 hover:text-blue-500 px-1"
											title="Edit"
										>✏️</button>
										<button
											onClick={() => onDelete(app.id)}
											className="text-gray-400 hover:text-red-500 px-1"
											title="Delete"
										>🗑️</button>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{totalPages > 1 && (
				<div className="flex items-center justify-between text-sm text-gray-500 px-1">
					<span>
						{effectivePage * PAGE_SIZE + 1}–{Math.min((effectivePage + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
					</span>
					<div className="flex gap-1">
						<button
							onClick={() => setPage(p => Math.max(0, p - 1))}
							disabled={effectivePage === 0}
							className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
						>← Prev</button>
						<button
							onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
							disabled={effectivePage === totalPages - 1}
							className="px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
						>Next →</button>
					</div>
				</div>
			)}
		</div>
	);
}
