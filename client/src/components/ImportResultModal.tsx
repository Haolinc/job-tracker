import { useEffect, useRef } from 'react';

export interface ImportStat {
	label: string;
	value: number;
	cls?: string;   // value text colour, e.g. 'text-emerald-600'
}

export interface ImportOutcome {
	tone: 'success' | 'warning' | 'error';
	title: string;
	message?: string;     // freeform line — used for errors / "nothing imported"
	stats?: ImportStat[]; // structured breakdown — used for a completed import
}

const TONE: Record<ImportOutcome['tone'], { ring: string; icon: string }> = {
	success: { ring: 'bg-emerald-100 text-emerald-600', icon: '✓' },
	warning: { ring: 'bg-amber-100 text-amber-600',     icon: '!' },
	error:   { ring: 'bg-red-100 text-red-600',         icon: '✕' },
};

interface Props {
	outcome: ImportOutcome;
	onClose: () => void;
}

export default function ImportResultModal({ outcome, onClose }: Props) {
	const okRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		okRef.current?.focus();
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	const tone = TONE[outcome.tone];

	return (
		<div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
			<div
				role="dialog"
				aria-modal="true"
				onClick={e => e.stopPropagation()}
				className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 text-center"
			>
				<div className={`mx-auto mb-4 flex items-center justify-center w-12 h-12 rounded-full text-2xl font-bold ${tone.ring}`}>
					{tone.icon}
				</div>

				<h2 className="text-lg font-semibold text-gray-800">{outcome.title}</h2>
				{outcome.message && <p className="mt-2 text-sm text-gray-500">{outcome.message}</p>}

				{outcome.stats && outcome.stats.length > 0 && (
					<div className="mt-4 rounded-xl border border-gray-100 divide-y divide-gray-100 text-left">
						{outcome.stats.map(s => (
							<div key={s.label} className="flex items-center justify-between px-4 py-2.5 text-sm">
								<span className="text-gray-600">{s.label}</span>
								<span className={`font-semibold tabular-nums ${s.cls ?? 'text-gray-800'}`}>{s.value}</span>
							</div>
						))}
					</div>
				)}

				<button
					ref={okRef}
					onClick={onClose}
					className="mt-5 w-full px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
				>
					Done
				</button>
			</div>
		</div>
	);
}
