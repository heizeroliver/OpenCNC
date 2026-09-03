param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$editorPath = "C:\Biesse\BiesseWorks\Editor\Editor.exe"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$openedCount = 0
$total = 0
$interFileDelayMilliseconds = 3000

function Write-BridgeStatus {
  param([string]$State, [int]$Current, [string]$FileName = "", [string]$Message = "")
  $value = [ordered]@{
    schemaVersion = 1
    state = $State
    current = $Current
    total = $total
    openedCount = $openedCount
  }
  if ($FileName) { $value.fileName = $FileName }
  if ($Message) { $value.message = $Message }
  $json = $value | ConvertTo-Json -Compress
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    try {
      [System.IO.File]::WriteAllText($ResultPath, $json, $utf8)
      return
    } catch {
      if ($attempt -eq 19) { throw }
      Start-Sleep -Milliseconds 50
    }
  }
}

try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.schemaVersion -ne 1 -or $null -eq $request.outputs) { throw "Invalid OpenCNC BiesseWorks bridge request" }
  $outputs = @($request.outputs)
  $total = $outputs.Count
  if ($total -lt 1) { throw "The BiesseWorks bridge request contains no files" }
  if (-not (Test-Path -LiteralPath $editorPath -PathType Leaf)) { throw "BiesseWorks Editor was not found at $editorPath" }

  foreach ($output in $outputs) {
    if (-not $output.name -or -not $output.path -or $output.path -notlike "*.bpp") { throw "The bridge request contains an invalid BPP path" }
    if (-not (Test-Path -LiteralPath $output.path -PathType Leaf)) { throw "BPP file is missing: $($output.name)" }
    $actual = (Get-FileHash -LiteralPath $output.path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$output.checksum).ToLowerInvariant()) { throw "BPP file changed after OpenCNC verification: $($output.name)" }
  }

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OpenCncBiesseWindows {
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int maximum);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int identifier);
    [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageText(IntPtr window, uint message, IntPtr wParam, string text);
    [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageBuffer(IntPtr window, uint message, IntPtr wParam, StringBuilder text);
    [DllImport("user32.dll", EntryPoint = "SendMessageW")] private static extern IntPtr SendMessageValue(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private static string ClassName(IntPtr window) {
        StringBuilder name = new StringBuilder(64);
        GetClassName(window, name, name.Capacity);
        return name.ToString();
    }

    private static IntPtr FindEditDescendant(IntPtr parent) {
        if (parent == IntPtr.Zero) return IntPtr.Zero;
        if (ClassName(parent) == "Edit") return parent;
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, delegate(IntPtr window, IntPtr parameter) {
            if (ClassName(window) != "Edit") return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    public static bool Activate(IntPtr window) {
        ShowWindow(window, 9);
        return SetForegroundWindow(window);
    }

    public static IntPtr FindMainWindow(int processId) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)processId || !IsWindowVisible(window)) return true;
            if (ClassName(window) == "#32770") return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    public static IntPtr FindFileDialog(int processId) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)processId || !IsWindowVisible(window)) return true;
            if (ClassName(window) != "#32770" || (GetDlgItem(window, 1148) == IntPtr.Zero && GetDlgItem(window, 1152) == IntPtr.Zero)) return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    public static bool SubmitFile(IntPtr dialog, string path) {
        IntPtr fileNameContainer = GetDlgItem(dialog, 1148);
        if (fileNameContainer == IntPtr.Zero) fileNameContainer = GetDlgItem(dialog, 1152);
        IntPtr fileName = FindEditDescendant(fileNameContainer);
        if (fileName == IntPtr.Zero) fileName = fileNameContainer;
        IntPtr openButton = GetDlgItem(dialog, 1);
        if (fileName == IntPtr.Zero || openButton == IntPtr.Zero) return false;
        if (SendMessageText(fileName, 0x000C, IntPtr.Zero, path) == IntPtr.Zero) return false;
        int length = SendMessageValue(fileName, 0x000E, IntPtr.Zero, IntPtr.Zero).ToInt32();
        StringBuilder current = new StringBuilder(Math.Max(length + 1, path.Length + 1));
        SendMessageBuffer(fileName, 0x000D, new IntPtr(current.Capacity), current);
        if (!String.Equals(current.ToString(), path, StringComparison.Ordinal)) return false;
        Activate(dialog);
        return PostMessage(openButton, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    }
}
'@

  function Find-BiesseEditorWindow {
    foreach ($candidate in @(Get-Process -Name "Editor" -ErrorAction SilentlyContinue)) {
      try {
        if (-not $candidate.Path -or -not [StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetFullPath($candidate.Path), $editorPath)) { continue }
        $window = [OpenCncBiesseWindows]::FindMainWindow($candidate.Id)
        if ($window -ne [IntPtr]::Zero) { return [pscustomobject]@{ Process = $candidate; Window = $window } }
      } catch { }
    }
    return $null
  }

  Write-BridgeStatus -State "starting" -Current 0
  $target = Find-BiesseEditorWindow
  if ($null -eq $target) {
    Start-Process -FilePath $editorPath -WorkingDirectory (Split-Path -Parent $editorPath) | Out-Null
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 250
    $target = Find-BiesseEditorWindow
  } while ($null -eq $target -and [DateTime]::UtcNow -lt $deadline)
  if ($null -eq $target) {
    $editorDetails = @(Get-Process -Name "Editor" -ErrorAction SilentlyContinue | ForEach-Object {
      try { "PID=$($_.Id), path=$($_.Path)" } catch { "PID=$($_.Id), path=unavailable" }
    }) -join "; "
    throw "BiesseWorks opened, but OpenCNC could not find its main window within 60 seconds. Editor processes: $editorDetails"
  }

  $automationShell = New-Object -ComObject WScript.Shell
  Start-Sleep -Milliseconds 750
  for ($index = 0; $index -lt $outputs.Count; $index += 1) {
    $output = $outputs[$index]
    Write-BridgeStatus -State "opening" -Current ($index + 1) -FileName ([string]$output.name)
    $target = Find-BiesseEditorWindow
    if ($null -eq $target) { throw "The BiesseWorks Editor window closed before $($output.name) could be opened" }
    [OpenCncBiesseWindows]::Activate($target.Window) | Out-Null
    $automationShell.AppActivate($target.Process.Id) | Out-Null
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("^o")

    $dialog = [IntPtr]::Zero
    $dialogDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 100
      $dialog = [OpenCncBiesseWindows]::FindFileDialog($target.Process.Id)
    } while ($dialog -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $dialogDeadline)
    if ($dialog -eq [IntPtr]::Zero) { throw "BiesseWorks did not open its File > Open dialog for $($output.name)" }
    if (-not [OpenCncBiesseWindows]::SubmitFile($dialog, [string]$output.path)) { throw "OpenCNC could not enter $($output.name) in the BiesseWorks file dialog" }

    $loadDeadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([OpenCncBiesseWindows]::IsWindow($dialog) -and [OpenCncBiesseWindows]::IsWindowVisible($dialog) -and [DateTime]::UtcNow -lt $loadDeadline) { Start-Sleep -Milliseconds 150 }
    if ([OpenCncBiesseWindows]::IsWindow($dialog) -and [OpenCncBiesseWindows]::IsWindowVisible($dialog)) { throw "BiesseWorks did not finish opening $($output.name) within 60 seconds" }
    $openedCount += 1
    if ($index -lt ($outputs.Count - 1)) { Start-Sleep -Milliseconds $interFileDelayMilliseconds }
  }

  Write-BridgeStatus -State "completed" -Current $total -Message "$openedCount BPP file(s) opened in BiesseWorks"
  exit 0
} catch {
  try { Write-BridgeStatus -State "failed" -Current $openedCount -Message $_.Exception.Message } catch { }
  exit 1
}
