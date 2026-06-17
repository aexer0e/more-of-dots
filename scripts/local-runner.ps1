[CmdletBinding(DefaultParameterSetName = 'Default')]
param(
    [switch]$Smoke,
    [switch]$LaunchSmoke,
    [switch]$OpenReplaySmoke,
    [switch]$CaptureReplay,
    [switch]$GamePythonCapture,
    [switch]$CaptureLiveReplay,
    [switch]$ProbeReplayState,
    [switch]$SampleLiveState,
    [switch]$Calibrate,
    [switch]$PythonProbe,
    [switch]$AllowInteractiveInput,
    [string]$JobId,
    [int]$SampleHz = 10,
    [int]$MaxSeconds = 1800,
    [string]$ShareRoot = '',
    [string]$GameWindowTitle = 'War of Dots',
    [ValidateSet('automation-desktop', 'current-desktop')]
    [string]$DesktopStrategy = 'automation-desktop',
    [ValidateSet('offscreen', 'minimize', 'hide', 'none')]
    [string]$WindowStrategy = 'offscreen'
)

$ErrorActionPreference = 'Stop'
if (-not $ShareRoot) {
    $scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $ShareRoot = Join-Path (Resolve-Path (Join-Path $scriptRoot '..')).Path 'runtime'
}
$ShareRoot = (Resolve-Path -LiteralPath $ShareRoot).Path

Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDesktopW(string desktop, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(UInt32 access, bool inherit, UInt32 pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr process, IntPtr baseAddress, byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public UInt32 cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public UInt32 dwX;
        public UInt32 dwY;
        public UInt32 dwXSize;
        public UInt32 dwYSize;
        public UInt32 dwXCountChars;
        public UInt32 dwYCountChars;
        public UInt32 dwFillAttribute;
        public UInt32 dwFlags;
        public UInt16 wShowWindow;
        public UInt16 cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public UInt32 dwProcessId;
        public UInt32 dwThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(
        string applicationName,
        string commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        UInt32 creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);
'@

$PROCESS_VM_READ = 0x0010
$PROCESS_QUERY_INFORMATION = 0x0400
$DESKTOP_ALL_ACCESS = 0x01FF
$STARTF_USESHOWWINDOW = 0x00000001
$SW_HIDE = 0
$SW_MINIMIZE = 6
$script:AutomationDesktopHandle = [IntPtr]::Zero

function Write-JsonResult([hashtable]$Data) {
    $Data | ConvertTo-Json -Depth 32 -Compress
}

function Write-JsonFile([string]$Path, $Data) {
    $Data | ConvertTo-Json -Depth 64 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function ConvertTo-JsonBytes($Data) {
    $json = $Data | ConvertTo-Json -Depth 64 -Compress
    return [System.Text.Encoding]::UTF8.GetBytes($json)
}

function Write-GzipJsonFile([string]$Path, $Data) {
    $bytes = ConvertTo-JsonBytes $Data
    $file = [System.IO.File]::Create($Path)
    try {
        $gzip = New-Object System.IO.Compression.GZipStream($file, [System.IO.Compression.CompressionLevel]::Optimal)
        try {
            $gzip.Write($bytes, 0, $bytes.Length)
        } finally {
            $gzip.Dispose()
        }
    } finally {
        $file.Dispose()
    }
}

function Read-JsonFile([string]$Path) {
    Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-GameExe {
    Join-Path $ShareRoot 'staged-game\game.exe'
}

function Get-GameDir {
    Split-Path -Parent (Get-GameExe)
}

function Get-GameProcessIds {
    @(Get-CimInstance Win32_Process -Filter "Name = 'game.exe'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId)
}

function Stop-NewGameProcesses($ExistingProcessIds) {
    $known = @{}
    foreach ($id in @($ExistingProcessIds)) {
        $known[[int]$id] = $true
    }
    foreach ($process in Get-CimInstance Win32_Process -Filter "Name = 'game.exe'" -ErrorAction SilentlyContinue) {
        $processId = [int]$process.ProcessId
        if (-not $known.ContainsKey($processId)) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-JobRoot([string]$Id) {
    if (-not $Id) {
        throw 'JobId is required.'
    }
    Join-Path $ShareRoot "jobs\$Id"
}

function Backup-FileIfExists([string]$Path, [string]$BackupPath) {
    if (Test-Path -LiteralPath $Path) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BackupPath) | Out-Null
        Copy-Item -LiteralPath $Path -Destination $BackupPath -Force
        return $true
    }
    return $false
}

function Restore-FileBackup([string]$Path, [string]$BackupPath, [bool]$HadBackup) {
    if ($HadBackup) {
        Copy-Item -LiteralPath $BackupPath -Destination $Path -Force
    } elseif (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}

function New-AutomationGameConfig($ReplaySlot, $ReplayVersion) {
    return [ordered]@{
        replays = [ordered]@{ saved_replays = @($ReplaySlot) }
        login = [ordered]@{ username = $null; password = $null }
        welcome = $false
        last_support_reminder = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        music_volume = 0.0
        sfx_volume = 0.0
        custom_map = $null
        community_option = 'map_hub'
        skin = $null
        palette = $null
        wallpaper = $null
        shader = $null
        campaign_progress = @()
        campaign_completed = $false
        autoconfirm_orders = $true
        keybinds = [ordered]@{
            withhold_orders = 1073742050
            confirm_orders = 13
            clear_selection = 99
            stop_units = 115
            open_control_panel = 32
            multiselect = 1073742049
            line_formation = 1073742048
        }
        interface_setup = [ordered]@{
            orders = 1
            health = 1
            morale = 1
            flags = 1
            stats = 1
            icons = 1
            produce = 0
            players = 1
            chat = 0
        }
        version = $ReplayVersion
    }
}

function Prepare-ReplaySlot([string]$Id) {
    $jobRoot = Get-JobRoot $Id
    $inputReplay = Join-Path $jobRoot 'input.rep'
    $requestPath = Join-Path $jobRoot 'capture-request.json'
    if (-not (Test-Path -LiteralPath $inputReplay)) {
        throw "Input replay not found: $inputReplay"
    }

    $request = $null
    if (Test-Path -LiteralPath $requestPath) {
        $request = Read-JsonFile $requestPath
    }

    $gameDir = Get-GameDir
    $replaysDir = Join-Path $gameDir 'replays'
    $backupDir = Join-Path $jobRoot 'stage-backup'
    New-Item -ItemType Directory -Force -Path $replaysDir, $backupDir | Out-Null

    $configPath = Join-Path $gameDir 'config.txt'
    $slotPath = Join-Path $replaysDir 'replay1.rep'
    $configBackup = Join-Path $backupDir 'config.txt'
    $slotBackup = Join-Path $backupDir 'replay1.rep'

    $hadConfig = Backup-FileIfExists -Path $configPath -BackupPath $configBackup
    $hadSlot = Backup-FileIfExists -Path $slotPath -BackupPath $slotBackup

    $version = '1.0.0'
    if ($request -and $request.replay_metadata -and $request.replay_metadata.version) {
        $version = [string]$request.replay_metadata.version
    }

    Copy-Item -LiteralPath $inputReplay -Destination $slotPath -Force
    Write-GzipJsonFile -Path $configPath -Data (New-AutomationGameConfig -ReplaySlot 1 -ReplayVersion $version)

    return [ordered]@{
        input_replay = $inputReplay
        staged_replay = $slotPath
        config = $configPath
        config_backup = $configBackup
        replay_backup = $slotBackup
        had_config = $hadConfig
        had_replay = $hadSlot
    }
}

function Restore-ReplaySlot($SlotState) {
    if (-not $SlotState) {
        return
    }
    Restore-FileBackup -Path $SlotState.config -BackupPath $SlotState.config_backup -HadBackup ([bool]$SlotState.had_config)
    Restore-FileBackup -Path $SlotState.staged_replay -BackupPath $SlotState.replay_backup -HadBackup ([bool]$SlotState.had_replay)
}

function Find-GameWindow([int]$ProcessId, [int]$TimeoutSeconds = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $callback = [Win32.Native+EnumProc]{
            param($hWnd, $unused)
            if (-not [Win32.Native]::IsWindowVisible($hWnd)) { return $true }
            $windowPid = [uint32]0
            [void][Win32.Native]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
            if ($windowPid -ne [uint32]$script:TargetPid) { return $true }
            $len = [Win32.Native]::GetWindowTextLengthW($hWnd)
            if ($len -le 0) { return $true }
            $sb = New-Object System.Text.StringBuilder ($len + 1)
            [void][Win32.Native]::GetWindowTextW($hWnd, $sb, $len + 1)
            if ($sb.ToString() -like "*$script:TargetWindowTitle*") {
                $script:FoundWindow = $hWnd
                return $false
            }
            return $true
        }
        $script:TargetPid = $ProcessId
        $script:TargetWindowTitle = $GameWindowTitle
        $script:FoundWindow = [IntPtr]::Zero
        if ($script:AutomationDesktopHandle -ne [IntPtr]::Zero) {
            [void][Win32.Native]::EnumDesktopWindows($script:AutomationDesktopHandle, $callback, [IntPtr]::Zero)
        } else {
            [void][Win32.Native]::EnumWindows($callback, [IntPtr]::Zero)
        }
        if ($script:FoundWindow -ne [IntPtr]::Zero) {
            return $script:FoundWindow
        }
        Start-Sleep -Milliseconds 250
    }
    return [IntPtr]::Zero
}

function Apply-WindowStrategy([IntPtr]$WindowHandle) {
    if ($WindowHandle -eq [IntPtr]::Zero) {
        return
    }
    switch ($WindowStrategy) {
        'offscreen' {
            [void][Win32.Native]::MoveWindow($WindowHandle, -32000, -32000, 1280, 720, $true)
        }
        'minimize' {
            [void][Win32.Native]::ShowWindow($WindowHandle, $SW_MINIMIZE)
        }
        'hide' {
            [void][Win32.Native]::ShowWindow($WindowHandle, $SW_HIDE)
        }
        'none' {}
    }
}

function Open-ReplayWithMouse([System.Diagnostics.Process]$Process) {
    throw 'Interactive mouse/screen replay opening has been removed. Use hidden live Python capture or explicit probe commands instead.'
}

function Assert-ReplayOpeningAllowed {
    if (-not $AllowInteractiveInput) {
        throw 'Replay opening is not enabled because the available opener uses foreground mouse input. Add a noninteractive opener before enabling full capture, or pass -AllowInteractiveInput -DesktopStrategy current-desktop for manual debugging only.'
    }
    if ($DesktopStrategy -ne 'current-desktop') {
        throw 'The current replay opener only works on the current desktop and is intended for manual debugging.'
    }
}

function Start-GameProcess {
    $gameExe = Get-GameExe
    if (-not (Test-Path -LiteralPath $gameExe)) {
        throw "Staged game.exe not found: $gameExe"
    }
    $gameDir = Split-Path -Parent $gameExe
    $script:AutomationDesktopHandle = [IntPtr]::Zero

    if ($DesktopStrategy -eq 'current-desktop') {
        return Start-Process -FilePath $gameExe -WorkingDirectory $gameDir -WindowStyle Minimized -PassThru
    }

    $desktopName = "WodReplayAutomation-$([System.Guid]::NewGuid().ToString('N'))"
    $desktop = [Win32.Native]::CreateDesktopW($desktopName, [IntPtr]::Zero, [IntPtr]::Zero, 0, $DESKTOP_ALL_ACCESS, [IntPtr]::Zero)
    if ($desktop -eq [IntPtr]::Zero) {
        throw 'CreateDesktopW failed for replay automation desktop.'
    }

    $startup = New-Object Win32.Native+STARTUPINFO
    $startup.cb = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32.Native+STARTUPINFO])
    $startup.lpDesktop = $desktopName
    $startup.dwFlags = $STARTF_USESHOWWINDOW
    $startup.wShowWindow = $SW_HIDE
    $processInfo = New-Object Win32.Native+PROCESS_INFORMATION
    $commandLine = '"' + $gameExe + '"'
    $ok = [Win32.Native]::CreateProcessW(
        $gameExe,
        $commandLine,
        [IntPtr]::Zero,
        [IntPtr]::Zero,
        $false,
        0,
        [IntPtr]::Zero,
        $gameDir,
        [ref]$startup,
        [ref]$processInfo
    )
    if (-not $ok) {
        [void][Win32.Native]::CloseDesktop($desktop)
        throw 'CreateProcessW failed for staged game on automation desktop.'
    }
    [void][Win32.Native]::CloseHandle($processInfo.hThread)
    [void][Win32.Native]::CloseHandle($processInfo.hProcess)
    $script:AutomationDesktopHandle = $desktop
    return [System.Diagnostics.Process]::GetProcessById([int]$processInfo.dwProcessId)
}

function Close-AutomationDesktop {
    if ($script:AutomationDesktopHandle -ne [IntPtr]::Zero) {
        [void][Win32.Native]::CloseDesktop($script:AutomationDesktopHandle)
        $script:AutomationDesktopHandle = [IntPtr]::Zero
    }
}

function Test-GameLaunch {
    $process = $null
    try {
        $process = Start-GameProcess
        $hWnd = Find-GameWindow -ProcessId $process.Id -TimeoutSeconds 60
        if ($hWnd -eq [IntPtr]::Zero) {
            throw 'War of Dots window was not found.'
        }
        Apply-WindowStrategy -WindowHandle $hWnd
        Write-JsonResult @{
            ok = $true
            status = 'launched'
            pid = $process.Id
            window_found = $true
            window_strategy = $WindowStrategy
        }
        exit 0
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Close-AutomationDesktop
    }
}

function Test-OpenReplay([string]$Id) {
    Assert-ReplayOpeningAllowed
    $slotState = $null
    $process = $null
    try {
        $slotState = Prepare-ReplaySlot -Id $Id
        $process = Start-GameProcess
        Open-ReplayWithMouse -Process $process
        Write-JsonResult @{
            ok = $true
            status = 'opened_replay'
            pid = $process.Id
            staged_replay = $slotState.staged_replay
            config = $slotState.config
        }
        exit 0
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Close-AutomationDesktop
        Restore-ReplaySlot $slotState
    }
}

function Open-ProcessForRead([int]$ProcessId) {
    $handle = [Win32.Native]::OpenProcess($PROCESS_QUERY_INFORMATION -bor $PROCESS_VM_READ, $false, [uint32]$ProcessId)
    if ($handle -eq [IntPtr]::Zero) {
        throw "OpenProcess failed for PID $ProcessId."
    }
    return $handle
}

function Read-Bytes([IntPtr]$Handle, [Int64]$Address, [int]$Length) {
    $buffer = New-Object byte[] $Length
    $read = [UIntPtr]::Zero
    $ok = [Win32.Native]::ReadProcessMemory($Handle, [IntPtr]$Address, $buffer, [UIntPtr]$Length, [ref]$read)
    if (-not $ok -or $read.ToUInt64() -ne [uint64]$Length) {
        throw ("ReadProcessMemory failed at 0x{0:X}" -f $Address)
    }
    return $buffer
}

function Convert-HexOrNumber($Value) {
    if ($Value -is [int] -or $Value -is [long]) {
        return [int64]$Value
    }
    $s = [string]$Value
    if ($s.StartsWith('0x')) {
        return [Convert]::ToInt64($s.Substring(2), 16)
    }
    return [Convert]::ToInt64($s)
}

function Get-ModuleBase([System.Diagnostics.Process]$Process, [string]$Name) {
    foreach ($module in $Process.Modules) {
        if ($module.ModuleName -ieq $Name) {
            return $module.BaseAddress.ToInt64()
        }
    }
    throw "Module not found in target process: $Name"
}

function Resolve-AddressSpec([System.Diagnostics.Process]$Process, [IntPtr]$Handle, $Spec) {
    if ($Spec.absolute) {
        return Convert-HexOrNumber $Spec.absolute
    }

    $address = 0
    if ($Spec.base_module) {
        $address = (Get-ModuleBase -Process $Process -Name $Spec.base_module) + (Convert-HexOrNumber $Spec.base_offset)
    } elseif ($Spec.base) {
        $address = Convert-HexOrNumber $Spec.base
    } else {
        throw 'Address spec needs absolute, base_module/base_offset, or base.'
    }

    $offsets = @($Spec.offsets)
    if ($offsets.Count -eq 0) {
        return $address
    }

    $ptrSize = [IntPtr]::Size
    for ($i = 0; $i -lt $offsets.Count; $i++) {
        $bytes = Read-Bytes -Handle $Handle -Address $address -Length $ptrSize
        if ($ptrSize -eq 8) {
            $address = [BitConverter]::ToInt64($bytes, 0)
        } else {
            $address = [BitConverter]::ToInt32($bytes, 0)
        }
        $address += (Convert-HexOrNumber $offsets[$i])
    }
    return $address
}

function Read-Value([IntPtr]$Handle, [Int64]$Address, [string]$Type) {
    switch ($Type.ToLowerInvariant()) {
        'int32' { return [BitConverter]::ToInt32((Read-Bytes $Handle $Address 4), 0) }
        'uint32' { return [BitConverter]::ToUInt32((Read-Bytes $Handle $Address 4), 0) }
        'float32' { return [BitConverter]::ToSingle((Read-Bytes $Handle $Address 4), 0) }
        'float64' { return [BitConverter]::ToDouble((Read-Bytes $Handle $Address 8), 0) }
        'byte' { return (Read-Bytes $Handle $Address 1)[0] }
        'bool' { return ((Read-Bytes $Handle $Address 1)[0] -ne 0) }
        default { throw "Unsupported memory field type: $Type" }
    }
}

function Read-Troops([System.Diagnostics.Process]$Process, [IntPtr]$Handle, $Profile) {
    $layout = $Profile.memory.troops
    $base = Resolve-AddressSpec -Process $Process -Handle $Handle -Spec $layout.base
    $stride = [int]$layout.stride
    $maxCount = [int]$layout.max_count
    if ($maxCount -le 0) {
        return @()
    }

    $ownerMap = @{}
    if ($Profile.owner_map) {
        foreach ($property in $Profile.owner_map.PSObject.Properties) {
            $ownerMap[$property.Name] = $property.Value
        }
    }
    $typeMap = @{}
    if ($Profile.type_map) {
        foreach ($property in $Profile.type_map.PSObject.Properties) {
            $typeMap[$property.Name] = $property.Value
        }
    }

    $troops = New-Object System.Collections.Generic.List[object]
    for ($slot = 0; $slot -lt $maxCount; $slot++) {
        $record = $base + ($slot * $stride)
        $fields = @{}
        foreach ($field in $layout.fields.PSObject.Properties) {
            $fieldSpec = $field.Value
            $fieldAddress = $record + (Convert-HexOrNumber $fieldSpec.offset)
            $fields[$field.Name] = Read-Value -Handle $Handle -Address $fieldAddress -Type $fieldSpec.type
        }

        $alive = $true
        if ($fields.ContainsKey('alive')) {
            $alive = [bool]$fields['alive']
        } elseif ($fields.ContainsKey('health')) {
            $alive = [double]$fields['health'] -gt 0
        }
        if (-not $alive -and -not $Profile.include_dead) {
            continue
        }

        $owner = $fields['owner']
        if ($null -ne $owner -and $ownerMap.ContainsKey([string]$owner)) {
            $owner = $ownerMap[[string]$owner]
        }
        $type = $fields['type']
        if ($null -ne $type -and $typeMap.ContainsKey([string]$type)) {
            $type = $typeMap[[string]$type]
        }

        $troops.Add([ordered]@{
            slot = $slot
            owner = $owner
            type = $type
            x = $fields['x']
            y = $fields['y']
            health = $fields['health']
            morale = $fields['morale']
            alive = $alive
        })
    }
    return @($troops)
}

function Read-Tick([System.Diagnostics.Process]$Process, [IntPtr]$Handle, $Profile) {
    if (-not $Profile.memory.tick) {
        return $null
    }
    $address = Resolve-AddressSpec -Process $Process -Handle $Handle -Spec $Profile.memory.tick
    return Read-Value -Handle $Handle -Address $address -Type $Profile.memory.tick.type
}

function Capture-Replay([string]$Id) {
    Assert-ReplayOpeningAllowed
    $jobRoot = Get-JobRoot $Id
    $inputReplay = Join-Path $jobRoot 'input.rep'
    $statsPath = Join-Path $jobRoot 'stats.json'
    $requestPath = Join-Path $jobRoot 'capture-request.json'
    if (-not (Test-Path -LiteralPath $inputReplay)) {
        throw "Input replay not found: $inputReplay"
    }
    if (-not (Test-Path -LiteralPath $requestPath)) {
        throw "Capture request not found: $requestPath"
    }

    $request = Read-JsonFile $requestPath
    $profilePath = Join-Path $ShareRoot ("address-profiles\" + $request.profile.name)
    if (-not (Test-Path -LiteralPath $profilePath)) {
        throw "Address profile not available locally: $profilePath"
    }
    $profile = Read-JsonFile $profilePath
    if (-not $profile.enabled) {
        throw "Address profile is not enabled: $profilePath"
    }

    $mutex = New-Object System.Threading.Mutex($false, 'Global\WodReplayCapture')
    if (-not $mutex.WaitOne([TimeSpan]::FromMinutes(60))) {
        throw 'Timed out waiting for capture lock.'
    }

    $process = $null
    $handle = [IntPtr]::Zero
    $slotState = $null
    try {
        $slotState = Prepare-ReplaySlot -Id $Id
        $process = Start-GameProcess
        Open-ReplayWithMouse -Process $process
        $handle = Open-ProcessForRead -ProcessId $process.Id

        $samples = New-Object System.Collections.Generic.List[object]
        $seenSlots = New-Object System.Collections.Generic.HashSet[int]
        $delayMs = [Math]::Max(20, [int](1000 / [Math]::Max(1, $SampleHz)))
        $deadline = [DateTime]::UtcNow.AddSeconds($MaxSeconds)
        $start = [DateTime]::UtcNow
        $lastTick = $null
        $sampleIndex = 0
        $endTick = $request.replay_metadata.end

        while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
            $tick = Read-Tick -Process $process -Handle $handle -Profile $profile
            if ($null -eq $tick -or $tick -ne $lastTick) {
                $troops = Read-Troops -Process $process -Handle $handle -Profile $profile
                foreach ($troop in $troops) {
                    [void]$seenSlots.Add([int]$troop.slot)
                }
                $elapsed = [int]([DateTime]::UtcNow - $start).TotalMilliseconds
                $samples.Add([ordered]@{
                    sample_index = $sampleIndex
                    timestamp_ms = $elapsed
                    tick = $tick
                    troops = $troops
                })
                $sampleIndex += 1
                $lastTick = $tick
            }
            if ($null -ne $tick -and $null -ne $endTick -and [double]$tick -ge [double]$endTick) {
                break
            }
            Start-Sleep -Milliseconds $delayMs
        }

        $stats = [ordered]@{
            job_id = $Id
            game_version = $request.profile.game_version
            game_exe_hash = $request.profile.game_exe_sha256
            replay_metadata = $request.replay_metadata
            sample_rate_hz = $SampleHz
            samples = @($samples)
            summary = [ordered]@{
                sample_count = $samples.Count
                troop_slots_seen = $seenSlots.Count
                result = $request.replay_metadata.result
                end_tick = $request.replay_metadata.end
            }
        }
        Write-JsonFile -Path $statsPath -Data $stats
        Write-JsonResult @{
            ok = $true
            status = 'captured'
            job_id = $Id
            stats_path = $statsPath
            sample_count = $samples.Count
        }
        exit 0
    } finally {
        if ($handle -ne [IntPtr]::Zero) {
            [void][Win32.Native]::CloseHandle($handle)
        }
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Close-AutomationDesktop
        Restore-ReplaySlot $slotState
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}

function Run-Calibration {
    $gameExe = Get-GameExe
    if (-not (Test-Path -LiteralPath $gameExe)) {
        throw "Staged game.exe not found: $gameExe"
    }
    $hash = Get-Sha256 $gameExe
    $version = (Get-Item -LiteralPath $gameExe).VersionInfo.FileVersion
    $profileDir = Join-Path $ShareRoot 'address-profiles'
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    $templatePath = Join-Path $profileDir ("candidate-$hash.json")
    $reportPath = Join-Path $profileDir ("calibration-report-$hash.json")

    $template = [ordered]@{
        schema_version = 1
        enabled = $false
        game_exe_sha256 = $hash
        game_version = $version
        notes = 'Calibration scaffold created. Fill verified memory addresses and set enabled=true.'
        owner_map = @{ '0' = 'blue'; '1' = 'red'; '2' = 'purple'; '3' = 'orange' }
        type_map = @{ '0' = 'infantry'; '1' = 'tank'; '2' = 'ship'; '3' = 'heavy_ship' }
        memory = @{
            tick = @{ base_module = 'game.exe'; base_offset = '0x0'; offsets = @(); type = 'int32' }
            troops = @{
                base = @{ base_module = 'game.exe'; base_offset = '0x0'; offsets = @() }
                stride = 0
                max_count = 0
                fields = @{
                    owner = @{ offset = 0; type = 'int32' }
                    type = @{ offset = 0; type = 'int32' }
                    x = @{ offset = 0; type = 'float64' }
                    y = @{ offset = 0; type = 'float64' }
                    health = @{ offset = 0; type = 'float64' }
                    morale = @{ offset = 0; type = 'float64' }
                    alive = @{ offset = 0; type = 'bool' }
                }
            }
        }
    }
    Write-JsonFile -Path $templatePath -Data $template
    Write-JsonFile -Path $reportPath -Data ([ordered]@{
        status = 'needs_address_discovery'
        mode = 'local-session'
        game_exe = $gameExe
        game_exe_sha256 = $hash
        game_version = $version
        candidate_profile = $templatePath
        notes = 'Use a debugger/scanner in the logged-in session to fill pointer paths, then set enabled=true.'
    })
    Write-JsonResult @{
        ok = $true
        status = 'needs_address_discovery'
        game_exe_sha256 = $hash
        game_version = $version
        candidate_profile = $templatePath
        report = $reportPath
    }
}

function New-PythonProbePayload([string]$OutputPath) {
    $escapedOutput = $OutputPath.Replace('\', '\\').Replace("'", "\\'")
    return @"
import gc
import inspect
import json
import os
import sys
import traceback
from collections.abc import Mapping

OUT = r'''$escapedOutput'''
KEYWORDS = (
    'battle', 'replay', 'dot', 'dots', 'city', 'cities', 'health', 'morale',
    'production', 'tick', 'game', 'player', 'unit', 'path', 'position'
)

def safe_repr(value, limit=160):
    try:
        text = repr(value)
    except Exception as exc:
        text = '<repr failed: %s>' % exc
    if len(text) > limit:
        return text[:limit] + '...'
    return text

def simple_value(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple, set)):
        return {
            'type': type(value).__name__,
            'len': len(value),
            'sample': [safe_repr(item, 80) for item in list(value)[:5]],
        }
    if isinstance(value, dict):
        return {
            'type': 'dict',
            'len': len(value),
            'keys': [safe_repr(key, 80) for key in list(value.keys())[:20]],
        }
    return {'type': type(value).__name__, 'repr': safe_repr(value, 100)}

def summarize_replay(value):
    if not isinstance(value, dict):
        return simple_value(value)
    tick_keys = []
    for key in value.keys():
        try:
            if str(key).isdigit():
                tick_keys.append(int(key))
        except Exception:
            pass
    tick_keys.sort()
    return {
        'type': 'dict',
        'keys': [safe_repr(key, 80) for key in list(value.keys())[:40]],
        'map': value.get('map'),
        'version': value.get('version'),
        'result': value.get('result'),
        'end': value.get('end'),
        'tick_count': len(tick_keys),
        'first_tick': tick_keys[0] if tick_keys else None,
        'max_tick': tick_keys[-1] if tick_keys else None,
        'player_usernames': value.get('player_usernames'),
    }

def interesting_keys(keys):
    lowered = [str(key).lower() for key in keys]
    return [key for key, low in zip(keys, lowered) if any(word in low for word in KEYWORDS)]

def inspect_object(obj):
    try:
        attrs = vars(obj)
    except Exception:
        return None
    keys = list(attrs.keys())
    hits = interesting_keys(keys)
    if not hits:
        return None
    sample = {}
    for key in hits[:30]:
        try:
            sample[str(key)] = simple_value(attrs[key])
        except Exception as exc:
            sample[str(key)] = '<inspect failed: %s>' % exc
    cls = type(obj)
    return {
        'class': getattr(cls, '__name__', safe_repr(cls, 80)),
        'module': getattr(cls, '__module__', ''),
        'id': hex(id(obj)),
        'attr_count': len(keys),
        'interesting_keys': [str(key) for key in hits],
        'sample': sample,
    }

def describe_global(name, value):
    item = {
        'name': str(name),
        'type': type(value).__name__,
        'module': getattr(type(value), '__module__', ''),
        'repr': safe_repr(value, 180),
    }
    try:
        attrs = vars(value)
    except Exception:
        attrs = None
    if isinstance(attrs, Mapping):
        keys = [str(key) for key in attrs.keys()]
        item['attr_count'] = len(keys)
        item['keys'] = keys[:200]
        hit_keys = interesting_keys(keys)
        if hit_keys:
            item['interesting_keys'] = [str(key) for key in hit_keys[:80]]
        if isinstance(value, type):
            methods = {}
            for key, attr in attrs.items():
                if key.startswith('__') and key.endswith('__'):
                    continue
                if callable(attr):
                    try:
                        signature = str(inspect.signature(attr))
                    except Exception as exc:
                        signature = '<signature failed: %s>' % exc
                    methods[str(key)] = {
                        'repr': safe_repr(attr, 160),
                        'signature': signature,
                    }
            item['methods'] = methods
    return item

try:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    module_names = sorted(sys.modules)
    interesting_modules = [
        name for name in module_names
        if any(word in name.lower() for word in KEYWORDS)
    ]
    objects = []
    for obj in gc.get_objects():
        item = inspect_object(obj)
        if item is not None:
            objects.append(item)
        if len(objects) >= 300:
            break
    main_module = sys.modules.get('__main__')
    main_globals = []
    if main_module is not None:
        for name, value in sorted(vars(main_module).items()):
            if name.startswith('__') and name.endswith('__'):
                continue
            main_globals.append(describe_global(name, value))
    replay_calls = {}
    if main_module is not None and hasattr(main_module, 'replay_manager'):
        manager = getattr(main_module, 'replay_manager')
        calls = [
            ('find_replays', lambda: manager.find_replays()),
            ('load_all_replays', lambda: manager.load_all_replays()),
            ('load_replay_1_int', lambda: manager.load_replay(1)),
            ('load_replay_1_str', lambda: manager.load_replay('1')),
            ('load_replay_replay1', lambda: manager.load_replay('replay1')),
        ]
        for name, func in calls:
            try:
                replay_calls[name] = summarize_replay(func())
            except Exception as exc:
                replay_calls[name] = {'error': repr(exc)}
    payload = {
        'status': 'ok',
        'pid': os.getpid(),
        'executable': sys.executable,
        'version': sys.version,
        'module_count': len(module_names),
        'interesting_modules': interesting_modules[:300],
        'main_globals': main_globals,
        'replay_calls': replay_calls,
        'object_count': len(objects),
        'objects': objects,
    }
except Exception:
    payload = {
        'status': 'failed',
        'traceback': traceback.format_exc(),
    }

with open(OUT, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, indent=2, default=str)
"@
}

function Invoke-PythonRuntimeProbe {
    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $builtDll = Join-Path $root 'tools\python-probe-dll\target\release\wod_python_probe.dll'
    if (-not (Test-Path -LiteralPath $builtDll)) {
        throw "Python probe DLL is not built: $builtDll"
    }

    $probeRoot = Join-Path $ShareRoot 'probes\python-runtime'
    New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
    $probeDll = Join-Path $probeRoot 'wod_python_probe.dll'
    $payloadPath = Join-Path $probeRoot 'wod_python_probe_payload.py'
    $outputPath = Join-Path $probeRoot 'python-runtime-objects.json'
    $statusPath = Join-Path $probeRoot 'wod_python_probe.status.json'
    Remove-Item -LiteralPath $outputPath, $statusPath -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $builtDll -Destination $probeDll -Force
    Set-Content -LiteralPath $payloadPath -Value (New-PythonProbePayload -OutputPath $outputPath) -Encoding UTF8

    $process = $null
    $slotState = $null
    $existingGamePids = Get-GameProcessIds
    try {
        if ($JobId) {
            $slotState = Prepare-ReplaySlot -Id $JobId
        }
        $process = Start-GameProcess
        $hWnd = Find-GameWindow -ProcessId $process.Id -TimeoutSeconds 60
        if ($hWnd -eq [IntPtr]::Zero) {
            throw 'War of Dots window was not found.'
        }
        Apply-WindowStrategy -WindowHandle $hWnd

        $injector = Join-Path $PSScriptRoot 'invoke-python-probe.ps1'
        $injectResult = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $injector `
            -ProcessId $process.Id `
            -ProbeDll $probeDll `
            -TimeoutSeconds 30
        if ($LASTEXITCODE -ne 0) {
            throw "Python probe injector failed with exit code $LASTEXITCODE."
        }

        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ((Test-Path -LiteralPath $outputPath) -or (Test-Path -LiteralPath $statusPath)) {
                break
            }
            Start-Sleep -Milliseconds 250
        }

        $probeStatus = $null
        if (Test-Path -LiteralPath $statusPath) {
            $probeStatus = Read-JsonFile $statusPath
        }
        $outputExists = Test-Path -LiteralPath $outputPath
        $probeOk = $outputExists -and $probeStatus -and $probeStatus.status -eq 'succeeded'

        Write-JsonResult @{
            ok = $probeOk
            status = if ($probeOk) { 'ok' } elseif ($outputExists) { 'output_unread' } else { 'no_output' }
            pid = $process.Id
            output_path = $outputPath
            probe_status = $probeStatus
            inject_result = $injectResult
        }
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Close-AutomationDesktop
        Restore-ReplaySlot $slotState
    }
}

function New-GamePythonCapturePayload([string]$RequestPath, [string]$StatsPath) {
    $escapedRequest = $RequestPath.Replace('\', '\\').Replace("'", "\\'")
    $escapedStats = $StatsPath.Replace('\', '\\').Replace("'", "\\'")
    return @"
import json
import os
import sys
import traceback

REQUEST_PATH = r'''$escapedRequest'''
STATS_PATH = r'''$escapedStats'''

def latest_point(path):
    if not isinstance(path, list) or not path:
        return None, None
    point = path[-1]
    if isinstance(point, (list, tuple)) and len(point) >= 2:
        return float(point[0]), float(point[1])
    if isinstance(point, dict):
        x = point.get('x')
        y = point.get('y')
        return (float(x) if x is not None else None), (float(y) if y is not None else None)
    return None, None

def normalize_path(path):
    if not isinstance(path, list):
        return []
    points = []
    for point in path:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            points.append({'x': float(point[0]), 'y': float(point[1])})
        elif isinstance(point, dict) and 'x' in point and 'y' in point:
            points.append({'x': float(point['x']), 'y': float(point['y'])})
    return points

def troop_from_entry(slot, entry):
    path = []
    x = None
    y = None
    health = None
    morale = None
    alive_override = None
    if entry in (0, None, False):
        alive_override = False
    elif isinstance(entry, dict):
        path = entry.get('path') or entry.get('positions') or []
        x = entry.get('x')
        y = entry.get('y')
        health = entry.get('health')
        morale = entry.get('morale')
        if 'alive' in entry:
            alive_override = bool(entry.get('alive'))
    elif isinstance(entry, list):
        path = entry
    normalized_path = normalize_path(path)
    if x is None or y is None:
        x, y = latest_point(normalized_path)
    alive = alive_override if alive_override is not None else bool(normalized_path)
    return {
        'slot': int(slot),
        'unit_id': str(slot),
        'x': x,
        'y': y,
        'health': health,
        'morale': morale,
        'alive': alive,
        'path': normalized_path,
    }

def build_stats(job_id, request, replay):
    tick_keys = sorted(int(key) for key in replay.keys() if str(key).isdigit())
    samples = []
    seen_slots = set()
    production_events = 0
    for sample_index, tick in enumerate(tick_keys):
        tick_payload = replay.get(str(tick), {})
        troops = []
        events = {}
        if isinstance(tick_payload, dict):
            for key, value in tick_payload.items():
                if str(key).isdigit():
                    troop = troop_from_entry(key, value)
                    troops.append(troop)
                    seen_slots.add(int(key))
                else:
                    events[str(key)] = value
                    if str(key).startswith('production'):
                        production_events += 1
        samples.append({
            'sample_index': sample_index,
            'timestamp_ms': tick,
            'tick': tick,
            'troops': troops,
            'events': events,
        })
    return {
        'job_id': job_id,
        'game_version': replay.get('version'),
        'game_exe_hash': None,
        'source': 'game-python-replay-manager',
        'replay_metadata': request.get('replay_metadata', {}),
        'sample_rate_hz': None,
        'samples': samples,
        'summary': {
            'sample_count': len(samples),
            'troop_slots_seen': len(seen_slots),
            'production_event_count': production_events,
            'result': replay.get('result'),
            'end_tick': replay.get('end'),
        },
    }

try:
    with open(REQUEST_PATH, 'r', encoding='utf-8') as handle:
        request = json.load(handle)
    main = sys.modules.get('__main__')
    if main is None or not hasattr(main, 'replay_manager'):
        raise RuntimeError('__main__.replay_manager is not available')
    replay = main.replay_manager.load_replay('replay1')
    if not isinstance(replay, dict):
        raise RuntimeError("ReplayManager.load_replay('replay1') did not return a replay object")
    stats = build_stats(request.get('job_id'), request, replay)
    os.makedirs(os.path.dirname(STATS_PATH), exist_ok=True)
    with open(STATS_PATH, 'w', encoding='utf-8') as handle:
        json.dump(stats, handle, indent=2, default=str)
except Exception:
    os.makedirs(os.path.dirname(STATS_PATH), exist_ok=True)
    with open(STATS_PATH + '.error.txt', 'w', encoding='utf-8') as handle:
        handle.write(traceback.format_exc())
    raise
"@
}

function New-LiveGameCapturePayload([string]$RequestPath, [string]$StatsPath, [string]$ArtifactPath, [string]$Mode, [int]$SampleHz, [int]$MaxSamples) {
    $escapedRequest = $RequestPath.Replace('\', '\\').Replace("'", "\\'")
    $escapedStats = $StatsPath.Replace('\', '\\').Replace("'", "\\'")
    $escapedArtifact = $ArtifactPath.Replace('\', '\\').Replace("'", "\\'")
    $escapedMode = $Mode.Replace("'", "\\'")
    return @"
import gc
import inspect
import json
import os
import sys
import threading
import time
import traceback
from collections.abc import Mapping

REQUEST_PATH = r'''$escapedRequest'''
STATS_PATH = r'''$escapedStats'''
ARTIFACT_PATH = r'''$escapedArtifact'''
MODE = '$escapedMode'
SAMPLE_HZ = $SampleHz
MAX_SAMPLES = $MaxSamples
SOURCE = 'game-live-python'
TRACE_EVENTS = []
PROGRESS_PATH = ARTIFACT_PATH + '.progress.jsonl'
VARIANT_FILTER = set(
    item.strip()
    for item in os.environ.get('WOD_LIVE_CAPTURE_VARIANTS', '').split(',')
    if item.strip()
)
DRIVE_REPLAY_DATA = os.environ.get('WOD_LIVE_CAPTURE_DRIVE_REPLAY', '').strip().lower() in ('1', 'true', 'yes', 'on')
ADVANCE_CANDIDATES_WITH_GAME = os.environ.get('WOD_LIVE_CAPTURE_ADVANCE_CANDIDATES', '').strip().lower() in ('1', 'true', 'yes', 'on')
FULL_GC_DISCOVERY = os.environ.get('WOD_LIVE_CAPTURE_FULL_GC', '').strip().lower() in ('1', 'true', 'yes', 'on')
CAPTURE_UNTIL_END = MODE == 'capture-live-replay' and os.environ.get('WOD_LIVE_CAPTURE_MODE', 'full').strip().lower() not in ('window', 'sample', 'samples', 'fixed')
try:
    TARGET_SIM_SPEED = max(1.0, min(240.0, float(os.environ.get('WOD_LIVE_SIM_SPEED', '20'))))
except Exception:
    TARGET_SIM_SPEED = 20.0
try:
    SIM_UPDATE_BURST = int(os.environ.get('WOD_LIVE_SIM_UPDATE_BURST', ''))
except Exception:
    SIM_UPDATE_BURST = max(0, min(500, int(((TARGET_SIM_SPEED - 1.0) * 30.0) / max(1, int(SAMPLE_HZ)))))
FAST_FORWARD_CORE = os.environ.get('WOD_LIVE_FAST_FORWARD_CORE', '1').strip().lower() not in ('0', 'false', 'no', 'off')
FAST_FORWARD_CONTROLLER = os.environ.get('WOD_LIVE_FAST_FORWARD_CONTROLLER', '1').strip().lower() not in ('0', 'false', 'no', 'off')
FAST_FORWARD_STEP_METHOD = os.environ.get('WOD_LIVE_FAST_FORWARD_STEP_METHOD', 'game-update').strip().lower()
try:
    FAST_FORWARD_FRAMES_PER_SAMPLE = int(os.environ.get('WOD_LIVE_FAST_FORWARD_FRAMES', ''))
except Exception:
    FAST_FORWARD_FRAMES_PER_SAMPLE = max(0, min(2000, int((TARGET_SIM_SPEED * 30.0) / max(1, int(SAMPLE_HZ)))))
REPLAY_PAYLOAD_CACHE = None
REPLAY_PAYLOAD_CURSOR = 0

KEYWORDS = (
    'battle', 'replay', 'dot', 'dots', 'city', 'cities', 'health', 'morale',
    'production', 'tick', 'frame', 'game', 'player', 'unit', 'path', 'position',
    'owner', 'team', 'alive'
)
TARGET_GLOBALS = (
    'PlayScene', 'ReplayConnection', 'ReplayManager', 'SceneManager',
    'HomeScene', 'Dot', 'Bot', 'LocalConnection', 'NetworkConnection',
    'IdleConnection', 'aaaaac', 'aaaaad', 'aaadaa', 'scene_manager',
    'replay_manager', 'config_manager', 'map_manager', 'opengl_manager',
    'sound_manager',
)
TARGET_CLASSES = set(
    'PlayScene ReplayConnection ReplayManager SceneManager HomeScene Dot Bot '
    'LocalConnection NetworkConnection IdleConnection aaaaac aaaaad aaadaa'
    .split()
)

def safe_repr(value, limit=180):
    try:
        text = repr(value)
    except Exception as exc:
        text = '<repr failed: %s>' % exc
    return text[:limit] + '...' if len(text) > limit else text

def jsonable(value, limit=8):
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) <= 240:
            return value
        return {'type': 'str', 'len': len(value), 'preview': value[:200] + '...'}
    if isinstance(value, Mapping):
        items = {}
        for key in list(value.keys())[:limit]:
            try:
                child = value.get(key)
            except Exception:
                continue
            if child is None or isinstance(child, (bool, int, float, str, Mapping, list, tuple, set)):
                items[str(key)] = jsonable(child, limit=4)
            else:
                items[str(key)] = safe_repr(child, 100)
        return {
            'type': 'dict',
            'len': len(value),
            'keys': [safe_repr(key, 80) for key in list(value.keys())[:limit]],
            'items': items,
        }
    if isinstance(value, (list, tuple, set)):
        return {
            'type': type(value).__name__,
            'len': len(value),
            'sample': [safe_repr(item, 80) for item in list(value)[:limit]],
        }
    return {'type': type(value).__name__, 'repr': safe_repr(value, 120)}

def attrs_of(obj):
    try:
        attrs = vars(obj)
    except Exception:
        return {}
    return attrs if isinstance(attrs, Mapping) else {}

def trace_value(value, limit=8):
    if value is None or isinstance(value, (bool, int, float, str, Mapping, list, tuple, set)):
        return jsonable(value, limit=limit)
    attrs = attrs_of(value)
    if attrs:
        sample = {}
        interesting = []
        for key in list(attrs.keys())[:80]:
            low = str(key).lower()
            if any(word in low for word in KEYWORDS) or low in (
                'game', 'core', 'connection', 'replay_file', 'custom_map', 'change_scene',
                'tick', 'frame', 'mode', 'result', 'players', 'player_usernames'
            ):
                interesting.append(str(key))
        for key in interesting[:limit]:
            try:
                sample[key] = jsonable(attrs.get(key), limit=4)
            except Exception as exc:
                sample[key] = '<failed: %s>' % exc
        return {
            'type': type(value).__name__,
            'id': hex(id(value)),
            'keys': [str(key) for key in list(attrs.keys())[:limit]],
            'sample': sample,
        }
    return jsonable(value, limit=limit)

def callable_no_args(method):
    if not callable(method):
        return False
    try:
        signature = inspect.signature(method)
    except Exception:
        return True
    required = [
        param for param in signature.parameters.values()
        if param.default is inspect._empty
        and param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD, param.KEYWORD_ONLY)
    ]
    return len(required) == 0

def callable_signature(method):
    if not callable(method):
        return None
    try:
        return str(inspect.signature(method))
    except Exception as exc:
        return '<signature failed: %s>' % exc

def summarize_callable(method):
    out = {
        'repr': safe_repr(method, 160),
        'signature': callable_signature(method),
    }
    for attr in ('__text_signature__', '__defaults__', '__kwdefaults__'):
        try:
            value = getattr(method, attr, None)
        except Exception:
            value = None
        if value is not None:
            out[attr] = safe_repr(value, 160)
    return out

def trace_obj(obj):
    attrs = attrs_of(obj)
    sample = {}
    for key in (
        'scene_name', 'change_scene', 'game_mode', 'game_setup', 'frame', 'room_code',
        'ready', 'authorized', 'access', 'game', 'core', 'connection', 'replay_file',
        'custom_map', 'mode', 'result'
    ):
        if key in attrs:
            try:
                sample[key] = trace_value(attrs.get(key), limit=12)
            except Exception as exc:
                sample[key] = '<failed: %s>' % exc
    return {
        'class': getattr(type(obj), '__name__', safe_repr(type(obj), 60)),
        'id': hex(id(obj)),
        'keys': [str(key) for key in list(attrs.keys())[:30]],
        'sample': sample,
    }

def add_trace(event):
    if len(TRACE_EVENTS) >= 800:
        return
    event['time_ms'] = int(time.time() * 1000)
    TRACE_EVENTS.append(event)

def record_progress(event):
    try:
        event = dict(event)
        event['time_ms'] = int(time.time() * 1000)
        with open(PROGRESS_PATH, 'a', encoding='utf-8') as handle:
            handle.write(json.dumps(event, default=str) + '\n')
    except Exception:
        pass

def call_with_timeout(label, func, timeout_seconds=3.0):
    result = {'status': 'pending'}

    def run():
        try:
            result['value'] = func()
            result['status'] = 'called'
        except Exception as exc:
            result['status'] = 'failed'
            result['error'] = repr(exc)
            result['traceback'] = traceback.format_exc(limit=6)

    thread = threading.Thread(target=run, name='codex-capture-%s' % label, daemon=True)
    thread.start()
    thread.join(timeout_seconds)
    if thread.is_alive():
        return {
            'status': 'timeout',
            'error': 'timed out after %.1fs' % timeout_seconds,
        }
    return result

def write_json_atomic(path, value):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    temp_path = path + '.tmp'
    with open(temp_path, 'w', encoding='utf-8') as handle:
        json.dump(value, handle, indent=2, default=str)
    os.replace(temp_path, path)

def install_trace_hooks(attempts):
    main = sys.modules.get('__main__')
    if main is None:
        return
    targets = (
        ('SceneManager', 'update_scene'),
        ('SceneManager', 'first_scene'),
        ('HomeScene', 'update'),
        ('PlayScene', 'start_game'),
        ('PlayScene', 'update'),
        ('ReplayManager', '__init__'),
        ('ReplayManager', 'find_replays'),
        ('ReplayManager', 'load_all_replays'),
        ('ReplayManager', 'load_replay'),
        ('aaadaa', '__init__'),
        ('aaadaa', 'connect'),
        ('aaadaa', 'start_game'),
        ('aaaaac', '__init__'),
        ('ReplayConnection', 'connect'),
        ('ReplayConnection', 'unpack_data'),
    )
    installed = []
    for class_name, method_name in targets:
        cls = getattr(main, class_name, None)
        if cls is None:
            continue
        try:
            original = getattr(cls, method_name)
        except Exception:
            continue
        if getattr(original, '_codex_trace_wrapped', False):
            continue

        def make_wrapper(orig, cls_name, meth_name):
            def wrapper(self, *args, **kwargs):
                main_module = sys.modules.get('__main__')
                if cls_name == 'aaadaa' and main_module is not None:
                    try:
                        setattr(main_module, '_codex_last_game_scene', self)
                    except Exception:
                        pass
                if cls_name == 'aaaaac' and main_module is not None:
                    try:
                        setattr(main_module, '_codex_capture_game', self)
                    except Exception:
                        pass
                add_trace({
                    'phase': 'enter',
                    'class': cls_name,
                    'method': meth_name,
                    'self': trace_obj(self),
                    'args': [trace_value(arg, 12) for arg in args[:4]],
                    'kwargs': trace_value(kwargs, 12) if kwargs else {},
                })
                try:
                    result = orig(self, *args, **kwargs)
                    add_trace({
                        'phase': 'exit',
                        'class': cls_name,
                        'method': meth_name,
                        'self': trace_obj(self),
                        'result': trace_value(result, 12),
                    })
                    return result
                except Exception as exc:
                    add_trace({
                        'phase': 'error',
                        'class': cls_name,
                        'method': meth_name,
                        'self': trace_obj(self),
                        'error': repr(exc),
                        'traceback': traceback.format_exc(limit=6),
                    })
                    raise
            wrapper._codex_trace_wrapped = True
            wrapper._codex_original = orig
            return wrapper

        try:
            setattr(cls, method_name, make_wrapper(original, class_name, method_name))
            installed.append('%s.%s' % (class_name, method_name))
        except Exception as exc:
            installed.append('%s.%s failed: %s' % (class_name, method_name, exc))
    attempts.append({'method': 'install_trace_hooks', 'status': 'set', 'hooks': installed})

def has_noarg(obj, name):
    try:
        return callable_no_args(getattr(obj, name))
    except Exception:
        return False

def to_float(value):
    try:
        return float(value)
    except Exception:
        return None

def to_int(value):
    number = to_float(value)
    if number is None:
        return None
    return int(number)

def native_value(value):
    try:
        if hasattr(value, 'tolist'):
            return value.tolist()
    except Exception:
        pass
    return value

def number_list(value, limit=32):
    value = native_value(value)
    if isinstance(value, Mapping):
        values = []
        try:
            keys = sorted(value.keys(), key=lambda key: str(key))
        except Exception:
            keys = list(value.keys())
        for key in keys[:limit]:
            try:
                values.append(value.get(key))
            except Exception:
                pass
    elif isinstance(value, (list, tuple, set)):
        values = list(value)[:limit]
    else:
        number = to_float(value)
        return [number] if number is not None else []
    numbers = []
    for item in values:
        number = to_float(native_value(item))
        if number is None:
            numbers.append(None)
        elif abs(number - round(number)) < 0.000001:
            numbers.append(int(round(number)))
        else:
            numbers.append(number)
    return numbers

def to_point(value):
    if value is None:
        return None
    if isinstance(value, Mapping):
        x = to_float(value.get('x'))
        y = to_float(value.get('y'))
        return {'x': x, 'y': y} if x is not None and y is not None else None
    try:
        if len(value) >= 2:
            x = to_float(value[0])
            y = to_float(value[1])
            return {'x': x, 'y': y} if x is not None and y is not None else None
    except Exception:
        pass
    return None

def read_position(obj):
    attrs = attrs_of(obj)
    for key in ('position', 'pos', 'coordinates', 'coord'):
        if key in attrs:
            point = to_point(attrs.get(key))
            if point is not None:
                return point
    x = None
    y = None
    for key in ('x', 'pos_x', 'x_pos', 'world_x'):
        if key in attrs:
            x = to_float(attrs.get(key))
            break
    for key in ('y', 'pos_y', 'y_pos', 'world_y'):
        if key in attrs:
            y = to_float(attrs.get(key))
            break
    if x is not None and y is not None:
        return {'x': x, 'y': y}
    return None

def read_first_attr(attrs, names):
    for name in names:
        if name in attrs:
            value = attrs.get(name)
            if value is not None:
                return value
    return None

COLOR_NAME_HEX = {
    'blue': '#063bff',
    'red': '#ff1616',
    'green': '#1ebd5a',
    'yellow': '#ffdd22',
    'purple': '#7d35ff',
    'orange': '#ff8a1f',
    'cyan': '#19d8ff',
    'pink': '#ff5aa8',
    'black': '#222222',
    'white': '#f4f4f4',
}
FALLBACK_TEAM_HEX = ['#063bff', '#ff1616', '#1ebd5a', '#ffdd22', '#7d35ff', '#ff8a1f', '#19d8ff', '#ff5aa8']

def flatten_player_name(value):
    if isinstance(value, (list, tuple)):
        parts = [flatten_player_name(item) for item in value]
        return ' '.join(part for part in parts if part).strip()
    if value is None:
        return ''
    return str(value).strip()

def color_to_hex(value, index=0):
    if isinstance(value, str):
        text = value.strip().lower()
        if text.startswith('#') and len(text) in (4, 7, 9):
            return text
        if text in COLOR_NAME_HEX:
            return COLOR_NAME_HEX[text]
    return FALLBACK_TEAM_HEX[index % len(FALLBACK_TEAM_HEX)]

def owner_to_index(owner):
    number = to_int(owner)
    if number is not None:
        return number
    if isinstance(owner, str):
        low = owner.strip().lower()
        for index, name in enumerate(('blue', 'red', 'green', 'yellow', 'purple', 'orange', 'cyan', 'pink')):
            if low == name:
                return index
    return None

def read_map_size(game=None, surface=None):
    if game is not None:
        attrs = attrs_of(game)
        size = native_value(attrs.get('map_size'))
        if isinstance(size, Mapping):
            width = to_int(size.get('width') or size.get('w') or size.get('x'))
            height = to_int(size.get('height') or size.get('h') or size.get('y'))
            if width and height:
                return {'width': width, 'height': height}
        if isinstance(size, (list, tuple)) and len(size) >= 2:
            width = to_int(size[0])
            height = to_int(size[1])
            if width and height:
                return {'width': width, 'height': height}
        if surface is None:
            surface = attrs.get('map')
    if surface is not None:
        for width_name, height_name in (('get_width', 'get_height'),):
            try:
                width = to_int(getattr(surface, width_name)())
                height = to_int(getattr(surface, height_name)())
                if width and height:
                    return {'width': width, 'height': height}
            except Exception:
                pass
        try:
            width, height = surface.get_size()
            width = to_int(width)
            height = to_int(height)
            if width and height:
                return {'width': width, 'height': height}
        except Exception:
            pass
    return {'width': 1600, 'height': 900}

def read_team_colors(games, replay):
    for game in games:
        colors = native_value(attrs_of(game).get('zyuixz'))
        if isinstance(colors, (list, tuple)) and colors:
            return [str(color) for color in colors]
    if isinstance(replay, dict):
        colors = replay.get('colors') or replay.get('player_colors')
        if isinstance(colors, (list, tuple)) and colors:
            return [str(color) for color in colors]
    return []

def build_teams(replay, games):
    names = []
    if isinstance(replay, dict):
        raw_names = replay.get('player_usernames') or []
        if isinstance(raw_names, (list, tuple)):
            names = [flatten_player_name(name) for name in raw_names]
    colors = read_team_colors(games, replay)
    team_count = max(2, len(names), len(colors))
    teams = []
    for index in range(team_count):
        color_name = colors[index] if index < len(colors) else None
        teams.append({
            'index': index,
            'name': names[index] if index < len(names) and names[index] else 'Player %s' % (index + 1),
            'color_name': color_name,
            'color_hex': color_to_hex(color_name, index),
        })
    return teams

def summarize_map_payload(payload):
    if not payload:
        return None
    out = dict(payload)
    if out.get('image_data_url'):
        out['image_data_url_bytes'] = len(out.get('image_data_url', ''))
        out.pop('image_data_url', None)
    if out.get('image_png'):
        out['image_png_bytes'] = len(out.get('image_png', ''))
        out.pop('image_png', None)
    return out

def capture_map_image(replay, games, game_scenes):
    primary_game = games[0] if games else None
    surface = attrs_of(primary_game).get('map') if primary_game is not None else None
    map_size = read_map_size(primary_game, surface)
    if isinstance(replay, dict):
        custom_map = replay.get('custom_map')
        if isinstance(custom_map, Mapping):
            map_surface = custom_map.get('map_surface')
            if isinstance(map_surface, str) and map_surface:
                payload = {
                    'source': 'replay-custom-map',
                    'width': map_size['width'],
                    'height': map_size['height'],
                }
                if map_surface.startswith('data:image/'):
                    payload['image_data_url'] = map_surface
                else:
                    payload['image_png'] = map_surface
                return payload
    if surface is not None:
        try:
            import pygame
            map_path = ARTIFACT_PATH + '.map.png'
            pygame.image.save(surface, map_path)
            return {
                'source': 'game-surface',
                'width': map_size['width'],
                'height': map_size['height'],
                'path': map_path,
            }
        except Exception as exc:
            record_progress({'stage': 'map-capture', 'status': 'surface-failed', 'error': repr(exc)})
    for scene in game_scenes:
        scene_custom = attrs_of(scene).get('custom_map')
        if isinstance(scene_custom, Mapping):
            map_surface = scene_custom.get('map_surface')
            if isinstance(map_surface, str) and map_surface:
                payload = {
                    'source': 'scene-custom-map',
                    'width': map_size['width'],
                    'height': map_size['height'],
                }
                if map_surface.startswith('data:image/'):
                    payload['image_data_url'] = map_surface
                else:
                    payload['image_png'] = map_surface
                return payload
    return {
        'source': 'none',
        'width': map_size['width'],
        'height': map_size['height'],
    }

def economy_profile(economy, team_count):
    attrs = attrs_of(economy)
    numeric_fields = {}
    for key, value in list(attrs.items())[:120]:
        numbers = number_list(value, limit=max(team_count, 8))
        if numbers and sum(1 for number in numbers if number is not None) >= min(team_count, len(numbers)):
            numeric_fields[str(key)] = numbers[:max(team_count, 8)]
    return {
        'class': getattr(type(economy), '__name__', None) if economy is not None else None,
        'keys': [str(key) for key in list(attrs.keys())[:80]],
        'numeric_fields': numeric_fields,
    }

def read_funds(economy, team_count):
    attrs = attrs_of(economy)
    preferred = ('funds', 'fund', 'money', 'cash', 'balance', 'balances', 'resources', 'resource', 'gold', 'coins')
    for key in preferred:
        if key in attrs:
            values = number_list(attrs.get(key), limit=team_count)
            if len(values) >= team_count and any(value is not None for value in values):
                return values[:team_count], key
    for key, value in list(attrs.items())[:120]:
        low = str(key).lower()
        if any(word in low for word in preferred):
            values = number_list(value, limit=team_count)
            if len(values) >= team_count and any(item is not None for item in values):
                return values[:team_count], str(key)
    if 'zrtyz' in attrs:
        values = number_list(attrs.get('zrtyz'), limit=team_count)
        if len(values) >= team_count and any(item is not None for item in values):
            return values[:team_count], 'zrtyz'
    return [], None

def build_metrics(games, troops, teams):
    game = games[0] if games else None
    attrs = attrs_of(game) if game is not None else {}
    team_count = max(len(teams), 2)
    for troop in troops:
        owner = owner_to_index(troop.get('owner'))
        if owner is not None:
            team_count = max(team_count, owner + 1)
    strength = number_list(attrs.get('strength'), limit=team_count)
    casualties = number_list(attrs.get('casualties'), limit=team_count)
    troop_casualties = number_list(attrs.get('troop_casualties'), limit=team_count)
    funds, funds_source = read_funds(attrs.get('economy'), team_count)
    teams_out = []
    for index in range(team_count):
        owned = [troop for troop in troops if owner_to_index(troop.get('owner')) == index]
        alive = [troop for troop in owned if troop.get('alive', True)]
        health_values = [to_float(troop.get('health')) for troop in alive]
        health_total = sum(value for value in health_values if value is not None)
        raw_strength = strength[index] if index < len(strength) else None
        raw_casualties = casualties[index] if index < len(casualties) else None
        raw_troop_casualties = troop_casualties[index] if index < len(troop_casualties) else None
        teams_out.append({
            'index': index,
            'alive_units': len(alive),
            'total_units': len(owned),
            'health_total': round(health_total, 2),
            'strength': raw_strength,
            'troops_estimate': int(raw_strength * 100) if isinstance(raw_strength, (int, float)) else len(alive),
            'casualties': raw_casualties,
            'casualties_estimate': int(raw_casualties * 100) if isinstance(raw_casualties, (int, float)) else (
                int(raw_troop_casualties * 100) if isinstance(raw_troop_casualties, (int, float)) else 0
            ),
            'troop_casualties': raw_troop_casualties,
            'funds': funds[index] if index < len(funds) else None,
        })
    return {
        'teams': teams_out,
        'sources': {
            'strength': 'game.strength' if strength else None,
            'casualties': 'game.casualties' if casualties else None,
            'troop_casualties': 'game.troop_casualties' if troop_casualties else None,
            'funds': 'game.economy.%s' % funds_source if funds_source else None,
        },
    }

def troop_from_obj(obj, slot):
    attrs = attrs_of(obj)
    point = read_position(obj)
    if point is None:
        return None
    alive = read_first_attr(attrs, ('alive', 'is_alive', 'dead', 'is_dead'))
    if isinstance(alive, bool) and ('dead' in attrs or 'is_dead' in attrs):
        alive = not alive
    elif alive is None:
        alive = True
    owner = read_first_attr(attrs, ('owner', 'team', 'player', 'color', 'colour'))
    unit_type = read_first_attr(attrs, ('type', 'unit_type', 'kind', 'name'))
    health = read_first_attr(attrs, ('health', 'hp'))
    morale = read_first_attr(attrs, ('morale', 'morality'))
    return {
        'slot': slot,
        'unit_id': hex(id(obj)),
        'owner': safe_repr(owner, 80) if owner is not None and not isinstance(owner, (int, float, str, bool)) else owner,
        'type': safe_repr(unit_type, 80) if unit_type is not None and not isinstance(unit_type, (int, float, str, bool)) else unit_type,
        'x': point['x'],
        'y': point['y'],
        'health': to_float(health),
        'morale': to_float(morale),
        'alive': bool(alive),
        'path': [point],
    }

def candidate_score(obj):
    score = 0
    attrs = attrs_of(obj)
    names = set(str(name) for name in attrs.keys())
    cls = type(obj)
    cls_names = set(str(name) for name in dir(cls))
    all_names = names | cls_names
    for name in ('tick_frame', 'extract_dot_positions', 'update_alive_dots', 'move_dots', 'unpack_data'):
        if name in all_names:
            score += 12
    for name in all_names:
        low = name.lower()
        if any(word in low for word in KEYWORDS):
            score += 1
    if read_position(obj) is not None:
        score += 6
    return score

def summarize_obj(obj):
    attrs = attrs_of(obj)
    cls = type(obj)
    object_name = None
    try:
        object_name = getattr(obj, '__name__', None)
    except Exception:
        object_name = None
    interesting = []
    for name in list(attrs.keys())[:160]:
        low = str(name).lower()
        if any(word in low for word in KEYWORDS):
            interesting.append(str(name))
    methods = []
    for name in dir(cls):
        if name.startswith('__'):
            continue
        if any(word in name.lower() for word in KEYWORDS):
            try:
                value = getattr(obj, name)
            except Exception:
                continue
            if callable(value):
                methods.append(name)
    sample = {}
    sample_keys = interesting[:24]
    try:
        if getattr(cls, '__name__', '') in TARGET_CLASSES:
            sample_keys = list(dict.fromkeys(list(attrs.keys())[:80] + sample_keys))
    except Exception:
        pass
    for name in sample_keys[:80]:
        try:
            sample[name] = jsonable(attrs.get(name))
        except Exception as exc:
            sample[name] = '<read failed: %s>' % exc
    return {
        'id': hex(id(obj)),
        'name': object_name,
        'class': getattr(cls, '__name__', safe_repr(cls, 60)),
        'module': getattr(cls, '__module__', ''),
        'score': candidate_score(obj),
        'attr_count': len(attrs),
        'keys': [str(key) for key in list(attrs.keys())[:120]],
        'interesting_keys': interesting[:60],
        'methods': methods[:60],
        'sample': sample,
    }

def discover_candidates(limit=80):
    candidates = []
    for obj in gc.get_objects():
        try:
            score = candidate_score(obj)
        except Exception:
            continue
        if score >= 8:
            candidates.append((score, obj))
    candidates.sort(key=lambda item: item[0], reverse=True)
    return [obj for _, obj in candidates[:limit]]

def summarize_global(name, value):
    item = summarize_obj(value)
    item['global_name'] = name
    if isinstance(value, type):
        methods = {}
        for key, attr in attrs_of(value).items():
            if key.startswith('__') and key != '__init__':
                continue
            if callable(attr):
                methods[str(key)] = summarize_callable(attr)
        item['methods'] = methods
    return item

def target_inventory():
    main = sys.modules.get('__main__')
    globals_out = {}
    if main is not None:
        for name in TARGET_GLOBALS:
            if hasattr(main, name):
                try:
                    globals_out[name] = summarize_global(name, getattr(main, name))
                except Exception as exc:
                    globals_out[name] = {'error': repr(exc)}
    instances = []
    if FULL_GC_DISCOVERY:
        for obj in gc.get_objects():
            try:
                cls_name = getattr(type(obj), '__name__', '')
            except Exception:
                continue
            if cls_name in TARGET_CLASSES:
                try:
                    instances.append(summarize_obj(obj))
                except Exception as exc:
                    instances.append({'class': cls_name, 'error': repr(exc)})
            if len(instances) >= 100:
                break
    return {'globals': globals_out, 'instances': instances}

def find_instances(class_name, limit=20):
    found = []
    for obj in gc.get_objects():
        try:
            if type(obj).__name__ == class_name:
                found.append(obj)
        except Exception:
            continue
        if len(found) >= limit:
            break
    return found

def replay_record(replay):
    return {'name': 'replay1', 'content': replay}

def prepare_play_scene_for_replay(play_scene, replay, replay_file_value=None):
    try:
        setattr(play_scene, 'game_mode', 'replay')
    except Exception:
        pass
    try:
        setattr(play_scene, 'custom_map', replay.get('custom_map') if isinstance(replay, dict) else False)
    except Exception:
        pass
    if replay_file_value is None:
        replay_file_value = 'replay1'
    attrs = attrs_of(play_scene)
    setup = attrs.get('game_setup')
    if isinstance(setup, dict):
        setup['mode'] = 'replay'
        setup['room'] = False
        setup['room_info'] = {'code': None, 'public_map_room': False}
        setup['custom_map'] = replay.get('custom_map') if isinstance(replay, dict) else setup.get('custom_map')
        setup['replay_file'] = replay_file_value
    return summarize_obj(play_scene)

def get_game_scene_objects():
    scenes = []
    main = sys.modules.get('__main__')
    if main is not None:
        try:
            last = getattr(main, '_codex_last_game_scene', None)
            if last is not None:
                scenes.append(last)
        except Exception:
            pass
    if FULL_GC_DISCOVERY:
        for scene in find_instances('aaadaa', limit=20):
            if all(id(scene) != id(existing) for existing in scenes):
                scenes.append(scene)
    return scenes

def find_active_play_scenes():
    return [
        play_scene for play_scene in find_instances('PlayScene', limit=10)
        if 'frame' in attrs_of(play_scene) and 'game_setup' in attrs_of(play_scene)
    ]

def wait_for_play_scene(seconds=3.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready = find_active_play_scenes()
        if ready or get_game_objects():
            return ready
        time.sleep(0.1)
    return find_active_play_scenes()

def request_play_scene(home, scene_name, attempts):
    try:
        setattr(home, 'game_mode', 'replay')
        setattr(home, 'change_scene', scene_name)
        attempts.append({
            'method': 'HomeScene.change_scene',
            'arg': scene_name,
            'object': summarize_obj(home),
            'status': 'set',
        })
    except Exception as exc:
        attempts.append({'method': 'HomeScene.change_scene', 'arg': scene_name, 'status': 'failed', 'error': repr(exc)})
        return []
    update = getattr(home, 'update', None)
    if callable_no_args(update):
        for index in range(4):
            result = call_with_timeout('home-scene-update', update, timeout_seconds=2.0)
            if result.get('status') != 'called':
                attempts.append({
                    'method': 'HomeScene.update',
                    'arg': scene_name,
                    'attempt': index,
                    **result,
                })
                break
            ready = find_active_play_scenes()
            if ready or get_game_objects():
                return ready
            time.sleep(0.1)
    return wait_for_play_scene(seconds=8.0)

def attempt_play_scene_transition(play_scene, replay, attempts, label, replay_file_value=None, call_start_game=False):
    record_progress({'phase': 'variant-start', 'label': label, 'call_start_game': call_start_game})
    prepared = prepare_play_scene_for_replay(play_scene, replay, replay_file_value)
    attempts.append({
        'method': 'PlayScene.prepare_replay.%s' % label,
        'object': prepared,
        'replay_file': trace_value(replay_file_value, 8),
        'status': 'set',
    })
    record_progress({'phase': 'variant-prepared', 'label': label, 'play_scene': hex(id(play_scene))})
    try:
        if call_start_game:
            record_progress({'phase': 'variant-call-start-game', 'label': label})
            call_result = call_with_timeout('start-game', play_scene.start_game, timeout_seconds=4.0)
            if call_result.get('status') != 'called':
                attempts.append({
                    'method': 'PlayScene.start_game.%s' % label,
                    'object': summarize_obj(play_scene),
                    **call_result,
                })
                return False
            attempts.append({
                'method': 'PlayScene.start_game.%s' % label,
                'object': summarize_obj(play_scene),
                'status': 'called',
            })
        else:
            record_progress({'phase': 'variant-set-change-scene', 'label': label})
            setattr(play_scene, 'change_scene', 'game')
            attempts.append({
                'method': 'PlayScene.change_scene.%s' % label,
                'object': summarize_obj(play_scene),
                'status': 'set',
            })
    except Exception as exc:
        attempts.append({
            'method': 'PlayScene.transition.%s' % label,
            'object': summarize_obj(play_scene),
            'status': 'failed',
            'error': repr(exc),
            'traceback': traceback.format_exc(limit=6),
        })
        return False

    for _ in range(12):
        try:
            record_progress({'phase': 'variant-update-before', 'label': label})
            call_result = call_with_timeout('play-scene-update', play_scene.update, timeout_seconds=4.0)
            if call_result.get('status') != 'called':
                record_progress({'phase': 'variant-update-timeout', 'label': label, 'result': call_result})
                attempts.append({
                    'method': 'PlayScene.update.%s' % label,
                    'object_id': hex(id(play_scene)),
                    **call_result,
                })
                break
            record_progress({'phase': 'variant-update-after', 'label': label, 'game_objects': len(get_game_objects()), 'game_scenes': len(get_game_scene_objects())})
            attempts.append({'method': 'PlayScene.update.%s' % label, 'object_id': hex(id(play_scene)), 'status': 'called'})
        except Exception as exc:
            attempts.append({
                'method': 'PlayScene.update.%s' % label,
                'object_id': hex(id(play_scene)),
                'status': 'failed',
                'error': repr(exc),
                'traceback': traceback.format_exc(limit=6),
            })
            break
        time.sleep(0.1)
        if get_game_objects():
            break
    for _ in range(20):
        if get_game_objects():
            return True
        time.sleep(0.1)
    return False

def construct_core_game(replay, attempts):
    main = sys.modules.get('__main__')
    if main is None or not isinstance(replay, dict):
        return False
    game_cls = getattr(main, 'aaaaac', None)
    if game_cls is None:
        attempts.append({'method': 'aaaaac.__init__', 'status': 'missing'})
        return False
    map_choice = replay.get('map')
    custom_map = replay.get('custom_map')
    arg_sets = [
        (map_choice, custom_map if custom_map else False),
        (map_choice, False),
    ]
    for args in arg_sets:
        try:
            game = game_cls(*args)
            setattr(main, '_codex_capture_game', game)
            attempts.append({'method': 'aaaaac.__init__', 'args': jsonable(args), 'object': summarize_obj(game), 'status': 'called'})
            return True
        except Exception as exc:
            attempts.append({'method': 'aaaaac.__init__', 'args': jsonable(args), 'status': 'failed', 'error': repr(exc)})
    return False

def force_server_ready(attempts):
    main = sys.modules.get('__main__')
    if main is None:
        return
    server = getattr(main, 'server_manager', None)
    if server is None:
        attempts.append({'method': 'server_manager.force_ready', 'status': 'missing'})
        return
    changes = {}
    for key, value in (
        ('access', True),
        ('authorized', True),
        ('ready', True),
        ('request_perms', False),
        ('steam_id', 'local-capture'),
        ('login_credentials', {'username': 'local-capture', 'steam_id': 'local-capture'}),
    ):
        try:
            setattr(server, key, value)
            changes[key] = value
        except Exception as exc:
            changes[key] = '<failed: %s>' % exc
    attempts.append({'method': 'server_manager.force_ready', 'object': summarize_obj(server), 'changes': changes, 'status': 'set'})

def poke_home_scene_start(attempts, replay):
    install_trace_hooks(attempts)
    force_server_ready(attempts)
    experimental_variants = [
        ('manual-replay-record', replay_record(replay), False),
        ('manual-replay-dict', replay, False),
        ('manual-replay-name', 'replay1', False),
        ('manual-replay-path', 'replays/replay1.rep', False),
        ('start-game-name', 'replay1', True),
    ]
    if VARIANT_FILTER:
        variants = [variant for variant in experimental_variants if variant[0] in VARIANT_FILTER]
        attempts.append({'method': 'variant_filter', 'status': 'set', 'variants': [variant[0] for variant in variants]})
    else:
        variants = [('manual-replay-name', 'replay1', False)]
    for label, replay_file_value, call_start_game in variants:
        homes = find_instances('HomeScene', limit=5)
        for home in homes:
            for scene_name in ('play', 'PlayScene', 'game', 'replay'):
                ready_play_scenes = request_play_scene(home, scene_name, attempts)
                if not ready_play_scenes and not get_game_objects():
                    attempts.append({
                        'method': 'HomeScene.change_scene',
                        'arg': scene_name,
                        'variant': label,
                        'status': 'no-ready-play-scene',
                    })
                    continue
                for play_scene in ready_play_scenes:
                    if attempt_play_scene_transition(
                        play_scene,
                        replay,
                        attempts,
                        label,
                        replay_file_value=replay_file_value,
                        call_start_game=call_start_game,
                    ):
                        attempts.append({
                            'method': 'HomeScene.change_scene',
                            'arg': scene_name,
                            'variant': label,
                            'status': 'observed-transition',
                            'play_scene_count': len(find_instances('PlayScene', limit=20)),
                            'ready_play_scene_count': len(find_active_play_scenes()),
                            'game_scene_count': len(get_game_scene_objects()),
                            'game_object_count': len(get_game_objects()),
                        })
                        return True
                attempts.append({
                    'method': 'HomeScene.change_scene',
                    'arg': scene_name,
                    'variant': label,
                    'status': 'no-game-object',
                    'play_scene_count': len(find_instances('PlayScene', limit=20)),
                    'ready_play_scene_count': len(find_active_play_scenes()),
                    'game_scene_count': len(get_game_scene_objects()),
                    'game_object_count': len(get_game_objects()),
                })
    if not get_game_objects():
        attempts.append({
            'method': 'aaaaac.__init__',
            'status': 'skipped',
            'reason': 'direct constructor can block the injected thread; using game scene path only',
        })
    return False

def summarize_replay(value):
    if not isinstance(value, dict):
        return jsonable(value)
    tick_keys = []
    for key in value.keys():
        if str(key).isdigit():
            try:
                tick_keys.append(int(key))
            except Exception:
                pass
    tick_keys.sort()
    return {
        'type': 'dict',
        'map': value.get('map'),
        'version': value.get('version'),
        'result': value.get('result'),
        'end': value.get('end'),
        'tick_count': len(tick_keys),
        'first_tick': tick_keys[0] if tick_keys else None,
        'max_tick': tick_keys[-1] if tick_keys else None,
        'player_usernames': value.get('player_usernames'),
    }

def load_replay_summary():
    main = sys.modules.get('__main__')
    if main is None or not hasattr(main, 'replay_manager'):
        return None, {'error': '__main__.replay_manager is not available'}
    manager = getattr(main, 'replay_manager')
    calls = {}
    replay = None
    for name, func in (
        ('find_replays', lambda: manager.find_replays()),
        ('load_all_replays', lambda: manager.load_all_replays()),
        ('load_replay_replay1', lambda: manager.load_replay('replay1')),
    ):
        try:
            value = func()
            calls[name] = summarize_replay(value)
            if name == 'load_replay_replay1' and isinstance(value, dict):
                replay = value
        except Exception as exc:
            calls[name] = {'error': repr(exc)}
    return replay, calls

def try_start_live_replay(candidates, replay):
    attempts = []
    main = sys.modules.get('__main__')
    if main is not None:
        if poke_home_scene_start(attempts, replay):
            return attempts

        play_scene_cls = getattr(main, 'PlayScene', None)
        if play_scene_cls is not None:
            try:
                play_scene = play_scene_cls()
                attempts.append({'method': 'PlayScene.__init__', 'object': summarize_obj(play_scene), 'status': 'called'})
                try:
                    play_scene.start_game()
                    attempts.append({'method': 'PlayScene.start_game', 'object': summarize_obj(play_scene), 'status': 'called'})
                except Exception as exc:
                    attempts.append({'method': 'PlayScene.start_game', 'object': summarize_obj(play_scene), 'status': 'failed', 'error': repr(exc)})
                for _ in range(3):
                    try:
                        play_scene.update()
                        attempts.append({'method': 'PlayScene.update', 'object_id': hex(id(play_scene)), 'status': 'called'})
                    except Exception as exc:
                        attempts.append({'method': 'PlayScene.update', 'object_id': hex(id(play_scene)), 'status': 'failed', 'error': repr(exc)})
                        break
            except Exception as exc:
                attempts.append({'method': 'PlayScene.__init__', 'status': 'failed', 'error': repr(exc)})

        scene_manager = getattr(main, 'scene_manager', None)
        if scene_manager is not None and hasattr(scene_manager, 'update_scene'):
            for scene_name in ('play', 'game', 'replay', 'PlayScene'):
                try:
                    scene_manager.update_scene(scene_name)
                    attempts.append({'method': 'scene_manager.update_scene', 'arg': scene_name, 'object': summarize_obj(scene_manager), 'status': 'called'})
                    break
                except Exception as exc:
                    attempts.append({'method': 'scene_manager.update_scene', 'arg': scene_name, 'object': summarize_obj(scene_manager), 'status': 'failed', 'error': repr(exc)})

    called = 0
    for obj in candidates:
        cls_name = getattr(type(obj), '__name__', '').lower()
        if 'sound' in cls_name or 'tutorial' in cls_name:
            continue
        for method_name in ('start_game', 'initialize_game'):
            if not has_noarg(obj, method_name):
                continue
            summary = summarize_obj(obj)
            try:
                getattr(obj, method_name)()
                attempts.append({'method': method_name, 'object': summary, 'status': 'called'})
                called += 1
                if called >= 4:
                    return attempts
            except Exception as exc:
                attempts.append({'method': method_name, 'object': summary, 'status': 'failed', 'error': repr(exc)})
    return attempts

def get_game_objects():
    games = []
    main = sys.modules.get('__main__')
    if main is not None:
        try:
            capture_game = getattr(main, '_codex_capture_game', None)
            if capture_game is not None:
                games.append(capture_game)
        except Exception:
            pass
    for scene in get_game_scene_objects():
        attrs = attrs_of(scene)
        for key in ('game', 'core'):
            child = attrs.get(key)
            if child is None:
                continue
            try:
                is_core = type(child).__name__ == 'aaaaac' or candidate_score(child) >= 20
            except Exception:
                is_core = False
            if is_core and all(id(child) != id(existing) for existing in games):
                games.append(child)
    if FULL_GC_DISCOVERY:
        for obj in gc.get_objects():
            try:
                if type(obj).__name__ == 'aaaaac' and all(id(obj) != id(existing) for existing in games):
                    games.append(obj)
            except Exception:
                continue
    return games

def get_replay_connections():
    connections = []
    for scene in get_game_scene_objects():
        attrs = attrs_of(scene)
        connection = attrs.get('controller')
        if connection is not None and all(id(connection) != id(existing) for existing in connections):
            connections.append(connection)
    if FULL_GC_DISCOVERY:
        for obj in gc.get_objects():
            try:
                if type(obj).__name__ == 'ReplayConnection' and all(id(obj) != id(existing) for existing in connections):
                    connections.append(obj)
            except Exception:
                continue
    return connections

def merge_known_candidates(existing):
    merged = []
    for obj in list(existing or []) + get_game_scene_objects() + get_game_objects() + get_replay_connections():
        if obj is not None and all(id(obj) != id(item) for item in merged):
            merged.append(obj)
    return merged

def replay_tick_payloads(replay, limit):
    if not isinstance(replay, dict):
        return []
    ticks = []
    for key in replay.keys():
        if str(key).isdigit():
            try:
                ticks.append(int(key))
            except Exception:
                pass
    ticks.sort()
    payloads = []
    for tick in ticks[:max(1, int(limit))]:
        payloads.append((tick, replay.get(str(tick), {})))
    return payloads

def all_replay_tick_payloads(replay):
    return replay_tick_payloads(replay, 1000000)

def get_replay_payload_cache(replay):
    global REPLAY_PAYLOAD_CACHE
    if REPLAY_PAYLOAD_CACHE is None:
        REPLAY_PAYLOAD_CACHE = all_replay_tick_payloads(replay)
    return REPLAY_PAYLOAD_CACHE

def apply_replay_payload_to_game(game, data, tick):
    if data is None:
        return {'tick': tick, 'status': 'empty'}
    attempts = []
    for connection in get_replay_connections()[:3]:
        if hasattr(connection, 'unpack_data'):
            try:
                connection.unpack_data(game, data)
                return {'tick': tick, 'method': 'ReplayConnection.unpack_data', 'status': 'called'}
            except Exception as exc:
                attempts.append({'method': 'ReplayConnection.unpack_data', 'status': 'failed', 'error': repr(exc)})
    if hasattr(game, 'unpack_data'):
        try:
            game.unpack_data(data)
            return {'tick': tick, 'method': 'aaaaac.unpack_data', 'status': 'called', 'attempts': attempts}
        except Exception as exc:
            attempts.append({'method': 'aaaaac.unpack_data', 'status': 'failed', 'error': repr(exc)})
    return {'tick': tick, 'status': 'no-unpack-method', 'attempts': attempts}

def step_game_frame(game, method_counts, errors):
    preferred_methods = []
    if FAST_FORWARD_STEP_METHOD in ('game-update', 'update', 'core-update'):
        preferred_methods = ('update', 'tick_frame')
    elif FAST_FORWARD_STEP_METHOD in ('manual', 'component', 'components'):
        preferred_methods = ('update_alive_dots', 'move_dots', 'update_strength', 'extract_dot_positions')
    else:
        preferred_methods = ('tick_frame', 'update')

    for method_name in preferred_methods:
        if not hasattr(game, method_name):
            continue
        method = getattr(game, method_name)
        if not callable_no_args(method):
            continue
        try:
            method()
            method_counts[method_name] = method_counts.get(method_name, 0) + 1
            return True
        except Exception as exc:
            errors.append({'method': method_name, 'error': repr(exc)})
            return False
    errors.append({'method': 'core-step', 'error': 'no callable core step method for %s' % FAST_FORWARD_STEP_METHOD})
    return False

def fast_forward_game_core(game, replay, end_tick):
    global REPLAY_PAYLOAD_CURSOR
    if not FAST_FORWARD_CORE or FAST_FORWARD_FRAMES_PER_SAMPLE <= 0 or game is None:
        return None
    payloads = get_replay_payload_cache(replay)
    method_counts = {}
    applied = []
    errors = []
    start_tick = read_tick([game])
    frame_count = 0
    for _ in range(FAST_FORWARD_FRAMES_PER_SAMPLE):
        current_tick = read_tick([game])
        while REPLAY_PAYLOAD_CURSOR < len(payloads):
            payload_tick, payload_data = payloads[REPLAY_PAYLOAD_CURSOR]
            if current_tick is not None and payload_tick > current_tick:
                break
            result = apply_replay_payload_to_game(game, payload_data, payload_tick)
            if len(applied) < 12:
                applied.append(result)
            REPLAY_PAYLOAD_CURSOR += 1
        if not step_game_frame(game, method_counts, errors):
            break
        frame_count += 1
        new_tick = read_tick([game])
        if end_tick is not None and new_tick is not None and new_tick >= end_tick:
            break
    return {
        'method': 'core-fast-forward',
        'requested_frames': FAST_FORWARD_FRAMES_PER_SAMPLE,
        'stepped_frames': frame_count,
        'start_tick': start_tick,
        'end_tick': read_tick([game]),
        'replay_payload_cursor': REPLAY_PAYLOAD_CURSOR,
        'replay_payload_count': len(payloads),
        'applied_payloads': applied,
        'method_counts': method_counts,
        'errors': errors[:6],
    }

def fast_forward_scene_controller(scene, end_tick):
    if not FAST_FORWARD_CONTROLLER or FAST_FORWARD_FRAMES_PER_SAMPLE <= 0 or scene is None:
        return None
    attrs = attrs_of(scene)
    controller = attrs.get('controller')
    game = attrs.get('core') or attrs.get('game')
    interface = attrs.get('interface')
    download_data = getattr(controller, 'download_data', None) if controller is not None else None
    if controller is None or game is None or interface is None:
        return None
    if not callable(download_data):
        return None
    method_counts = {}
    errors = []
    start_tick = read_tick([game])
    frame_count = 0
    for _ in range(FAST_FORWARD_FRAMES_PER_SAMPLE):
        try:
            download_data(game, interface)
            method_counts['ReplayConnection.download_data'] = method_counts.get('ReplayConnection.download_data', 0) + 1
        except Exception as exc:
            errors.append({'method': 'ReplayConnection.download_data', 'error': repr(exc)})
            break
        if not step_game_frame(game, method_counts, errors):
            break
        frame_count += 1
        new_tick = read_tick([game])
        if end_tick is not None and new_tick is not None and new_tick >= end_tick:
            break
    return {
        'method': 'scene-controller-fast-forward',
        'requested_frames': FAST_FORWARD_FRAMES_PER_SAMPLE,
        'stepped_frames': frame_count,
        'start_tick': start_tick,
        'end_tick': read_tick([game]),
        'controller_id': hex(id(controller)),
        'game_id': hex(id(game)),
        'interface_id': hex(id(interface)),
        'method_counts': method_counts,
        'errors': errors[:6],
    }

def drive_game_with_replay(game, replay, index):
    calls = []
    payloads = replay_tick_payloads(replay, max(MAX_SAMPLES, 1))
    tick = payloads[index % len(payloads)][0] if payloads else None
    data = payloads[index % len(payloads)][1] if payloads else None
    if data is not None:
        calls.append(apply_replay_payload_to_game(game, data, tick))
    for method_name in ('tick_frame', 'update_alive_dots', 'move_dots', 'update_strength', 'extract_dot_positions', 'update'):
        if hasattr(game, method_name) and callable_no_args(getattr(game, method_name)):
            try:
                getattr(game, method_name)()
                calls.append({'method': 'aaaaac.%s' % method_name, 'status': 'called'})
            except Exception as exc:
                calls.append({'method': 'aaaaac.%s' % method_name, 'status': 'failed', 'error': repr(exc)})
    return tick, calls

def advance_candidates(candidates):
    calls = []
    for obj in candidates[:30]:
        for method_name in ('tick_frame', 'update_alive_dots', 'extract_dot_positions', 'move_dots', 'update_strength'):
            if not has_noarg(obj, method_name):
                continue
            try:
                getattr(obj, method_name)()
                calls.append({'method': method_name, 'object_id': hex(id(obj)), 'status': 'called'})
            except Exception as exc:
                calls.append({'method': method_name, 'object_id': hex(id(obj)), 'status': 'failed', 'error': repr(exc)})
    return calls

def collect_troops(candidates, limit=600):
    seen = set()
    troops = []
    source_objects = []

    def consider(obj):
        if id(obj) in seen:
            return
        troop = troop_from_obj(obj, len(troops))
        if troop is not None:
            seen.add(id(obj))
            troops.append(troop)
            source_objects.append(obj)

    for obj in candidates:
        consider(obj)
        attrs = attrs_of(obj)
        for key, value in attrs.items():
            if len(troops) >= limit:
                break
            low = str(key).lower()
            if not any(word in low for word in ('dot', 'unit', 'troop', 'alive', 'enemy', 'friendly')):
                continue
            try:
                values = value.values() if isinstance(value, Mapping) else value
                for child in list(values)[:limit]:
                    consider(child)
                    if len(troops) >= limit:
                        break
            except Exception:
                continue
        if len(troops) >= limit:
            break

    if not troops:
        for obj in gc.get_objects():
            consider(obj)
            if len(troops) >= limit:
                break
    return troops

def read_tick(candidates):
    best = None
    for obj in candidates:
        attrs = attrs_of(obj)
        for key, value in attrs.items():
            low = str(key).lower()
            if low in ('tick', 'ticks', 'current_tick', 'frame', 'current_frame') or low.endswith('_tick'):
                number = to_float(value)
                if number is not None:
                    if best is None or number > best:
                        best = number
    return int(best) if best is not None else None

def set_simulation_speed(game_scenes):
    changes = []
    for scene in game_scenes:
        attrs = attrs_of(scene)
        if 'ips' not in attrs:
            continue
        current = to_float(attrs.get('ips'))
        try:
            setattr(scene, 'ips', TARGET_SIM_SPEED)
            changes.append({
                'scene_id': hex(id(scene)),
                'field': 'ips',
                'before': current,
                'after': TARGET_SIM_SPEED,
                'status': 'set',
            })
        except Exception as exc:
            changes.append({
                'scene_id': hex(id(scene)),
                'field': 'ips',
                'before': current,
                'after': TARGET_SIM_SPEED,
                'status': 'failed',
                'error': repr(exc),
            })
    return changes

def pump_live_scene_updates(game_scenes, replay, end_tick):
    if SIM_UPDATE_BURST <= 0 and ((not FAST_FORWARD_CORE and not FAST_FORWARD_CONTROLLER) or FAST_FORWARD_FRAMES_PER_SAMPLE <= 0):
        return []
    out = []
    for scene in game_scenes[:2]:
        attrs = attrs_of(scene)
        controller = attrs.get('controller')
        game = attrs.get('core') or attrs.get('game')
        interface = attrs.get('interface')
        controller_fast_forward = fast_forward_scene_controller(scene, end_tick)
        if controller_fast_forward is not None:
            controller_fast_forward['scene_id'] = hex(id(scene))
            out.append(controller_fast_forward)
            continue
        fast_forward = fast_forward_game_core(game, replay, end_tick)
        if fast_forward is not None:
            fast_forward['scene_id'] = hex(id(scene))
            out.append(fast_forward)
            continue

        download_data = getattr(controller, 'download_data', None) if controller is not None else None
        if callable(download_data) and game is not None and interface is not None:
            called = 0
            error = None
            for _ in range(SIM_UPDATE_BURST):
                try:
                    download_data(game, interface)
                    called += 1
                except Exception as exc:
                    error = repr(exc)
                    break
            item = {
                'scene_id': hex(id(scene)),
                'controller_id': hex(id(controller)),
                'method': 'ReplayConnection.download_data',
                'requested': SIM_UPDATE_BURST,
                'called': called,
            }
            if error:
                item['error'] = error
            out.append(item)
            continue

        update = getattr(scene, 'update', None)
        if not callable_no_args(update):
            continue
        called = 0
        error = None
        for _ in range(SIM_UPDATE_BURST):
            try:
                update()
                called += 1
            except Exception as exc:
                error = repr(exc)
                break
        item = {
            'scene_id': hex(id(scene)),
            'method': 'update',
            'requested': SIM_UPDATE_BURST,
            'called': called,
        }
        if error:
            item['error'] = error
        out.append(item)
    return out

def completion_status(games, game_scenes, tick, end_tick):
    has_live_state = bool(games or game_scenes)
    if has_live_state and end_tick is not None and tick is not None and tick >= end_tick:
        return {'done': True, 'reason': 'tick-reached-end', 'tick': tick, 'end_tick': end_tick}
    for game in games:
        attrs = attrs_of(game)
        if attrs.get('winner') is not None:
            return {'done': True, 'reason': 'winner-set', 'tick': tick, 'winner': jsonable(attrs.get('winner'))}
    for scene in game_scenes:
        attrs = attrs_of(scene)
        if attrs.get('result') is not None:
            return {'done': True, 'reason': 'scene-result-set', 'tick': tick, 'result': jsonable(attrs.get('result'))}
        change_scene = attrs.get('change_scene')
        if change_scene not in (None, '', False):
            return {'done': True, 'reason': 'scene-changed', 'tick': tick, 'change_scene': jsonable(change_scene)}
    return {'done': False, 'tick': tick, 'end_tick': end_tick}

def positions_signature(sample):
    out = {}
    for troop in sample.get('troops', []):
        if troop.get('x') is None or troop.get('y') is None:
            continue
        out[troop['unit_id']] = (round(float(troop['x']), 4), round(float(troop['y']), 4))
    return out

def motion_stats_from_samples(samples):
    points_by_slot = {}
    for sample in samples:
        for troop in sample.get('troops', []):
            if troop.get('x') is None or troop.get('y') is None:
                continue
            key = str(troop.get('slot') if troop.get('slot') is not None else troop.get('unit_id'))
            try:
                point = (float(troop.get('x')), float(troop.get('y')))
            except Exception:
                continue
            points_by_slot.setdefault(key, []).append(point)
    max_span = 0.0
    moving_slots = 0
    for points in points_by_slot.values():
        if len(points) < 2:
            continue
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        span = ((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2) ** 0.5
        max_span = max(max_span, span)
        if span >= 8:
            moving_slots += 1
    return {
        'max_span': round(max_span, 3),
        'moving_slots': moving_slots,
        'tracked_slots': len(points_by_slot),
    }

def motion_stats_from_replay(replay):
    if not isinstance(replay, dict):
        return {'max_span': 0, 'moving_slots': 0, 'tracked_slots': 0}
    points_by_slot = {}
    for tick, payload in replay.items():
        if not str(tick).isdigit() or not isinstance(payload, Mapping):
            continue
        for key, value in payload.items():
            if not str(key).isdigit():
                continue
            values = value if isinstance(value, (list, tuple)) else []
            for item in values:
                point = to_point(item)
                if point is None:
                    continue
                points_by_slot.setdefault(str(key), []).append((point['x'], point['y']))
    max_span = 0.0
    moving_slots = 0
    for points in points_by_slot.values():
        if len(points) < 2:
            continue
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        span = ((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2) ** 0.5
        max_span = max(max_span, span)
        if span >= 40:
            moving_slots += 1
    return {
        'max_span': round(max_span, 3),
        'moving_slots': moving_slots,
        'tracked_slots': len(points_by_slot),
    }

def metric_number(team, *keys):
    if not isinstance(team, Mapping):
        return None
    for key in keys:
        value = to_float(team.get(key))
        if value is not None:
            return value
    return None

def scoreboard_stats_from_samples(samples):
    metric_samples = [
        sample for sample in samples
        if isinstance(sample.get('metrics'), Mapping)
        and isinstance(sample.get('metrics', {}).get('teams'), list)
        and sample.get('game_object_count', 0) > 0
    ]
    if not metric_samples:
        return {
            'available': False,
            'start_troops': [],
            'final_troops': [],
            'strength_drop_ratio': 0,
            'casualty_ratio': 0,
        }
    first = metric_samples[0].get('metrics', {}).get('teams', [])
    last = metric_samples[-1].get('metrics', {}).get('teams', [])
    team_count = max(len(first), len(last))
    start_troops = []
    final_troops = []
    final_casualties = []
    for index in range(team_count):
        first_team = first[index] if index < len(first) else {}
        last_team = last[index] if index < len(last) else {}
        start = metric_number(first_team, 'troops_estimate')
        if start is None:
            strength = metric_number(first_team, 'strength')
            start = strength * 100 if strength is not None else None
        final = metric_number(last_team, 'troops_estimate')
        if final is None:
            strength = metric_number(last_team, 'strength')
            final = strength * 100 if strength is not None else None
        casualties = metric_number(last_team, 'casualties_estimate')
        if casualties is None:
            raw_casualties = metric_number(last_team, 'troop_casualties', 'casualties')
            casualties = raw_casualties * 100 if raw_casualties is not None else 0
        start_troops.append(int(start) if start is not None else None)
        final_troops.append(int(final) if final is not None else None)
        final_casualties.append(int(casualties) if casualties is not None else 0)
    start_total = sum(value for value in start_troops if isinstance(value, int))
    final_total = sum(value for value in final_troops if isinstance(value, int))
    casualty_total = sum(value for value in final_casualties if isinstance(value, int))
    strength_drop_ratio = ((start_total - final_total) / start_total) if start_total > 0 else 0
    casualty_ratio = (casualty_total / start_total) if start_total > 0 else 0
    return {
        'available': True,
        'start_troops': start_troops,
        'final_troops': final_troops,
        'final_casualties': final_casualties,
        'start_total': int(start_total),
        'final_total': int(final_total),
        'casualty_total': int(casualty_total),
        'strength_drop_ratio': round(strength_drop_ratio, 4),
        'casualty_ratio': round(casualty_ratio, 4),
    }

def validate_samples(samples, replay=None):
    ticks = [sample.get('tick') for sample in samples if isinstance(sample.get('tick'), int)]
    live_ticks = [
        sample.get('tick') for sample in samples
        if isinstance(sample.get('tick'), int)
        and sample.get('tick_source') != 'synthetic'
        and sample.get('game_object_count', 0) > 0
    ]
    tick_advanced = len(set(live_ticks)) > 1
    live_tick_span = (max(live_ticks) - min(live_ticks)) if live_ticks else 0
    game_sample_count = sum(1 for sample in samples if sample.get('game_object_count', 0) > 0)
    non_empty_samples = sum(1 for sample in samples if sample.get('troops'))
    synthetic_tick_count = sum(1 for sample in samples if sample.get('tick_source') == 'synthetic')
    live_source_count = sum(
        1 for sample in samples
        if sample.get('game_object_count', 0) > 0 and sample.get('tick_source') != 'synthetic'
    )
    positions_changed = False
    if len(samples) >= 2:
        game_samples = [sample for sample in samples if sample.get('game_object_count', 0) > 0]
        first = positions_signature(game_samples[0]) if game_samples else {}
        for sample in game_samples[1:]:
            current = positions_signature(sample)
            for key, point in current.items():
                if key in first and first[key] != point:
                    positions_changed = True
                    break
            if positions_changed:
                break
    live_motion = motion_stats_from_samples(samples)
    replay_motion = motion_stats_from_replay(replay)
    required_live_span = 0
    motion_plausible = True
    if live_tick_span >= 3000 and replay_motion['max_span'] >= 180:
        required_live_span = max(60, min(160, replay_motion['max_span'] * 0.18))
        motion_plausible = live_motion['max_span'] >= required_live_span
    scoreboard = scoreboard_stats_from_samples(samples)
    required_scoreboard_drop = 0
    scoreboard_plausible = True
    if live_tick_span >= 3000 and scoreboard.get('available') and scoreboard.get('start_total', 0) >= 100000:
        required_scoreboard_drop = 0.18
        scoreboard_plausible = (
            scoreboard.get('strength_drop_ratio', 0) >= required_scoreboard_drop
            or scoreboard.get('casualty_ratio', 0) >= required_scoreboard_drop
        )
    warnings = []
    blocking_reasons = []
    if len(samples) < 2:
        blocking_reasons.append('fewer than 2 samples')
    if game_sample_count < 2:
        blocking_reasons.append('fewer than 2 samples exposed live game objects')
    if live_source_count < 2:
        blocking_reasons.append('fewer than 2 samples used non-synthetic live ticks')
    if not tick_advanced:
        blocking_reasons.append('live tick/frame did not advance')
    if not positions_changed:
        blocking_reasons.append('unit positions did not change')
    if not motion_plausible:
        blocking_reasons.append('live unit motion was too small for replay motion')
    if synthetic_tick_count and synthetic_tick_count >= len(samples):
        blocking_reasons.append('all ticks were synthetic')
    if not scoreboard_plausible:
        warnings.append(
            'scoreboard counters changed less than expected; accepting capture because live ticks and positions advanced'
        )
    valid = (
        len(samples) >= 2
        and game_sample_count >= 2
        and live_source_count >= 2
        and tick_advanced
        and positions_changed
        and motion_plausible
        and synthetic_tick_count < len(samples)
    )
    return {
        'tick_advanced': tick_advanced,
        'positions_changed': positions_changed,
        'motion_plausible': motion_plausible,
        'scoreboard_plausible': scoreboard_plausible,
        'live_motion': live_motion,
        'replay_motion': replay_motion,
        'scoreboard': scoreboard,
        'required_live_motion_span': round(required_live_span, 3),
        'required_scoreboard_drop_ratio': required_scoreboard_drop,
        'warnings': warnings,
        'blocking_reasons': blocking_reasons,
        'live_tick_span': live_tick_span,
        'sample_count': len(samples),
        'non_empty_samples': non_empty_samples,
        'game_sample_count': game_sample_count,
        'live_source_count': live_source_count,
        'synthetic_tick_count': synthetic_tick_count,
        'valid': valid,
    }

try:
    os.makedirs(os.path.dirname(ARTIFACT_PATH), exist_ok=True)
    if STATS_PATH:
        os.makedirs(os.path.dirname(STATS_PATH), exist_ok=True)
    with open(REQUEST_PATH, 'r', encoding='utf-8') as handle:
        request = json.load(handle)

    replay, replay_calls = load_replay_summary()
    candidates = discover_candidates()
    artifact = {
        'status': 'probing',
        'mode': MODE,
        'source': SOURCE,
        'pid': os.getpid(),
        'replay_calls': replay_calls,
        'target_inventory_before': target_inventory(),
        'candidate_count': len(candidates),
        'candidates': [summarize_obj(obj) for obj in candidates[:40]],
        'start_attempts': [],
        'advance_calls': [],
        'speed_changes': [],
        'scene_update_pumps': [],
        'capture_config': {
            'sample_hz': SAMPLE_HZ,
            'max_samples': MAX_SAMPLES,
            'capture_until_end': CAPTURE_UNTIL_END,
            'target_sim_speed': TARGET_SIM_SPEED,
            'sim_update_burst': SIM_UPDATE_BURST,
            'fast_forward_core': FAST_FORWARD_CORE,
            'fast_forward_controller': FAST_FORWARD_CONTROLLER,
            'fast_forward_step_method': FAST_FORWARD_STEP_METHOD,
            'fast_forward_frames_per_sample': FAST_FORWARD_FRAMES_PER_SAMPLE,
            'full_gc_discovery': FULL_GC_DISCOVERY,
        },
        'trace_events': TRACE_EVENTS,
        'validation': {},
    }

    samples = []
    map_payload = None
    teams = build_teams(replay, [])
    end_tick = to_int(request.get('replay_metadata', {}).get('end'))
    if end_tick is None and isinstance(replay, dict):
        end_tick = to_int(replay.get('end'))
    if MODE in ('sample-live-state', 'capture-live-replay'):
        artifact['start_attempts'] = try_start_live_replay(candidates, replay)
        time.sleep(0.75)
        candidates = merge_known_candidates(candidates)
        artifact['target_inventory_after_start'] = target_inventory()
        interval = 1.0 / max(1, int(SAMPLE_HZ))
        sample_total = max(1, int(MAX_SAMPLES))
        if not get_game_objects():
            sample_total = min(sample_total, 5)
        capture_start_ms = int(time.time() * 1000)
        record_progress({
            'stage': 'capture-start',
            'sample_hz': SAMPLE_HZ,
            'max_samples': sample_total,
            'end_tick': end_tick,
            'capture_until_end': CAPTURE_UNTIL_END,
            'target_sim_speed': TARGET_SIM_SPEED,
            'fast_forward_controller': FAST_FORWARD_CONTROLLER,
            'fast_forward_step_method': FAST_FORWARD_STEP_METHOD,
        })
        for index in range(sample_total):
            calls = []
            games = get_game_objects()
            game_scenes = get_game_scene_objects()
            speed_changes = set_simulation_speed(game_scenes)
            if index < 5:
                artifact['speed_changes'].extend(speed_changes)
            if games and DRIVE_REPLAY_DATA:
                for game in games[:3]:
                    tick_from_replay, game_calls = drive_game_with_replay(game, replay, index)
                    calls.extend(game_calls)
            else:
                tick_from_replay = None
            if not games or ADVANCE_CANDIDATES_WITH_GAME:
                calls.extend(advance_candidates(candidates))
            if index < 5:
                artifact['advance_calls'].extend(calls[:30])
            preferred_tick_sources = list(games[:3]) + list(game_scenes[:3])
            troop_sources = preferred_tick_sources + candidates
            live_tick = read_tick(preferred_tick_sources)
            candidate_tick = None
            if live_tick is None:
                candidate_tick = read_tick(candidates)
            tick = live_tick if live_tick is not None else candidate_tick
            troops = collect_troops(troop_sources)
            if map_payload is None and (games or game_scenes):
                map_payload = capture_map_image(replay, games, game_scenes)
                artifact['map_capture'] = summarize_map_payload(map_payload)
            teams = build_teams(replay, games)
            metrics = build_metrics(games, troops, teams)
            now_ms = int(time.time() * 1000)
            completion = completion_status(games, game_scenes, live_tick, end_tick)
            sample = {
                'sample_index': index,
                'timestamp_ms': now_ms - capture_start_ms,
                'wall_timestamp_ms': now_ms,
                'tick': tick if tick is not None else (tick_from_replay if tick_from_replay is not None else index),
                'tick_source': 'game-object' if live_tick is not None else ('candidate' if candidate_tick is not None else ('replay-tick-after-game-drive' if tick_from_replay is not None else 'synthetic')),
                'game_object_count': len(games),
                'game_object_ids': [hex(id(game)) for game in games[:3]],
                'game_scene_count': len(game_scenes),
                'game_scene_ids': [hex(id(scene)) for scene in game_scenes[:3]],
                'troops': troops,
                'metrics': metrics,
                'events': {},
            }
            if completion.get('done'):
                sample['completion'] = completion
            samples.append(sample)
            tick_percent = None
            if end_tick is not None and sample.get('tick') is not None:
                try:
                    tick_percent = max(0, min(1, float(sample.get('tick')) / max(1, float(end_tick))))
                except Exception:
                    tick_percent = None
            record_progress({
                'stage': 'capture-sample',
                'sample_index': index,
                'sample_count': len(samples),
                'max_samples': sample_total,
                'tick': sample.get('tick'),
                'tick_source': sample.get('tick_source'),
                'end_tick': end_tick,
                'tick_percent': round(tick_percent, 4) if tick_percent is not None else None,
                'elapsed_ms': now_ms - capture_start_ms,
                'game_object_count': len(games),
                'game_scene_count': len(game_scenes),
                'troop_count': len(troops),
                'teams': metrics.get('teams', [])[:4] if isinstance(metrics, dict) else [],
                'completion': completion if completion.get('done') else None,
            })
            if CAPTURE_UNTIL_END and completion.get('done') and len(samples) >= 2:
                artifact['completion'] = completion
                break
            pump_calls = pump_live_scene_updates(game_scenes, replay, end_tick)
            if index < 5 and pump_calls:
                artifact['scene_update_pumps'].extend(pump_calls)
            time.sleep(interval)
        if games:
            try:
                artifact['economy_profile'] = economy_profile(attrs_of(games[0]).get('economy'), max(len(teams), 2))
            except Exception as exc:
                artifact['economy_profile'] = {'error': repr(exc)}

    validation = validate_samples(samples, replay)
    artifact['status'] = 'ok'
    artifact['validation'] = validation
    artifact['trace_events'] = TRACE_EVENTS
    artifact['sample_preview'] = samples[:5]
    write_json_atomic(ARTIFACT_PATH, artifact)

    if MODE == 'capture-live-replay':
        if not validation['valid']:
            reasons = validation.get('blocking_reasons') or ['live game capture validation failed']
            raise RuntimeError('Live game capture validation failed: %s. See artifact: %s' % ('; '.join(reasons), ARTIFACT_PATH))
        stats = {
            'job_id': request.get('job_id'),
            'game_version': request.get('replay_metadata', {}).get('version'),
            'game_exe_hash': None,
            'source': SOURCE,
            'replay_metadata': request.get('replay_metadata', {}),
            'map': map_payload,
            'teams': teams,
            'sample_rate_hz': SAMPLE_HZ,
            'samples': samples,
            'summary': {
                'sample_count': len(samples),
                'troop_slots_seen': len({troop.get('unit_id') for sample in samples for troop in sample.get('troops', [])}),
                'result': request.get('replay_metadata', {}).get('result'),
                'end_tick': request.get('replay_metadata', {}).get('end'),
                'first_tick': samples[0].get('tick') if samples else None,
                'last_tick': samples[-1].get('tick') if samples else None,
                'capture_until_end': CAPTURE_UNTIL_END,
                'simulation_speed': TARGET_SIM_SPEED,
                'fast_forward_core': FAST_FORWARD_CORE,
                'fast_forward_controller': FAST_FORWARD_CONTROLLER,
                'fast_forward_step_method': FAST_FORWARD_STEP_METHOD,
                'fast_forward_frames_per_sample': FAST_FORWARD_FRAMES_PER_SAMPLE,
                'map_source': map_payload.get('source') if map_payload else None,
                'validation': validation,
                'artifact': ARTIFACT_PATH,
                'replay_summary': summarize_replay(replay),
            },
        }
        write_json_atomic(STATS_PATH, stats)
except Exception:
    error = traceback.format_exc()
    os.makedirs(os.path.dirname(ARTIFACT_PATH), exist_ok=True)
    with open(ARTIFACT_PATH + '.error.txt', 'w', encoding='utf-8') as handle:
        handle.write(error)
    if STATS_PATH:
        os.makedirs(os.path.dirname(STATS_PATH), exist_ok=True)
        with open(STATS_PATH + '.error.txt', 'w', encoding='utf-8') as handle:
            handle.write(error)
    raise
"@
}

function Invoke-GamePythonCapture([string]$Id) {
    $jobRoot = Get-JobRoot $Id
    $statsPath = Join-Path $jobRoot 'stats.json'
    $requestPath = Join-Path $jobRoot 'capture-request.json'
    if (-not (Test-Path -LiteralPath $requestPath)) {
        throw "Capture request not found: $requestPath"
    }

    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $builtDll = Join-Path $root 'tools\python-probe-dll\target\release\wod_python_probe.dll'
    if (-not (Test-Path -LiteralPath $builtDll)) {
        throw "Python probe DLL is not built: $builtDll"
    }

    $probeRoot = Join-Path $ShareRoot 'probes\game-live-python-capture'
    New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
    $probeDll = Join-Path $probeRoot 'wod_python_probe.dll'
    $payloadPath = Join-Path $probeRoot 'wod_python_probe_payload.py'
    $statusPath = Join-Path $probeRoot 'wod_python_probe.status.json'
    $artifactPath = Join-Path $jobRoot 'live-capture-artifact.json'
    Remove-Item -LiteralPath $statsPath, ($statsPath + '.tmp'), $statusPath, ($statsPath + '.error.txt'), $artifactPath, ($artifactPath + '.tmp'), ($artifactPath + '.error.txt'), ($artifactPath + '.progress.jsonl') -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $builtDll -Destination $probeDll -Force
    $captureMode = if ($env:WOD_LIVE_CAPTURE_MODE) { $env:WOD_LIVE_CAPTURE_MODE.Trim().ToLowerInvariant() } else { 'full' }
    $windowedCaptureModes = @('window', 'sample', 'samples', 'fixed')
    $captureUntilEnd = -not ($windowedCaptureModes -contains $captureMode)
    $requestedCaptureSeconds = [Math]::Max(10, $MaxSeconds - 45)
    if ((-not $captureUntilEnd) -and $env:WOD_LIVE_CAPTURE_SECONDS) {
        $requestedCaptureSeconds = [Math]::Max(10, [int]$env:WOD_LIVE_CAPTURE_SECONDS)
    }
    $captureSeconds = [Math]::Max(10, [Math]::Min($requestedCaptureSeconds, $MaxSeconds - 45))
    $maxSamples = [Math]::Max(2, [Math]::Min(50000, $SampleHz * $captureSeconds))
    Set-Content -LiteralPath $payloadPath -Value (New-LiveGameCapturePayload -RequestPath $requestPath -StatsPath $statsPath -ArtifactPath $artifactPath -Mode 'capture-live-replay' -SampleHz $SampleHz -MaxSamples $maxSamples) -Encoding UTF8

    $mutex = New-Object System.Threading.Mutex($false, 'Global\WodReplayCapture')
    if (-not $mutex.WaitOne([TimeSpan]::FromMinutes(60))) {
        throw 'Timed out waiting for capture lock.'
    }

    $process = $null
    $slotState = $null
    $existingGamePids = Get-GameProcessIds
    try {
        $slotState = Prepare-ReplaySlot -Id $Id
        $process = Start-GameProcess
        $hWnd = Find-GameWindow -ProcessId $process.Id -TimeoutSeconds 60
        if ($hWnd -eq [IntPtr]::Zero) {
            throw 'War of Dots window was not found.'
        }
        Apply-WindowStrategy -WindowHandle $hWnd

        $injector = Join-Path $PSScriptRoot 'invoke-python-probe.ps1'
        $injectResult = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $injector `
            -ProcessId $process.Id `
            -ProbeDll $probeDll `
            -TimeoutSeconds 30
        if ($LASTEXITCODE -ne 0) {
            throw "Python capture injector failed with exit code $LASTEXITCODE."
        }

        $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(30, $MaxSeconds))
        while ([DateTime]::UtcNow -lt $deadline) {
            if ((Test-Path -LiteralPath $statsPath) -or (Test-Path -LiteralPath ($statsPath + '.error.txt'))) {
                break
            }
            Start-Sleep -Milliseconds 250
        }

        if (-not (Test-Path -LiteralPath $statsPath)) {
            $errorPath = $statsPath + '.error.txt'
            $message = if (Test-Path -LiteralPath $errorPath) { Get-Content -LiteralPath $errorPath -Raw } else { 'Game Python capture did not produce stats.json.' }
            throw $message
        }

        $stats = Read-JsonFile $statsPath
        Write-JsonResult @{
            ok = $true
            status = 'captured'
            source = 'game-live-python'
            job_id = $Id
            stats_path = $statsPath
            artifact_path = $artifactPath
            sample_count = $stats.summary.sample_count
            inject_result = $injectResult
        }
        exit 0
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Stop-NewGameProcesses $existingGamePids
        Close-AutomationDesktop
        Restore-ReplaySlot $slotState
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}

function Invoke-LiveStateExperiment([string]$Id, [string]$Mode) {
    $jobRoot = Get-JobRoot $Id
    $requestPath = Join-Path $jobRoot 'capture-request.json'
    if (-not (Test-Path -LiteralPath $requestPath)) {
        throw "Capture request not found: $requestPath"
    }

    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $builtDll = Join-Path $root 'tools\python-probe-dll\target\release\wod_python_probe.dll'
    if (-not (Test-Path -LiteralPath $builtDll)) {
        throw "Python probe DLL is not built: $builtDll"
    }

    $probeRoot = Join-Path $ShareRoot "probes\$Mode"
    New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
    $probeDll = Join-Path $probeRoot 'wod_python_probe.dll'
    $payloadPath = Join-Path $probeRoot 'wod_python_probe_payload.py'
    $statusPath = Join-Path $probeRoot 'wod_python_probe.status.json'
    $artifactPath = Join-Path $jobRoot "$Mode-artifact.json"
    $statsPath = Join-Path $jobRoot "$Mode-stats.json"
    Remove-Item -LiteralPath $statusPath, $artifactPath, ($artifactPath + '.tmp'), ($artifactPath + '.error.txt'), ($artifactPath + '.progress.jsonl'), $statsPath, ($statsPath + '.tmp'), ($statsPath + '.error.txt') -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $builtDll -Destination $probeDll -Force

    $sampleCount = if ($Mode -eq 'probe-replay-state') { 1 } else { [Math]::Max(2, [Math]::Min(240, $SampleHz * [Math]::Min($MaxSeconds, 30))) }
    Set-Content -LiteralPath $payloadPath -Value (New-LiveGameCapturePayload -RequestPath $requestPath -StatsPath $statsPath -ArtifactPath $artifactPath -Mode $Mode -SampleHz $SampleHz -MaxSamples $sampleCount) -Encoding UTF8

    $mutex = New-Object System.Threading.Mutex($false, 'Global\WodReplayCapture')
    if (-not $mutex.WaitOne([TimeSpan]::FromMinutes(60))) {
        throw 'Timed out waiting for capture lock.'
    }

    $process = $null
    $slotState = $null
    $existingGamePids = Get-GameProcessIds
    try {
        $slotState = Prepare-ReplaySlot -Id $Id
        $process = Start-GameProcess
        $hWnd = Find-GameWindow -ProcessId $process.Id -TimeoutSeconds 60
        if ($hWnd -eq [IntPtr]::Zero) {
            throw 'War of Dots window was not found.'
        }
        Apply-WindowStrategy -WindowHandle $hWnd

        $injector = Join-Path $PSScriptRoot 'invoke-python-probe.ps1'
        $injectResult = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $injector `
            -ProcessId $process.Id `
            -ProbeDll $probeDll `
            -TimeoutSeconds 30
        if ($LASTEXITCODE -ne 0) {
            throw "Python experiment injector failed with exit code $LASTEXITCODE."
        }

        $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(45, [Math]::Min($MaxSeconds + 30, 180)))
        while ([DateTime]::UtcNow -lt $deadline) {
            if ((Test-Path -LiteralPath $artifactPath) -or (Test-Path -LiteralPath ($artifactPath + '.error.txt'))) {
                break
            }
            Start-Sleep -Milliseconds 250
        }

        if (-not (Test-Path -LiteralPath $artifactPath)) {
            $errorPath = $artifactPath + '.error.txt'
            $message = if (Test-Path -LiteralPath $errorPath) { Get-Content -LiteralPath $errorPath -Raw } else { 'Live state experiment did not produce an artifact.' }
            throw $message
        }

        Write-JsonResult @{
            ok = $true
            status = 'probed'
            source = 'game-live-python'
            mode = $Mode
            job_id = $Id
            artifact_path = $artifactPath
            artifact_bytes = (Get-Item -LiteralPath $artifactPath).Length
            inject_result = $injectResult
        }
        exit 0
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Stop-NewGameProcesses $existingGamePids
        Close-AutomationDesktop
        Restore-ReplaySlot $slotState
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}

if ($Smoke) {
    $gameExe = Get-GameExe
    $jobsDir = Join-Path $ShareRoot 'jobs'
    $result = @{
        ok = (Test-Path $gameExe)
        mode = 'local-session'
        share_root = $ShareRoot
        game_exe_exists = (Test-Path $gameExe)
        jobs_dir_exists = (Test-Path $jobsDir)
        interactive_user = [Environment]::UserInteractive
        machine = $env:COMPUTERNAME
        user = $env:USERNAME
        window_strategy = $WindowStrategy
    }
    Write-JsonResult $result
    if (-not $result.ok) { exit 2 }
    exit 0
}

if ($LaunchSmoke) {
    Test-GameLaunch
    exit 0
}

if ($OpenReplaySmoke) {
    Test-OpenReplay -Id $JobId
    exit 0
}

if ($Calibrate) {
    Run-Calibration
    exit 0
}

if ($PythonProbe) {
    Invoke-PythonRuntimeProbe
    exit 0
}

if ($ProbeReplayState) {
    Invoke-LiveStateExperiment -Id $JobId -Mode 'probe-replay-state'
    exit 0
}

if ($SampleLiveState) {
    Invoke-LiveStateExperiment -Id $JobId -Mode 'sample-live-state'
    exit 0
}

if ($CaptureReplay) {
    Capture-Replay -Id $JobId
    exit 0
}

if ($GamePythonCapture -or $CaptureLiveReplay) {
    Invoke-GamePythonCapture -Id $JobId
    exit 0
}

Write-JsonResult @{
    ok = $false
    message = 'Specify -Smoke, -Calibrate, -PythonProbe, -ProbeReplayState, -SampleLiveState, -CaptureLiveReplay, -GamePythonCapture, or -CaptureReplay.'
}
exit 3
