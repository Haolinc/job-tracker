import { useState } from 'react';
import type { SyncResult, SyncProgress } from '../types';
import { formatDuration } from '../utils/formatDuration';

const SCAN_WINDOWS = [30, 60, 90, 180];

interface Props {
	connected: boolean;
	syncing: boolean;
	progress: SyncProgress | null;
	lastResult: SyncResult | null;
	error: string | null;
	onConnect: () => void;
	onDisconnect: () => void;
	onSync: (days: number) => void;
}

export default function GmailSync({ connected, syncing, progress, lastResult, error, onConnect, onDisconnect, onSync }: Props) {
	const [days, setDays] = useState(30);
	return (
		<div className="flex items-center gap-2 flex-wrap">
			{connected ? (
				<>
					<select
						value={days}
						onChange={e => setDays(Number(e.target.value))}
						disabled={syncing}
						title="How far back to scan Gmail"
						className="px-2 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white disabled:opacity-60"
					>
						{SCAN_WINDOWS.map(d => <option key={d} value={d}>Last {d} days</option>)}
					</select>
					<button
						onClick={() => onSync(days)}
						disabled={syncing}
						className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
					>
						{syncing
							? <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
							: '\u{1F4E7}'}
						{syncing ? 'Syncing...' : 'Sync Gmail'}
					</button>
					<button
						onClick={onDisconnect}
						className="text-xs text-gray-400 hover:text-red-500 underline"
					>Disconnect</button>
					{syncing && (
						progress ? (
							<div className="flex items-center gap-2 text-xs text-gray-600 w-full sm:w-auto" title={`${progress.processed} of ${progress.total} emails processed`}>
								<div className="flex-1 sm:w-28 sm:flex-none h-1.5 bg-gray-200 rounded-full overflow-hidden">
									<div
										className="h-full bg-blue-600 transition-all duration-200"
										style={{ width: `${progress.total ? Math.round((progress.processed / progress.total) * 100) : 0}%` }}
									/>
								</div>
								<span className="tabular-nums whitespace-nowrap">
									{progress.processed}/{progress.total} &middot; +{progress.added} ~{progress.updated}
								</span>
							</div>
						) : (
							<span className="text-xs text-gray-500">preparing&hellip;</span>
						)
					)}
					{!syncing && lastResult && (
						<span className="text-xs text-gray-400 w-full sm:w-auto">
							<span className="font-semibold text-emerald-600">+{lastResult.added} added</span>
							{' '}&middot;{' '}
							<span className="font-semibold text-blue-600">{lastResult.updated} updated</span>
							{' '}&middot;{' '}
							<span className="text-gray-400">{lastResult.skipped} skipped</span>
							{' '}&middot;{' '}
							<span className="font-semibold text-purple-600">{formatDuration(lastResult.durationMs)}</span>
							{lastResult.failed > 0 && (
								<span
									className="text-amber-600 font-medium"
									title="These emails couldn't be read this time (a temporary Gmail error). They were not saved and will be retried automatically on your next sync."
								>
									{' '}&middot; &#x26A0; {lastResult.failed} couldn&apos;t be read (will retry)
								</span>
							)}
						</span>
					)}
					{error && <span className="text-xs text-red-500 w-full sm:w-auto">{error}</span>}
				</>
			) : (
				<button
					onClick={onConnect}
					className="flex items-center gap-2 px-4 py-2 border border-gray-300 hover:border-gray-400 bg-white text-gray-700 text-sm font-medium rounded-lg transition-colors"
				>
					<svg className="w-4 h-4" viewBox="0 0 24 24">
						<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
						<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
						<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
						<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
					</svg>
					Connect Gmail
				</button>
			)}
		</div>
	);
}
