// Turns electron-builder's unpacked output (release/win-unpacked) into Velopack release artifacts:
// Setup.exe (installer), JobTracker-win-Portable.zip (self-updating portable, seeded with the full
// package so even its first update is a delta), full + delta .nupkg packages, and the
// releases.win.json feed the packaged app's UpdateManager reads.
//
//   node scripts/velopack-release.mjs            pack only (artifacts land in release/velopack)
//   node scripts/velopack-release.mjs --upload   pack, then upload to a GitHub release DRAFT — publish it
//                                                on GitHub after review, exactly like the old flow.
//                                                Needs GH_TOKEN with Contents: Read and write.
//
// Release notes: written to release-notes.md at the repo root BEFORE packing — Velopack bakes them into
// the package, and the launcher's consent dialog shows them. (They can no longer be added to the GitHub
// draft afterwards; the copy inside the package is what users see.)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const appVersion = rootManifest.version;
const repositoryUrl = rootManifest.repository;
const unpackedAppDir = path.join(repoRoot, 'release', 'win-unpacked');
const velopackOutputDir = path.join(repoRoot, 'release', 'velopack');
const releaseNotesPath = path.join(repoRoot, 'release-notes.md');
const appIconPath = path.join(repoRoot, 'build', 'icon.ico');
const shouldUpload = process.argv.includes('--upload');

if (!existsSync(path.join(unpackedAppDir, 'Job Tracker.exe'))) {
	throw new Error(`No unpacked app at ${unpackedAppDir} — run electron-builder first (npm run package does).`);
}

// vpk is a dotnet global tool; the tools dir may not be on PATH in every shell.
const vpkExecutable = ['vpk', path.join(process.env.USERPROFILE ?? '', '.dotnet', 'tools', 'vpk.exe')]
	.find((candidate) => candidate === 'vpk' ? isOnPath('vpk') : existsSync(candidate));
if (!vpkExecutable) {
	throw new Error('vpk not found. Install it with: dotnet tool install -g vpk');
}

function isOnPath(executableName) {
	try {
		execFileSync('where.exe', [executableName], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function runVpk(vpkArguments) {
	console.log(`\n$ vpk ${vpkArguments.join(' ')}`);
	execFileSync(vpkExecutable, vpkArguments, { cwd: repoRoot, stdio: 'inherit' });
}

// Start from a clean output dir every run. Everything in it is derived (previous packages are
// re-downloaded from GitHub below), and leftovers from an earlier run of the SAME version make
// vpk pack refuse with "a release equal or greater already exists".
rmSync(velopackOutputDir, { recursive: true, force: true });

// 1. Fetch the previous release's package so vpk can generate a delta from it. Absent or unreachable
//    releases (first release, offline) just mean this release ships without a delta — not a failure.
//    The token isn't required here, but with it the fetch sees draft releases and skips the low
//    anonymous rate limit.
const downloadArguments = ['download', 'github', '--repoUrl', repositoryUrl, '--outputDir', velopackOutputDir];
if (process.env.GH_TOKEN) downloadArguments.push('--token', process.env.GH_TOKEN);
try {
	runVpk(downloadArguments);
} catch {
	console.warn('Could not fetch the previous release (first release, or GitHub unreachable) — packing without a delta.');
}

// 2. Pack. --packId is the install folder name (%LocalAppData%\JobTracker) — changing it would strand
//    existing installs on the old id, so treat it as permanent.
const packArguments = [
	'pack',
	'--packId', 'JobTracker',
	'--packVersion', appVersion,
	'--packDir', unpackedAppDir,
	'--mainExe', 'Job Tracker.exe',
	'--packTitle', 'Job Tracker',
	'--packAuthors', 'haolin',
	'--outputDir', velopackOutputDir,
];
// Icon for Setup.exe and the Add/Remove Programs entry. The shortcuts and taskbar show the icon stamped
// onto Job Tracker.exe itself (scripts/brand-exe.mjs, run right after electron-builder).
if (existsSync(appIconPath)) {
	packArguments.push('--icon', appIconPath);
} else {
	console.warn(`No app icon at ${appIconPath} — packaging with Velopack's default icon.`);
}
if (existsSync(releaseNotesPath)) {
	packArguments.push('--releaseNotes', releaseNotesPath);
} else {
	console.warn('No release-notes.md found — the update dialog will show "no release notes" for this version.');
}
try {
	runVpk(packArguments);
} catch (packError) {
	console.error(`\nvpk pack failed for ${appVersion}. If it said a release "equal or greater" already exists,`
		+ ` version ${appVersion} is already on GitHub (drafts count) — bump the version in package.json,`
		+ ' or delete that GitHub release/draft to redo it. Nothing was uploaded.');
	throw packError;
}

// 3. Seed the portable zip with this version's full package. A fresh portable extract has no
//    packages\ folder, and Velopack only offers deltas when the running version's full package is
//    there — without this every portable user's FIRST update is a full download. Doubles the zip
//    size; deliberate trade-off (portable users update eventually anyway). Safe to do after pack:
//    releases.win.json only checksums the .nupkg files, not the zip.
const portableZipPath = path.join(velopackOutputDir, 'JobTracker-win-Portable.zip');
const fullPackageFileName = `JobTracker-${appVersion}-full.nupkg`;
const fullPackagePath = path.join(velopackOutputDir, fullPackageFileName);
if (!existsSync(portableZipPath) || !existsSync(fullPackagePath)) {
	throw new Error(`vpk pack output missing (${portableZipPath} or ${fullPackagePath}) — cannot seed the portable zip.`);
}
console.log(`\nSeeding portable zip with packages/${fullPackageFileName} so its first update can be a delta...`);
// The nupkg is already compressed, so store it uncompressed inside the zip (faster, same size).
execFileSync('powershell.exe', ['-NoProfile', '-Command', `
	Add-Type -AssemblyName System.IO.Compression.FileSystem
	$zipArchive = [System.IO.Compression.ZipFile]::Open($env:SEED_ZIP_PATH, 'Update')
	try {
		[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
			$zipArchive, $env:SEED_PACKAGE_PATH, $env:SEED_ENTRY_NAME,
			[System.IO.Compression.CompressionLevel]::NoCompression) | Out-Null
	} finally {
		$zipArchive.Dispose()
	}
`], {
	stdio: 'inherit',
	env: {
		...process.env,
		SEED_ZIP_PATH: portableZipPath,
		SEED_PACKAGE_PATH: fullPackagePath,
		SEED_ENTRY_NAME: `packages/${fullPackageFileName}`,
	},
});

// 4. Upload as a DRAFT GitHub release (vpk creates the tag/release and attaches all assets + the feed).
if (shouldUpload) {
	const githubToken = process.env.GH_TOKEN;
	if (!githubToken) throw new Error('GH_TOKEN is not set — needed to upload the release.');
	runVpk([
		'upload', 'github',
		'--repoUrl', repositoryUrl,
		'--token', githubToken,
		'--outputDir', velopackOutputDir,
		'--tag', `v${appVersion}`,
		'--releaseName', `Job Tracker ${appVersion}`,
	]);
	console.log(`\nUploaded draft release v${appVersion} — review and publish it on GitHub to ship.`);
} else {
	console.log(`\nPacked v${appVersion} into ${velopackOutputDir} (no upload — pass --upload to create the GitHub draft).`);
}
