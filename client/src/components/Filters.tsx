import type { Filters } from '../types';

interface Props {
	filters: Filters;
	onChange: (filters: Filters) => void;
}

export default function Filters({ filters, onChange }: Props) {
	return (
		<div className="flex gap-3 flex-wrap">
			<input
				type="text"
				placeholder="Search company or role..."
				value={filters.search}
				onChange={e => onChange({ ...filters, search: e.target.value })}
				className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-400"
			/>
		</div>
	);
}
