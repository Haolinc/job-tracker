# Asks whether to also delete the app's user data (database, settings, logs) after an uninstall.
# Launched through WMI by the uninstall hook (desktop/src/updater.ts) from a copy in %TEMP%: the hook
# process is killed 30s after it fires, and the install folder (including this script's shipped copy)
# is deleted by the uninstaller — a user reading the question must outlive both.
param([Parameter(Mandatory = $true)][string]$DataDirectory)

Add-Type -AssemblyName System.Windows.Forms
# An invisible topmost owner so the question surfaces above the uninstaller instead of behind it.
$topmostOwner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$choice = [System.Windows.Forms.MessageBox]::Show($topmostOwner,
	"Job Tracker has been uninstalled.`n`nAlso delete its data (job application database, settings, logs)?`n`n$DataDirectory",
	'Job Tracker uninstall',
	[System.Windows.Forms.MessageBoxButtons]::YesNo,
	[System.Windows.Forms.MessageBoxIcon]::Question,
	[System.Windows.Forms.MessageBoxDefaultButton]::Button2)
if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
	Remove-Item -LiteralPath $DataDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
# Leave no trace of the prompt itself either.
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
