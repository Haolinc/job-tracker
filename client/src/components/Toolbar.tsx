import { useRef } from 'react';

export type View = 'board' | 'table';

interface ToolbarProps {
	view: View;
	onViewChange: (view: View) => void;
	onImportFile: (file: File) => void;
	onExport: () => void;
	exportDisabled: boolean;
	onReset: () => void;
	onAdd: () => void;
}

/** The board/table toggle plus the import / export / reset / add actions in the page header. */
export default function Toolbar({ view, onViewChange, onImportFile, onExport, exportDisabled, onReset, onAdd }: ToolbarProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);

	return (
		<div className="flex flex-wrap items-center gap-2">
			<div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm font-medium">
				<button
					data-testid="view-board"
					onClick={() => onViewChange('board')}
					className={`px-3 py-2 ${view === 'board' ? 'bg-gray-100 text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
				>⊞ Board</button>
				<button
					data-testid="view-table"
					onClick={() => onViewChange('table')}
					className={`px-3 py-2 border-l border-gray-200 ${view === 'table' ? 'bg-gray-100 text-gray-800' : 'text-gray-500 hover:bg-gray-50'}`}
				>☰ Table</button>
			</div>
			<div className="w-px h-6 bg-gray-300 mx-1" />
			<input
				ref={fileInputRef}
				type="file"
				accept=".csv,text/csv"
				className="hidden"
				onChange={e => {
					const file = e.target.files?.[0];
					e.target.value = '';
					if (file) onImportFile(file);
				}}
			/>
			<button
				data-testid="btn-import-csv"
				onClick={() => fileInputRef.current?.click()}
				className="px-3 py-2 border border-emerald-200 bg-white text-emerald-700 text-sm font-medium rounded-lg hover:bg-emerald-100"
				title="Import applications from a CSV file"
			>
				⤒ Import CSV
			</button>
			<button
				data-testid="btn-export-csv"
				onClick={onExport}
				disabled={exportDisabled}
				className="px-3 py-2 border border-blue-200 bg-white text-blue-600 text-sm font-medium rounded-lg hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed"
				title="Download the current applications as a CSV file"
			>
				⤓ Export CSV
			</button>
			<button
				data-testid="btn-reset-db"
				onClick={onReset}
				className="px-3 py-2 border border-red-200 bg-white text-red-500 text-sm font-medium rounded-lg hover:bg-red-50"
				title="Wipe all applications and sync history"
			>
				⚠ Reset DB
			</button>
			<button
				data-testid="btn-add-application"
				onClick={onAdd}
				className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg"
			>
				+ Add Application
			</button>
		</div>
	);
}
