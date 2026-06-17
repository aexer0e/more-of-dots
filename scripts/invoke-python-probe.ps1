[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [Parameter(Mandatory = $true)]
    [string]$ProbeDll,
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Win32 -Name ProbeInject -MemberDefinition @'
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(UInt32 access, bool inherit, UInt32 pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualAllocEx(IntPtr process, IntPtr address, UIntPtr size, UInt32 allocationType, UInt32 protect);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(IntPtr process, IntPtr baseAddress, byte[] buffer, UIntPtr size, out UIntPtr written);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr GetModuleHandleA(string moduleName);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr GetProcAddress(IntPtr module, string procName);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateRemoteThread(IntPtr process, IntPtr attributes, UIntPtr stackSize, IntPtr startAddress, IntPtr parameter, UInt32 creationFlags, out UInt32 threadId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeThread(IntPtr thread, out UInt32 exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
'@

$PROCESS_CREATE_THREAD = 0x0002
$PROCESS_QUERY_INFORMATION = 0x0400
$PROCESS_VM_OPERATION = 0x0008
$PROCESS_VM_WRITE = 0x0020
$PROCESS_VM_READ = 0x0010
$MEM_COMMIT = 0x1000
$MEM_RESERVE = 0x2000
$PAGE_READWRITE = 0x04
$WAIT_TIMEOUT = 0x00000102

$resolvedDll = (Resolve-Path -LiteralPath $ProbeDll).Path
$dllBytes = [System.Text.Encoding]::Unicode.GetBytes($resolvedDll + [char]0)
$dllByteCount = [UIntPtr]::new([uint64]$dllBytes.Length)

$access = $PROCESS_CREATE_THREAD -bor $PROCESS_QUERY_INFORMATION -bor $PROCESS_VM_OPERATION -bor $PROCESS_VM_WRITE -bor $PROCESS_VM_READ
$process = [Win32.ProbeInject]::OpenProcess($access, $false, [uint32]$ProcessId)
if ($process -eq [IntPtr]::Zero) {
    throw "OpenProcess failed for PID $ProcessId."
}

try {
    $remotePath = [Win32.ProbeInject]::VirtualAllocEx(
        $process,
        [IntPtr]::Zero,
        $dllByteCount,
        $MEM_COMMIT -bor $MEM_RESERVE,
        $PAGE_READWRITE
    )
    if ($remotePath -eq [IntPtr]::Zero) {
        throw 'VirtualAllocEx failed.'
    }

    $written = [UIntPtr]::Zero
    $ok = [Win32.ProbeInject]::WriteProcessMemory(
        $process,
        $remotePath,
        $dllBytes,
        $dllByteCount,
        [ref]$written
    )
    if (-not $ok -or $written.ToUInt64() -ne [uint64]$dllBytes.Length) {
        throw 'WriteProcessMemory failed.'
    }

    $kernel32 = [Win32.ProbeInject]::GetModuleHandleA('kernel32.dll')
    if ($kernel32 -eq [IntPtr]::Zero) {
        throw 'GetModuleHandleA(kernel32.dll) failed.'
    }
    $loadLibrary = [Win32.ProbeInject]::GetProcAddress($kernel32, 'LoadLibraryW')
    if ($loadLibrary -eq [IntPtr]::Zero) {
        throw 'GetProcAddress(LoadLibraryW) failed.'
    }

    $threadId = [uint32]0
    $thread = [Win32.ProbeInject]::CreateRemoteThread(
        $process,
        [IntPtr]::Zero,
        [UIntPtr]::Zero,
        $loadLibrary,
        $remotePath,
        0,
        [ref]$threadId
    )
    if ($thread -eq [IntPtr]::Zero) {
        throw 'CreateRemoteThread failed.'
    }

    try {
        $wait = [Win32.ProbeInject]::WaitForSingleObject($thread, [uint32]($TimeoutSeconds * 1000))
        if ($wait -eq $WAIT_TIMEOUT) {
            throw 'Timed out waiting for remote LoadLibraryW thread.'
        }
        $exitCode = [uint32]0
        [void][Win32.ProbeInject]::GetExitCodeThread($thread, [ref]$exitCode)
        [ordered]@{
            status = 'injected'
            process_id = $ProcessId
            probe_dll = $resolvedDll
            remote_thread_id = $threadId
            load_library_result = ('0x{0:X}' -f $exitCode)
        } | ConvertTo-Json -Depth 8 -Compress
    } finally {
        [void][Win32.ProbeInject]::CloseHandle($thread)
    }
} finally {
    [void][Win32.ProbeInject]::CloseHandle($process)
}
