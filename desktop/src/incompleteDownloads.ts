// A tiny persisted set of model names whose download was interrupted (cancelled, or failed mid-transfer).
// Ollama can't enumerate partial downloads — the on-disk blobs are content-addressed with no name mapping —
// so this is our own record, letting the launcher offer Resume / Reclaim across restarts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { errorText, type LogFn } from './log';

export class IncompleteDownloadStore {
	private readonly names: Set<string>;

	constructor(
		private readonly filePath: string,
		private readonly log: LogFn,
	) {
		this.names = new Set(this.readFromDisk());
	}

	list(): string[] {
		return [...this.names];
	}

	/** Record a model as incomplete (no-op if already tracked). */
	add(modelName: string): void {
		if (this.names.has(modelName)) return;
		this.names.add(modelName);
		this.writeToDisk();
	}

	/** Forget a model — it finished downloading, was deleted, or its partial data was reclaimed. */
	remove(modelName: string): void {
		if (!this.names.delete(modelName)) return;
		this.writeToDisk();
	}

	clear(): void {
		if (this.names.size === 0) return;
		this.names.clear();
		this.writeToDisk();
	}

	private readFromDisk(): string[] {
		try {
			if (!existsSync(this.filePath)) return [];
			const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
			return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
		} catch (error) {
			// A corrupt/unreadable record isn't fatal — the partial blobs still exist, we just lose the list.
			this.log('launcher', `Could not read the incomplete-downloads record: ${errorText(error)}`);
			return [];
		}
	}

	private writeToDisk(): void {
		try {
			writeFileSync(this.filePath, JSON.stringify([...this.names], null, 2));
		} catch (error) {
			// Best-effort persistence; the in-memory set stays correct for this session even if the write fails.
			this.log('launcher', `Could not save the incomplete-downloads record: ${errorText(error)}`);
		}
	}
}
