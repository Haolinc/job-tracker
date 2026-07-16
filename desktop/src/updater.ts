// Auto-update via Velopack, with the user in charge of every step: a found update shows its version,
// release notes, and download size and asks before downloading; a finished download asks whether to
// restart now or install on close. Both packaged flavours (installed and portable) go through the same
// mechanism: Update.exe swaps the current/ folder for the new version once the launcher exits.

import { app, dialog, type BrowserWindow } from 'electron';
import { UpdateManager, VelopackApp, type UpdateInfo } from 'velopack';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { logToTerminal, type LogFn } from './log';

/**
 * Velopack's startup hooks: during install/update (and when finishing a pending update) it may restart
 * or exit this process, so the composition root must call this before any other Electron startup work.
 */
export function runVelopackStartupHooks(): void {
	VelopackApp.build().run();
}

/**
 * Where updates come from: the repo's GitHub Releases (Velopack auto-detects github.com URLs and reads the
 * releases.win.json feed that `vpk upload github` attaches). The URL lives in package.json's `repository`
 * field — the same manifest the version comes from. JOBTRACKER_UPDATE_SOURCE overrides it with a local
 * folder of vpk-packed releases, so the whole flow can be tested end-to-end without publishing anything.
 */
function updateSourceLocation(): string {
	if (process.env.JOBTRACKER_UPDATE_SOURCE) return process.env.JOBTRACKER_UPDATE_SOURCE;
	const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
	return manifest.repository;
}

/** Bytes the download will actually fetch: the delta chain when one applies, else the full package. */
function expectedDownloadBytes(updateInfo: UpdateInfo): number {
	const deltaBytes = updateInfo.DeltasToTarget.reduce((total, delta) => total + delta.Size, 0);
	return deltaBytes > 0 ? deltaBytes : updateInfo.TargetFullRelease.Size;
}

export class Updater {
	// The update downloaded but the user chose "when I close it" — applied in applyPendingUpdateOnQuit().
	private updateAwaitingQuit: { manager: UpdateManager; info: UpdateInfo } | null = null;
	// Update.exe already told to watch for our exit — never spawn a second one, they'd race over current/.
	private updateApplyScheduled = false;

	constructor(
		private readonly getWindow: () => BrowserWindow | null,
		private readonly log: LogFn,
		/** Streams download progress so the panel shows the same live in-place byte line as model pulls. */
		private readonly onDownloadProgress: (progress: PullProgress) => void,
	) {}

	/** Launch-time check. Skipped in dev runs — only a packaged build has a version to compare and replace. */
	checkForUpdates(): void {
		if (!app.isPackaged) return;
		void this.runUpdateFlow();
	}

	/** Quit path for "when I close it": tell Update.exe to apply (without relaunching) once we're gone. */
	applyPendingUpdateOnQuit(): void {
		if (!this.updateAwaitingQuit || this.updateApplyScheduled) return;
		this.updateApplyScheduled = true;
		this.updateAwaitingQuit.manager.waitExitThenApplyUpdate(this.updateAwaitingQuit.info, true, false);
	}

	private async runUpdateFlow(): Promise<void> {
		try {
			const updateManager = new UpdateManager(updateSourceLocation());
			const updateInfo = await updateManager.checkForUpdatesAsync();
			if (!updateInfo) return;
			if (!(await this.promptUpdateDownload(updateInfo))) return;
			await this.downloadUpdate(updateManager, updateInfo);
			await this.promptRestartToInstall(updateManager, updateInfo);
		} catch (caughtError) {
			// An unreachable GitHub (offline, rate-limited) is routine — log it and move on; the app runs regardless.
			const failureReason = caughtError instanceof Error ? caughtError.message : String(caughtError);
			this.log('launcher', `Update check failed: ${failureReason}`);
		}
	}

	/** Show what the update contains and ask before downloading — nothing is fetched without a yes. */
	private async promptUpdateDownload(updateInfo: UpdateInfo): Promise<boolean> {
		const panelWindow = this.getWindow();
		if (!panelWindow) return false;
		const newRelease = updateInfo.TargetFullRelease;
		// Notes are baked into the release at pack time (release-notes.md); cap them — a dialog is a summary
		// surface, not a changelog reader.
		const fullReleaseNotes = (newRelease.NotesMarkdown ?? '').trim();
		const releaseNotesText = (fullReleaseNotes.length > 1200 ? `${fullReleaseNotes.slice(0, 1200)}…` : fullReleaseNotes)
			|| 'No release notes were provided for this version.';
		const downloadSizeText = `${Math.max(1, Math.round(expectedDownloadBytes(updateInfo) / 1_000_000))} MB`;
		const { response } = await dialog.showMessageBox(panelWindow, {
			type: 'info',
			title: 'Update available',
			message: `Version ${newRelease.Version} is available.`,
			detail: `Changelog:\n${releaseNotesText}\n\nDownload size: ${downloadSizeText}.`,
			buttons: ['Download', 'Not now'],
			defaultId: 0,
			cancelId: 1,
		});
		if (response !== 0) {
			this.log('launcher', `Update to v${newRelease.Version} skipped, you'll be asked again the next time the launcher starts.`);
			return false;
		}
		return true;
	}

	/** Download (delta when possible), streamed to the panel's live line — the same one model pulls use. */
	private async downloadUpdate(updateManager: UpdateManager, updateInfo: UpdateInfo): Promise<void> {
		const newVersion = updateInfo.TargetFullRelease.Version;
		const downloadLabel = `Update v${newVersion}`;
		// Velopack reports percent only; scale it onto the expected byte count so the line can show bytes.
		const totalBytes = expectedDownloadBytes(updateInfo);
		// Terminal-only records: the panel renders this download on its own live line (log.ts's convention).
		logToTerminal('launcher', `Downloading update v${newVersion}…`);
		try {
			await updateManager.downloadUpdateAsync(updateInfo, (downloadPercent) => {
				this.onDownloadProgress({
					modelName: downloadLabel,
					status: '',
					completed: Math.round(totalBytes * (downloadPercent / 100)),
					total: totalBytes,
					done: false,
					cancellable: false,   // Velopack's download has no abort path, unlike a model pull
				});
			});
		} catch (caughtError) {
			this.onDownloadProgress({ modelName: downloadLabel, status: 'error: download failed', completed: 0, total: 0, done: true });
			throw caughtError;   // runUpdateFlow logs the reason
		}
		this.onDownloadProgress({ modelName: downloadLabel, status: 'success', completed: totalBytes, total: totalBytes, done: true });
		logToTerminal('launcher', `Update v${newVersion} downloaded.`);
	}

	/** The update is on disk — offer an immediate restart, or leave it to install when the launcher closes. */
	private async promptRestartToInstall(updateManager: UpdateManager, updateInfo: UpdateInfo): Promise<void> {
		const panelWindow = this.getWindow();
		if (!panelWindow) return;
		const newVersion = updateInfo.TargetFullRelease.Version;
		const { response } = await dialog.showMessageBox(panelWindow, {
			type: 'info',
			title: 'Update ready',
			message: `Job Tracker ${newVersion} is ready to install.`,
			detail: 'Restart now or install at exit.',
			buttons: ['Restart now', 'Later'],
			defaultId: 0,
			cancelId: 1,
		});
		if (response === 0) {
			// Update.exe now waits for this process to exit, then swaps current/ and relaunches. Closing the
			// window goes through the normal close path, so the sync guard still gets its say — if the user
			// declines there, Update.exe times out after ~60s and the downloaded update applies on next launch.
			this.updateApplyScheduled = true;
			updateManager.waitExitThenApplyUpdate(updateInfo, false, true);
			panelWindow.close();
		} else {
			this.updateAwaitingQuit = { manager: updateManager, info: updateInfo };
			this.log('launcher', `Update v${newVersion} installs when you close the launcher.`);
		}
	}
}
