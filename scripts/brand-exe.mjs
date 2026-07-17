// Stamps the app icon and product metadata onto release/win-unpacked/Job Tracker.exe after
// electron-builder runs. electron-builder would normally do this itself, but its exe editing is
// disabled (signAndEditExecutable: false in electron-builder.yml — enabling it pulls in the
// winCodeSign helper whose macOS symlinks fail to extract on Windows without elevation), so the
// exe would otherwise keep Electron's default icon and "Electron" metadata. The icon on the exe
// is what Explorer, the taskbar, and the Velopack-created shortcuts all display.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rcedit } from 'rcedit';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const appVersion = rootManifest.version;
const executablePath = path.join(repoRoot, 'release', 'win-unpacked', 'Job Tracker.exe');
const appIconPath = path.join(repoRoot, 'build', 'icon.ico');

if (!existsSync(executablePath)) {
	throw new Error(`No unpacked app at ${executablePath} — run electron-builder first (npm run package does).`);
}
if (!existsSync(appIconPath)) {
	throw new Error(`No app icon at ${appIconPath}.`);
}

await rcedit(executablePath, {
	icon: appIconPath,
	'file-version': appVersion,
	'product-version': appVersion,
	'version-string': {
		ProductName: 'Job Tracker',
		FileDescription: 'Job Tracker',
		CompanyName: 'haolin',
		LegalCopyright: `Copyright © ${new Date().getFullYear()} haolin`,
	},
});
console.log(`Branded ${executablePath} with build/icon.ico and Job Tracker v${appVersion} metadata.`);
