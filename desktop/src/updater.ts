// Auto-update via Velopack, with the user in charge of every step: a found update shows its version,
// release notes, and download size and asks before downloading; a finished download asks whether to
// restart now or install on close. Both packaged flavours (installed and portable) go through the same
// mechanism: Update.exe swaps the current/ folder for the new version once the launcher exits.

import { app, dialog, type BrowserWindow } from 'electron';
import { UpdateManager, VelopackApp, type UpdateInfo } from 'velopack';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { errorText, logToTerminal, type LogFn } from './log';
import { isPortableFlavour } from './paths';

/**
 * Velopack's startup hooks: during install/update (and when finishing a pending update) it may restart
 * or exit this process, so the composition root must call this before any other Electron startup work.
 */
export function runVelopackStartupHooks(): void {
	VelopackApp.build()
		.onBeforeUninstallFastCallback(() => offerToDeleteUserDataOnUninstall())
		.run();
}

/**
 * Uninstalling removes the app but never its data (%APPDATA%\Job Tracker: database, .env, logs) — so a
 * reinstall keeps the user's history, but users who want a full cleanup are left with a hidden folder.
 * This asks. The uninstall hook process is killed after 30s, and a user reading a dialog can take longer,
 * so the question is handed to a separate PowerShell prompt that outlives this process and Update.exe.
 */
function offerToDeleteUserDataOnUninstall(): void {
	// Only the installed flavour registers an uninstaller; a portable copy keeps its data inside its own
	// folder, and %APPDATA% belongs to whatever installed copy may also exist — never touch it from here.
	if (isPortableFlavour()) return;
	// Installed but never used (or already cleaned up): no data folder, nothing to ask about.
	const userDataDirectory = app.getPath('userData');
	if (!existsSync(userDataDirectory)) return;
	// Run the prompt from a %TEMP% copy: the shipped script sits in the install folder the uninstaller is
	// about to delete. (This hook only fires in installed builds, so process.resourcesPath is always set.)
	const shippedScriptPath = path.join(process.resourcesPath, 'scripts', 'uninstall-prompt.ps1');
	const temporaryScriptPath = path.join(os.tmpdir(), 'jobtracker-uninstall-prompt.ps1');
	copyFileSync(shippedScriptPath, temporaryScriptPath);
	// Electron puts every child it spawns into a Windows job object that kills them all the moment this
	// process exits — and Velopack exits us right after this hook returns, so even a detached spawn dies
	// before the dialog can render. Brokering the launch through WMI escapes the job: the prompt process
	// is created by the WMI provider service, not by us, so it outlives this process and Update.exe.
	// spawnSync so the broker has finished creating it before Velopack's exit.
	// -ExecutionPolicy Bypass: unlike -Command, -File is subject to the machine's execution policy.
	const promptCommandLine = [
		'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
		'-File', `"${temporaryScriptPath}"`, '-DataDirectory', `"${userDataDirectory}"`,
	].join(' ');
	spawnSync('powershell.exe', [
		'-NoProfile', '-NonInteractive', '-Command',
		'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:JOBTRACKER_PROMPT_COMMAND } | Out-Null',
	], {
		windowsHide: true,
		env: { ...process.env, JOBTRACKER_PROMPT_COMMAND: promptCommandLine },
	});
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

// How long the launch-time update check may take before we give up and start the server anyway. The check hits
// the network (GitHub Releases), and the server start now waits on it — a slow or hung connection (a stalled
// socket, not a clean refusal) must never keep the server down forever. On timeout we treat it as "no update
// this launch", exactly like an unreachable feed. Generous, since a real check is usually well under a second.
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

// Velopack weights a DELTA update's progress callback as 0-70% "download + prepare the delta packages", then a
// silent 70-100% patch-apply that reports nothing. So 70 is where a delta's download is complete — we rescale
// that band to a full 0-100 download bar and treat the rest as the (progress-less) staging phase. Cite:
// velopack lib-rust/src/manager.rs — the download loop sends (i/len)*70, then send(70) before running the patch
// tool as a subprocess, then send(100) after. If Velopack ever reweights this, only this number changes.
const DELTA_DOWNLOAD_PERCENT_CEILING = 70;
// How long Velopack's callback must stay silent (after the download band) before we call it "staging". The delta
// patch tool runs as a subprocess with no callbacks, so a gap this long past the top of the band means it started.
const STAGING_SILENCE_MS = 1500;

export class Updater {
	// The update downloaded but the user chose "when I close it" — applied in applyPendingUpdateOnQuit().
	private updateAwaitingQuit: { manager: UpdateManager; info: UpdateInfo } | null = null;
	// Update.exe already told to watch for our exit — never spawn a second one, they'd race over current/.
	private updateApplyScheduled = false;
	// True from the moment we find an update (while its popup is up) until the app relaunches (or the update is
	// declined / deferred / aborted). The server runs from current\, the exact folder Update.exe swaps, so it
	// must stay stopped meanwhile — main's server-start guard reads this so no manual or auto start brings it up
	// while an update decision is pending or applying.
	private updating = false;

	constructor(
		private readonly getWindow: () => BrowserWindow | null,
		private readonly log: LogFn,
		/** Streams update progress so the panel shows one live line through download → staging → ready. */
		private readonly onUpdateProgress: (progress: UpdateProgress) => void,
		/** Stop the server before the update downloads/installs — a live server locks the current\ swap. */
		private readonly stopServer: () => void,
		/** Start the server: on a normal launch (no update), or once an update is declined / deferred / aborted. */
		private readonly startServer: () => void,
	) {}

	/** Whether an update decision is pending or applying — the server must not (re)start while this is true. */
	get isUpdating(): boolean {
		return this.updating;
	}

	/**
	 * Launch-time entry point. Checks for an update FIRST and starts the server itself, so nothing runs while an
	 * update popup is up — the server starts only once we know no update is applying (dev run, up to date, or the
	 * user declining/deferring). Prevents the server from briefly holding current\ while Update.exe wants to swap it.
	 */
	checkForUpdatesThenStartServer(): void {
		// Dev runs have no version to compare/replace, and no update mechanism — just start the server.
		if (!app.isPackaged) { this.startServer(); return; }
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
			const updateInfo = await this.checkForUpdatesWithinTimeout(updateManager);
			// Up to date (or the check timed out): no update to weigh, so start the server as a normal launch would.
			if (!updateInfo) { this.startServer(); return; }
			// An update exists. Hold the server DOWN from here — while the popup is up and through the decision —
			// so it never spins up into current\, the folder Update.exe swaps. The gate in main reads isUpdating.
			this.updating = true;
			if (!(await this.promptUpdateDownload(updateInfo))) {
				// Declined ("Not now"): no update this session — release the hold and start the server now.
				this.startServerAfterUpdateSettled('Update skipped — starting the server.');
				return;
			}
			// Yes to download: keep the server down (it was never started) and make sure of it — it runs from
			// current\, the exact folder Update.exe swaps, so a live server could block the update.
			this.log('launcher', 'Downloading the update — the server will start after it finishes.');
			this.stopServer();
			await this.downloadUpdate(updateManager, updateInfo);
			await this.promptRestartToInstall(updateManager, updateInfo);
		} catch (caughtError) {
			// An unreachable GitHub (offline, rate-limited) is routine — log it and move on; the app runs regardless.
			this.log('launcher', `Update check failed: ${errorText(caughtError)}`);
			this.startServerAfterUpdateSettled('Update did not complete — starting the server.');
		}
	}

	/**
	 * The update check, but capped at UPDATE_CHECK_TIMEOUT_MS so it can never hold the server start indefinitely.
	 * checkForUpdatesAsync has no abort/timeout of its own, so we race it against a timer: whichever settles first
	 * wins, and a timeout resolves to null ("no update this launch"). If the real check finishes later, its result
	 * is simply dropped — the server is already up, and the user is asked again on the next launch.
	 */
	private async checkForUpdatesWithinTimeout(updateManager: UpdateManager): Promise<UpdateInfo | null> {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timedOut = Symbol('update-check-timed-out');
		const timeoutGuard = new Promise<typeof timedOut>((resolve) => {
			timeoutHandle = setTimeout(() => resolve(timedOut), UPDATE_CHECK_TIMEOUT_MS);
		});
		try {
			const result = await Promise.race([updateManager.checkForUpdatesAsync(), timeoutGuard]);
			if (result === timedOut) {
				this.log('launcher', `Update check timed out after ${UPDATE_CHECK_TIMEOUT_MS / 1000}s — starting the server; you'll be asked again next launch.`);
				return null;
			}
			return result;
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	}

	/** Release the update hold and start the server — used every time an update won't be applied now: up-to-date,
	 *  declined, a download error, or the user deferring to close. A no-op if the hold was already released. */
	private startServerAfterUpdateSettled(reason: string): void {
		if (!this.updating) return;
		this.updating = false;
		this.log('launcher', reason);
		this.startServer();
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

	/**
	 * Download the update, streamed to the panel's live update line. Velopack's single 0-100 progress callback
	 * means two different things depending on the update kind (see velopack lib-rust/src/manager.rs):
	 *   • FULL package (no delta): the callback is a real byte-level 0-100 for the network download, then done.
	 *   • DELTA: the callback covers 0-70 for "download + prepare the delta packages", then Velopack shells out
	 *     to a patch tool that reconstructs the full package and reports NOTHING until it jumps to 100. That
	 *     silent 70→100 tail is what used to leave the bar frozen at ~70%.
	 * So we present two honest phases. The DOWNLOAD gets its own real 0-100 bar (a delta's 0-70 band is rescaled
	 * to fill it, since 70 IS "download complete" for a delta). The opaque patch step has no progress to show, so
	 * we don't invent one — we emit a single 'staging' phase and let the panel animate a "please wait" line. The
	 * actual install (the current\ swap) still happens later, on restart, in waitExitThenApplyUpdate.
	 */
	private async downloadUpdate(updateManager: UpdateManager, updateInfo: UpdateInfo): Promise<void> {
		const version = updateInfo.TargetFullRelease.Version;
		const totalBytes = expectedDownloadBytes(updateInfo);
		// A delta update has the opaque patch-apply tail; a full download reports a clean 0-100 and never stages.
		const isDeltaUpdate = updateInfo.DeltasToTarget.length > 0;
		// Terminal-only record: the panel renders this on its own live line (log.ts's convention).
		logToTerminal('launcher', `Downloading update v${version}…`);

		let lastReportedPercent = 0;
		let lastCallbackAt = Date.now();
		let announcedStaging = false;
		// For a delta, watch for Velopack going silent at the top of its download band (the patch tool is now
		// running): announce staging ONCE so the panel switches to its animated "please wait" line. We report no
		// percent here — Velopack gives none, and inventing one is exactly what we're removing.
		const stagingWatch = isDeltaUpdate ? setInterval(() => {
			if (announcedStaging) return;
			if (Date.now() - lastCallbackAt < STAGING_SILENCE_MS || lastReportedPercent < DELTA_DOWNLOAD_PERCENT_CEILING) return;
			announcedStaging = true;
			logToTerminal('launcher', `Staging update v${version}…`);
			this.onUpdateProgress({ version, phase: 'staging', percent: 100 });
		}, 500) : null;

		try {
			await updateManager.downloadUpdateAsync(updateInfo, (downloadPercent) => {
				lastReportedPercent = Math.min(100, Math.max(0, Math.round(downloadPercent)));
				lastCallbackAt = Date.now();
				// Once staging owns the line, ignore the trailing callbacks (a delta's final jump to 100) — the
				// download bar is already full and the patch step has no meaningful percent.
				if (announcedStaging) return;
				// Rescale a delta's 0-70 download band to a full 0-100 bar; a full download is already 0-100.
				const downloadBarPercent = isDeltaUpdate
					? Math.min(100, Math.round((lastReportedPercent / DELTA_DOWNLOAD_PERCENT_CEILING) * 100))
					: lastReportedPercent;
				this.onUpdateProgress({
					version,
					phase: 'downloading',
					percent: downloadBarPercent,
					bytesCompleted: Math.round(totalBytes * (downloadBarPercent / 100)),
					bytesTotal: totalBytes,
				});
			});
		} catch (caughtError) {
			if (stagingWatch) clearInterval(stagingWatch);
			this.onUpdateProgress({ version, phase: 'error', percent: 0, message: 'download failed' });
			throw caughtError;   // runUpdateFlow logs the reason and brings the server back
		}
		if (stagingWatch) clearInterval(stagingWatch);
		this.onUpdateProgress({ version, phase: 'done', percent: 100 });
		logToTerminal('launcher', `Update v${version} downloaded.`);
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
			// Deferred: the swap happens on close (shutDown stops the server first), so it's safe to start the
			// server now and let the user keep working until they quit.
			this.startServerAfterUpdateSettled(`Update v${newVersion} installs when you close the launcher — starting the server for now.`);
		}
	}
}
