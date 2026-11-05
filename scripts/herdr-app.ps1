# Runs Ovis on the Herdr app's core (OVIS_RUNTIME=herdr-core) on Windows, where no herdr TUI starts
# it as a plugin: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\herdr-app.ps1 <command>
#   start [-WaitCore]          install packages if there are none and build the client if it is not of
#                              this commit, wait for the Herdr app's core (60 s, or as long as it takes
#                              with -WaitCore), then start Ovis in the background
#   stop | status | pair       as scripts/plugin.ts does them
#   restart                    stop, then start
#   logs [-Follow]             the server's log
#   autostart on|off|status    start Ovis at sign-in, once the Herdr app runs
param(
    [ValidateSet('start', 'stop', 'restart', 'status', 'pair', 'logs', 'autostart')]
    [string]$Command = 'status',
    [ValidateSet('on', 'off', 'status')]
    [string]$Mode = 'status',
    [switch]$WaitCore,
    [switch]$Follow
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$self = $PSCommandPath
$plugin = Join-Path $PSScriptRoot 'plugin.ts'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
# not 'Ovis', the value of Ovis for Windows (app/windows), which runs the herdr TUI's plugin
$runName = 'Ovis (Herdr app)'

function Add-Native {
    if ('Ovis.HerdrApp' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace Ovis {
    public static class HerdrApp {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct FindData {
            public uint Attributes, CreatedLow, CreatedHigh, AccessedLow, AccessedHigh, WrittenLow, WrittenHigh;
            public uint SizeHigh, SizeLow, Reserved0, Reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string ShortName;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct StartupInfo {
            public int Size; public string Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr FindFirstFile(string pattern, out FindData data);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool FindNextFile(IntPtr find, out FindData data);
        [DllImport("kernel32.dll")]
        static extern bool FindClose(IntPtr find);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
            ref StartupInfo startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(IntPtr process, out int code);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);
        // Whether \\.\pipe\ lists this pipe name. The listing opens no connection to any pipe.
        // Directory.GetFiles lists it too, but throws at any pipe whose name a path cannot hold.
        public static bool PipeListed(string name) {
            FindData data;
            IntPtr find = FindFirstFile(@"\\.\pipe\*", out data);
            if (find == new IntPtr(-1)) return false;
            try {
                do { if (string.Equals(data.Name, name, StringComparison.OrdinalIgnoreCase)) return true; }
                while (FindNextFile(find, out data));
                return false;
            } finally { FindClose(find); }
        }
        // Runs a program with no window and returns its exit code. With breakaway it leaves the
        // caller's job; a job that does not allow it fails the start with error 5.
        public static int Run(string application, string arguments, string directory, bool breakaway) {
            StartupInfo startup = new StartupInfo();
            startup.Size = Marshal.SizeOf(typeof(StartupInfo));
            ProcessInfo info;
            // CREATE_NO_WINDOW, and CREATE_BREAKAWAY_FROM_JOB
            uint flags = 0x08000000u | (breakaway ? 0x01000000u : 0u);
            if (!CreateProcess(application, new StringBuilder("\"" + application + "\" " + arguments), IntPtr.Zero,
                IntPtr.Zero, false, flags, IntPtr.Zero, directory, ref startup, out info)) throw new Win32Exception();
            CloseHandle(info.Thread);
            try {
                WaitForSingleObject(info.Process, 0xFFFFFFFF);
                int code;
                if (!GetExitCodeProcess(info.Process, out code)) throw new Win32Exception();
                return code;
            } finally { CloseHandle(info.Process); }
        }
    }
}
'@
}

# The pipe the Herdr app's core listens on, named as hc names it (herdr-core paths.rs and
# platform/windows.rs): HC_SOCKET, else herdr-core-<USERNAME's ASCII letters and digits>-<HC_SESSION
# or default>.sock. A socket set in hc's config.toml is not read: set HC_SOCKET to the same.
function Get-CorePipe {
    if ($env:HC_SOCKET) { return $env:HC_SOCKET -replace '^\\\\\.\\pipe\\', '' }
    $session = "$env:HC_SESSION".Trim()
    if (-not $session) { $session = 'default' }
    'herdr-core-{0}-{1}.sock' -f ($env:USERNAME -creplace '[^A-Za-z0-9]', ''), $session
}

# Whether the pipe came up within $Seconds (-1: waits for as long as it takes).
function Wait-Core([string]$Pipe, [int]$Seconds) {
    Add-Native
    $deadline = if ($Seconds -lt 0) { [datetime]::MaxValue } else { (Get-Date).AddSeconds($Seconds) }
    $said = $false
    while (-not [Ovis.HerdrApp]::PipeListed($Pipe)) {
        if ((Get-Date) -ge $deadline) { return $false }
        if (-not $said) { Write-Host "Ovis: waiting for the Herdr app's core (\\.\pipe\$Pipe)"; $said = $true }
        Start-Sleep -Seconds 2
    }
    $true
}

# The real bun.exe: a .cmd shim cannot be started as a program, and a shim's process would sit
# between this launcher and the server it starts.
function Find-Bun {
    $bun = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $bun) { throw 'Ovis needs Bun 1.4 or newer. Install it from https://bun.sh, then run this again.' }
    if ([IO.Path]::GetExtension($bun.Source) -in '.cmd', '.bat') {
        # Expanded once from the environment, so a literal %NAME% in the path stays as it is.
        $env:OVIS_BUN = $bun.Source
        try { $exe = & $env:ComSpec /d /v:off /s /c '""%OVIS_BUN%" -p process.execPath"' } finally { Remove-Item Env:OVIS_BUN }
    } else {
        $exe = & $bun.Source -p process.execPath
    }
    if ($LASTEXITCODE -ne 0 -or -not $exe) { throw "Could not run $($bun.Source)." }
    $version = "$(& $exe --version)" -replace '-.*$', ''
    if (-not ($version -as [version]) -or [version]$version -lt [version]'1.4.0') {
        throw "Ovis needs Bun 1.4 or newer; this is $version. Update Bun and run this again."
    }
    "$exe"
}

# Bun reads .env from the folder it runs in: always the checkout's, as for the server itself.
function Invoke-Bun([string[]]$Arguments) {
    Push-Location -LiteralPath $root
    try { & $bunExe @Arguments } finally { Pop-Location }
}

# Runs bun with no window and returns its exit code. herdr-core keeps each terminal's processes in a
# job that kills them when the terminal closes, and lets them leave it: the server leaves it.
function Invoke-Detached([string]$Arguments) {
    Add-Native
    try { return [Ovis.HerdrApp]::Run($bunExe, $Arguments, $root, $true) }
    catch { if ($_.Exception.InnerException.NativeErrorCode -ne 5) { throw } } # 5: this job forbids it
    Write-Warning 'Ovis could not be started apart from this terminal, so it stops when this terminal closes. Start it from another terminal, or with autostart, to keep it running.'
    [Ovis.HerdrApp]::Run($bunExe, $Arguments, $root, $false)
}

# Whether the server.pid in this folder names a running process, as scripts/plugin.ts reads it.
function Test-ServerRecorded([string]$Dir) {
    $file = [IO.Path]::Combine($Dir, 'server.pid')
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    $recorded = 0
    [int]::TryParse("$(Get-Content -Raw -LiteralPath $file)".Trim(), [ref]$recorded) -and $recorded -gt 0 -and
        [bool](Get-Process -Id $recorded -ErrorAction SilentlyContinue)
}

# The server's log, in the folder scripts/plugin.ts finds for it (REQUESTED_STATE_DIR and
# runningStateDir there): HERDR_PLUGIN_STATE_DIR; else ~/.local/state/ovis while a server recorded
# there runs or herdr keeps no state folder for the plugin; else that folder of herdr's. Each goes
# by its name from before the rename while only that one is there, and herdr's while a server
# recorded under it runs. The record decides, so a stop changes the answer: ask after it.
function Get-ServerLog {
    $dir = $env:HERDR_PLUGIN_STATE_DIR
    if (-not $dir) {
        $dir = [IO.Path]::Combine($env:USERPROFILE, '.local\state\ovis')
        $old = [IO.Path]::Combine($env:USERPROFILE, '.local\state\herdr-web-ui')
        if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $dir)) { $dir = $old }
        $herdr = if ($null -ne $env:XDG_STATE_HOME) { [IO.Path]::Combine($env:XDG_STATE_HOME, 'herdr') }
            elseif ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'herdr') }
            else { [IO.Path]::Combine($env:USERPROFILE, 'AppData\Local\herdr') }
        $managed = 'devswha.ovis', 'devswha.herdr-web-ui' | ForEach-Object { [IO.Path]::Combine($herdr, 'plugins', $_) } |
            Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($managed -and -not (Test-ServerRecorded $dir)) { $dir = $managed }
    }
    if ((Split-Path -Leaf $dir) -ceq 'devswha.ovis' -and -not (Test-ServerRecorded $dir)) {
        $old = [IO.Path]::Combine((Split-Path -Parent $dir), 'devswha.herdr-web-ui')
        if (Test-ServerRecorded $old) { $dir = $old }
    }
    [IO.Path]::Combine($dir, 'server.log')
}

# The length of the server's log, or -1 while there is none.
function Get-LogLength { if (Test-Path -LiteralPath $log) { (Get-Item -LiteralPath $log).Length } else { -1 } }

function Start-Ovis {
    if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) {
        throw 'Install Git for Windows (https://git-scm.com/download/win), then run this again.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
        Invoke-Bun @('install', '--frozen-lockfile')
        if ($LASTEXITCODE -ne 0) { throw "bun install failed (exit $LASTEXITCODE)." }
    }
    $head = & git -C $root rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw "$root is not a Git checkout: clone Ovis with git and run this from the clone." }
    # vite.config.ts writes the commit a build is from to dist/build.json
    $built = try { (Get-Content -Raw -LiteralPath (Join-Path $root 'dist\build.json') | ConvertFrom-Json).revision } catch { $null }
    if ($built -ne $head) {
        Invoke-Bun @('run', 'build')
        if ($LASTEXITCODE -ne 0) { throw "bun run build failed (exit $LASTEXITCODE)." }
    }
    # Without a core, Ovis's hc would start one of its own, which takes Ovis's environment and is
    # stopped with Ovis. So it waits for the app's, only reading the pipe list: nothing connects.
    $pipe = Get-CorePipe
    $seconds = if ($WaitCore) { -1 } else { 60 }
    if (-not (Wait-Core $pipe $seconds)) {
        throw "The Herdr app's core (\\.\pipe\$pipe) did not start within 60 seconds. Open the Herdr app, then run this again."
    }
    $log = Get-ServerLog
    $logged = Get-LogLength
    $code = Invoke-Detached ('"{0}" start' -f $plugin)
    if ($code -ne 0) {
        # The start ran in a console nobody sees: what it said is in the server's log, unless it
        # stopped before it wrote there (a package a pull added and node_modules lacks, say). The
        # log then ends as the run before it left it, which is not why this one failed. status loads
        # what start does and starts nothing, in this terminal or out of it.
        $length = Get-LogLength
        if ($length -le 0 -or $length -eq $logged) {
            throw "Could not start Ovis (exit $code), and the server's log has nothing new: run bun scripts\plugin.ts status in $root to see whether it loads."
        }
        $tail = (Get-Content -LiteralPath $log -Tail 15) -join "`n"
        throw "Could not start Ovis (exit $code). $log ends with:`n$tail"
    }
    Invoke-Bun @($plugin, 'status')
}

function Set-Autostart([string]$Mode) {
    if ($Mode -eq 'on') {
        # Sign-in opens the launcher's console in the default terminal, Windows Terminal on Windows 11,
        # whose window takes the focus and, told to hide, stays minimized for as long as -WaitCore
        # waits. A headless conhost hosts that console with no window and hands it to no terminal.
        $value = 'conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" start -WaitCore' -f $self
        New-ItemProperty -Path $runKey -Name $runName -Value $value -PropertyType String -Force | Out-Null
    } elseif ($Mode -eq 'off') {
        Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    }
    $value = (Get-ItemProperty -Path $runKey).$runName
    if ($value) { "autostart on: $value" } else { 'autostart off' }
}

if ($MyInvocation.InvocationName -eq '.') { return } # dot-sourced by its test: the functions only

if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }
# A Herdr terminal, or this sign-in, may be older than the Bun or Git install: read PATH as it is now.
$env:PATH = "$env:USERPROFILE\.bun\bin;$([Environment]::GetEnvironmentVariable('Path', 'User'));$([Environment]::GetEnvironmentVariable('Path', 'Machine'));$env:PATH"
# Started from a Herdr terminal, Ovis would otherwise run every hc as that terminal.
Remove-Item Env:HC_TERMINAL_ID, Env:HC_SCOPE, Env:HC_TERMINAL_SOCKET -ErrorAction SilentlyContinue
$env:OVIS_RUNTIME = 'herdr-core'

switch ($Command) {
    'logs' {
        $log = Get-ServerLog
        if (-not (Test-Path -LiteralPath $log)) { "Ovis has no log yet at $log"; exit 0 }
        Get-Content -LiteralPath $log -Tail 40 -Wait:$Follow
        exit 0
    }
    'autostart' { Set-Autostart $Mode; exit 0 }
}
$bunExe = Find-Bun
switch ($Command) {
    'start' { Start-Ovis; exit 0 }
    'restart' {
        Invoke-Bun @($plugin, 'stop')
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Start-Ovis
        exit 0
    }
    default { Invoke-Bun @($plugin, $Command); exit $LASTEXITCODE }
}
