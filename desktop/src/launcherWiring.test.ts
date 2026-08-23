import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Static wiring checks across the launcher's three string-matched seams. Nothing here needs a DOM or an
// Electron runtime; these are the connections the COMPILER cannot see, because each side is a string literal
// in a different file:
//
//   1. control.ts looks up elements by id. `getElementById('x') as HTMLButtonElement` type-asserts away the
//      null, so a missing id is not a compile error — it is `null` at runtime, and the next `.addEventListener`
//      throws. control.ts is one classic script, so that single throw kills EVERY button in the launcher, not
//      just the broken one.
//   2. preload.ts sends on a channel name that main.ts must handle. A typo on either side is silent: the
//      button does nothing at all, with no error anywhere.
//   3. main.ts pushes to the panel on channels preload.ts must be listening on, same silence in reverse.

// Paths resolve from the repo root, where `npm test` runs vitest. Deliberately NOT `import.meta.url`: these
// files build to CommonJS, where that meta-property is a compile error. The existence check turns a wrong
// working directory into this message rather than an empty string that silently passes every regex below.
function read(pathFromRepoRoot: string): string {
	const fullPath = path.join(process.cwd(), pathFromRepoRoot);
	if (!existsSync(fullPath)) {
		throw new Error(`Could not find ${pathFromRepoRoot} under ${process.cwd()} — run the tests from the repo root.`);
	}
	return readFileSync(fullPath, 'utf8');
}

const controlHtml = read('desktop/control.html');
const controlScript = read('desktop/src/control.ts');
const preloadScript = read('desktop/src/preload.ts');
const mainScript = read('desktop/src/main.ts');

/** Every capture of `pattern`'s first group, deduplicated. */
function captureAll(source: string, pattern: RegExp): string[] {
	return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
}

describe('control panel element ids', () => {
	const idsLookedUp = captureAll(controlScript, /getElementById\(['"]([^'"]+)['"]\)/g);
	const idsDefined = new Set(captureAll(controlHtml, /\sid=["']([^"']+)["']/g));

	it('finds ids to check (guards against the regexes silently matching nothing)', () => {
		expect(idsLookedUp.length).toBeGreaterThan(10);
		expect(idsDefined.size).toBeGreaterThan(10);
	});

	it.each(idsLookedUp)('control.html defines #%s', (elementId) => {
		expect(idsDefined.has(elementId)).toBe(true);
	});

	// The one this change adds. Named explicitly so deleting the markup fails a test that says why.
	it('defines the setup guide button that opens the Google Cloud walkthrough', () => {
		expect(idsDefined.has('setup-guide-button')).toBe(true);
		expect(controlScript).toContain('launcher.openSetupGuide()');
	});
});

describe('IPC channels', () => {
	// Renderer to main: preload sends or invokes, main must be listening.
	const channelsSentByPreload = captureAll(preloadScript, /ipcRenderer\.(?:send|invoke)\('([^']+)'/g);
	const channelsHandledByMain = new Set(captureAll(mainScript, /ipcMain\.(?:on|handle)\('([^']+)'/g));

	// Main to renderer: main pushes, preload must be subscribed.
	const channelsPushedByMain = captureAll(mainScript, /webContents\.send\('([^']+)'/g);
	const channelsListenedByPreload = new Set(captureAll(preloadScript, /ipcRenderer\.on\('([^']+)'/g));

	it('finds channels to check (guards against the regexes silently matching nothing)', () => {
		expect(channelsSentByPreload.length).toBeGreaterThan(5);
		expect(channelsPushedByMain.length).toBeGreaterThan(2);
	});

	it.each(channelsSentByPreload)('main.ts handles %s', (channel) => {
		expect(channelsHandledByMain.has(channel)).toBe(true);
	});

	it.each(channelsPushedByMain)('preload.ts listens on %s', (channel) => {
		expect(channelsListenedByPreload.has(channel)).toBe(true);
	});

	it('wires the setup guide channel end to end', () => {
		expect(channelsSentByPreload).toContain('launcher:open-setup-guide');
		expect(channelsHandledByMain.has('launcher:open-setup-guide')).toBe(true);
		expect(mainScript).toContain('const SETUP_GUIDE_URL');
	});
});

describe('setup guide link', () => {
	it('points at the guide repo the README sends people to', () => {
		const guideUrl = /const SETUP_GUIDE_URL = '([^']+)'/.exec(mainScript)?.[1];
		expect(guideUrl).toBe('https://github.com/Haolinc/job-tracker-gmail-setup');
		expect(read('README.md')).toContain(guideUrl!);
	});

	it('opens the guide in the default browser, never inside the launcher window', () => {
		expect(mainScript).toMatch(/shell\.openExternal\(SETUP_GUIDE_URL\)/);
		// loadURL would navigate the launcher itself to GitHub, replacing the control panel with a web page
		// and stranding the user with no way back.
		expect(mainScript).not.toMatch(/loadURL\([^)]*SETUP_GUIDE_URL/);
	});
});
