import { useState, useEffect } from 'react';
import type { Filters } from '../types';

interface Props {
	filters: Filters;
	onChange: (filters: Filters) => void;
}

export default function Filters({ filters, onChange }: Props) {
	const [search, setSearch] = useState(filters.search);

	useEffect(() => {
		const id = setTimeout(() => onChange({ search }), 300);
		return () => clearTimeout(id);
	}, [search, onChange]);

	return (
		<div className="flex gap-3 flex-wrap">
			<input
				type="text"
				placeholder="Search company or role..."
				value={search}
				onChange={e => setSearch(e.target.value)}
				className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full sm:w-64 focus:outline-none focus:ring-2 focus:ring-blue-400"
			/>
		</div>
	);
}
