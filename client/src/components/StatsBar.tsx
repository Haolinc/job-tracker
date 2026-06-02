import { memo } from 'react';
import type { Application } from '../types';

interface Props {
	applications: Application[];
}

export default memo(function StatsBar({ applications }: Props) {
	const total = applications.length;
	const active = applications.filter(a => a.status !== 'rejected').length;
	const offers = applications.filter(a => a.status === 'offer').length;
	// interview/offer are interviewed by definition; the sticky flag only resolves rejected apps
	// (rejected-after-interview). So interview/offer count even if the flag was never set.
	const interviewed = applications.filter(a => a.status === 'interview' || a.status === 'offer' || a.reached_interview).length;
	const rate = total > 0 ? ((interviewed / total) * 100).toFixed(1) : '0.0';

	const stat = (label: string, value: string | number, color: string) => (
		<div className="flex flex-col items-center px-6 py-3 bg-white rounded-xl shadow-sm border border-gray-100">
			<span className={`text-2xl font-bold ${color}`}>{value}</span>
			<span className="text-xs text-gray-500 mt-0.5">{label}</span>
		</div>
	);

	return (
		<div className="flex gap-3 flex-wrap">
			{stat('Total', total, 'text-gray-800')}
			{stat('Active', active, 'text-blue-600')}
			{stat('Offers', offers, 'text-green-600')}
			{stat('Interview Rate', `${rate}%`, 'text-purple-600')}
		</div>
	);
});