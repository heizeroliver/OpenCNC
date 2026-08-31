$ErrorActionPreference = "Stop"

$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDirectory

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "OpenCNC needs pnpm. Install Node.js and pnpm, then try again."
    Read-Host "Press Enter to close"
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Preparing OpenCNC for first use..."
    pnpm install
}

Add-Type -AssemblyName System.Windows.Forms
$Dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$Dialog.Description = "Choose the parent folder that contains the exported CIX project folders"
$Dialog.ShowNewFolderButton = $false

if ($Dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    exit 0
}

$WorkspaceDirectory = $Dialog.SelectedPath
Write-Host "Watching: $WorkspaceDirectory"
Write-Host "Verified outputs will be written to each project folder's BPP subfolder."
Write-Host "Keep this window open. Press Control-C to stop."
pnpm opencnc watch $WorkspaceDirectory --interval 10
