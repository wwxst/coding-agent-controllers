Set-StrictMode -Version Latest

$script:ExpectedTools = @(
    'workbuddy_cancel'
    'workbuddy_result'
    'workbuddy_resume'
    'workbuddy_run'
    'workbuddy_status'
)
$script:LauncherFileName = 'workbuddy-codebuddy.exe'
$script:LauncherMarkerFileName = 'workbuddy-codebuddy.sha256'

function Get-DefaultCodexHome {
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        return [IO.Path]::GetFullPath($env:CODEX_HOME)
    }
    return Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
}

function ConvertTo-TomlString([string]$Value) {
    $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
    $escaped = $escaped.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    return '"' + $escaped + '"'
}

function Remove-WorkBuddySections([string]$Contents) {
    if ([string]::IsNullOrEmpty($Contents)) {
        return ''
    }

    $newLine = if ($Contents.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = [regex]::Split($Contents, '\r?\n')
    $kept = [Collections.Generic.List[string]]::new()
    $skip = $false

    foreach ($line in $lines) {
        if ($line -match '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
            $section = $Matches[1].Trim()
            $skip = $section -match '^mcp_servers\.(?:workbuddy|"workbuddy")(?:\.|$)'
        }
        if (-not $skip) {
            $kept.Add($line)
        }
    }

    return (($kept -join $newLine).TrimEnd())
}

function Set-WorkBuddyMcpConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$ServerPath,
        [Parameter(Mandatory)][string]$PluginRoot,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Environment
    )

    $configDirectory = Split-Path -Parent $ConfigPath
    if (-not (Test-Path -LiteralPath $configDirectory)) {
        New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
    }

    $existing = if (Test-Path -LiteralPath $ConfigPath) {
        [IO.File]::ReadAllText($ConfigPath)
    } else {
        ''
    }
    $base = Remove-WorkBuddySections $existing
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add('[mcp_servers.workbuddy]')
    $lines.Add("command = $(ConvertTo-TomlString ([IO.Path]::GetFullPath($NodePath)))")
    $lines.Add("args = [$(ConvertTo-TomlString ([IO.Path]::GetFullPath($ServerPath)))]")
    $lines.Add("cwd = $(ConvertTo-TomlString ([IO.Path]::GetFullPath($PluginRoot)))")
    $lines.Add('enabled = true')
    $lines.Add('startup_timeout_sec = 30')
    $lines.Add('tool_timeout_sec = 3600')
    $lines.Add('')
    $lines.Add('[mcp_servers.workbuddy.env]')
    foreach ($key in @($Environment.Keys | Sort-Object)) {
        $lines.Add("$key = $(ConvertTo-TomlString ([string]$Environment[$key]))")
    }

    $newLine = if ($existing.Contains("`r`n")) { "`r`n" } else { "`n" }
    $section = $lines -join $newLine
    $updated = if ([string]::IsNullOrWhiteSpace($base)) {
        $section + $newLine
    } else {
        $base + $newLine + $newLine + $section + $newLine
    }
    [IO.File]::WriteAllText($ConfigPath, $updated, [Text.UTF8Encoding]::new($false))
}

function Remove-WorkBuddyMcpConfig {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ConfigPath)

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        return
    }
    $existing = [IO.File]::ReadAllText($ConfigPath)
    $updated = Remove-WorkBuddySections $existing
    if (-not [string]::IsNullOrWhiteSpace($updated)) {
        $updated += if ($existing.Contains("`r`n")) { "`r`n" } else { "`n" }
    }
    [IO.File]::WriteAllText($ConfigPath, $updated, [Text.UTF8Encoding]::new($false))
}

function Find-CodeBuddy {
    [CmdletBinding()]
    param([string]$ExplicitPath)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (Test-Path -LiteralPath $ExplicitPath -PathType Leaf) {
            return (Resolve-Path -LiteralPath $ExplicitPath).Path
        }
        throw "codebuddy was not found at the explicit path: $ExplicitPath"
    }

    $candidates = [Collections.Generic.List[string]]::new()
    $command = Get-Command codebuddy -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
        $candidates.Add($command.Source)
    }

    try {
        $executables = Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object { $_.Name -eq 'WorkBuddyAI.exe' -and $_.ExecutablePath } |
            Select-Object -ExpandProperty ExecutablePath -Unique
        foreach ($executable in $executables) {
            $root = Split-Path -Parent $executable
            $candidates.Add((Join-Path $root 'resources\app.asar.unpacked\cli\bin\codebuddy'))
        }
    } catch {
        # Process discovery is optional; registry and standard locations remain available.
    }

    $registryRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($registryRoot in $registryRoots) {
        try {
            $entries = Get-ItemProperty $registryRoot -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like '*WorkBuddy*' -and $_.InstallLocation }
            foreach ($entry in $entries) {
                $candidates.Add((Join-Path $entry.InstallLocation 'resources\app.asar.unpacked\cli\bin\codebuddy'))
            }
        } catch {
            # Missing registry hives are normal across Windows editions.
        }
    }

    $standardRoots = @(
        (Join-Path $env:LOCALAPPDATA 'Programs'),
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)}
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) }
    foreach ($root in $standardRoots) {
        foreach ($name in 'WorkBuddyAI', 'WorkBuddy', 'WorkBuddy AI') {
            $candidates.Add((Join-Path $root "$name\resources\app.asar.unpacked\cli\bin\codebuddy"))
        }
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'codebuddy was not found. Start WorkBuddy once or pass -CodeBuddyPath with its absolute path.'
}

function Get-WorkBuddyInstallRoot([string]$CodeBuddyPath) {
    $bin = Split-Path -Parent ([IO.Path]::GetFullPath($CodeBuddyPath))
    $root = $bin
    foreach ($unused in 1..4) {
        $root = Split-Path -Parent $root
    }
    return $root
}

function Get-NodeExecutable {
    $command = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace($command.Source)) {
        throw 'Node.js was not found on PATH.'
    }
    return [IO.Path]::GetFullPath($command.Source)
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$Label
    )
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

function Get-PnpmInvocation {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pnpm -and -not [string]::IsNullOrWhiteSpace($pnpm.Source)) {
        return [pscustomobject]@{ FilePath = $pnpm.Source; Prefix = @() }
    }
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $corepack -or [string]::IsNullOrWhiteSpace($corepack.Source)) {
        throw 'Neither pnpm nor corepack was found on PATH.'
    }
    return [pscustomobject]@{ FilePath = $corepack.Source; Prefix = @('pnpm') }
}

function ConvertTo-WindowsCommandLine([string[]]$Arguments) {
    $quoted = foreach ($argument in $Arguments) {
        if ($argument -notmatch '[\s"]') {
            $argument
            continue
        }
        '"' + ($argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
    }
    return $quoted -join ' '
}

function New-WorkBuddyLauncher {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$CodexHome)

    $launcherDirectory = Join-Path $CodexHome 'bin\workbuddy-control'
    $launcherPath = Join-Path $launcherDirectory $script:LauncherFileName
    if (Test-Path -LiteralPath $launcherPath -PathType Leaf) {
        if (Test-OwnedWorkBuddyLauncher -LauncherDirectory $launcherDirectory) {
            return $launcherPath
        }
        throw "Refusing to replace an unowned launcher: $launcherPath"
    }
    New-Item -ItemType Directory -Path $launcherDirectory -Force | Out-Null

    $sourcePath = Join-Path $launcherDirectory ("workbuddy-codebuddy-$([guid]::NewGuid().ToString('N')).cs")
    $source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class WorkBuddyCodeBuddyLauncher
{
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    public static int Main(string[] args)
    {
        try
        {
            var node = Environment.GetEnvironmentVariable("WORKBUDDY_NODE_BIN");
            var script = Environment.GetEnvironmentVariable("WORKBUDDY_CODEBUDDY_SCRIPT");
            var productConfig = Environment.GetEnvironmentVariable("ACC_PRODUCT_CONFIG_PATH");
            if (String.IsNullOrWhiteSpace(node) || !File.Exists(node))
                throw new InvalidOperationException("WORKBUDDY_NODE_BIN is missing or invalid.");
            if (String.IsNullOrWhiteSpace(script) || !File.Exists(script))
                throw new InvalidOperationException("WORKBUDDY_CODEBUDDY_SCRIPT is missing or invalid.");
            if (String.IsNullOrWhiteSpace(productConfig) || !File.Exists(productConfig))
                throw new InvalidOperationException("ACC_PRODUCT_CONFIG_PATH is missing or invalid.");

            Environment.SetEnvironmentVariable("ACC_PRODUCT_CONFIG_V3", File.ReadAllText(productConfig));
            var arguments = new List<string> { Quote(script) };
            foreach (var argument in args) arguments.Add(Quote(argument));
            var startInfo = new ProcessStartInfo
            {
                FileName = node,
                Arguments = String.Join(" ", arguments),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var child = Process.Start(startInfo))
            {
                if (child == null) throw new InvalidOperationException("Failed to start codebuddy.");
                var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                child.WaitForExit();
                stdout.GetAwaiter().GetResult();
                stderr.GetAwaiter().GetResult();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("workbuddy launcher: " + error.Message);
            return 1;
        }
    }
}
'@
    [IO.File]::WriteAllText($sourcePath, $source, [Text.UTF8Encoding]::new($false))
    try {
        $windowsPowerShell = Join-Path $PSHOME 'powershell.exe'
        if (-not (Test-Path -LiteralPath $windowsPowerShell)) {
            $windowsPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
        }
        $escapedSource = $sourcePath.Replace("'", "''")
        $escapedLauncher = $launcherPath.Replace("'", "''")
        $compile = "Add-Type -Path '$escapedSource' -OutputAssembly '$escapedLauncher' -OutputType ConsoleApplication"
        & $windowsPowerShell -NoProfile -NonInteractive -Command $compile
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherPath)) {
            throw 'Failed to compile the local WorkBuddy launcher.'
        }
    } finally {
        Remove-Item -LiteralPath $sourcePath -Force -ErrorAction SilentlyContinue
    }
    $markerPath = Join-Path $launcherDirectory $script:LauncherMarkerFileName
    try {
        $hash = (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash
        [IO.File]::WriteAllText($markerPath, $hash, [Text.UTF8Encoding]::new($false))
    } catch {
        Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
        throw
    }
    return $launcherPath
}

function Test-OwnedWorkBuddyLauncher {
    param([Parameter(Mandatory)][string]$LauncherDirectory)

    $launcherPath = Join-Path $LauncherDirectory $script:LauncherFileName
    $markerPath = Join-Path $LauncherDirectory $script:LauncherMarkerFileName
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        return $false
    }
    $expectedHash = ([IO.File]::ReadAllText($markerPath)).Trim()
    if ($expectedHash -notmatch '^[A-Fa-f0-9]{64}$') { return $false }
    return (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash -eq $expectedHash
}

function Remove-WorkBuddyLauncher {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$CodexHome)

    $launcherDirectory = Join-Path ([IO.Path]::GetFullPath($CodexHome)) 'bin\workbuddy-control'
    if (-not (Test-OwnedWorkBuddyLauncher -LauncherDirectory $launcherDirectory)) { return }
    Remove-Item -LiteralPath (Join-Path $launcherDirectory $script:LauncherFileName) -Force
    Remove-Item -LiteralPath (Join-Path $launcherDirectory $script:LauncherMarkerFileName) -Force
    if (@(Get-ChildItem -LiteralPath $launcherDirectory -Force).Count -eq 0) {
        Remove-Item -LiteralPath $launcherDirectory -Force
    }
}

function Get-CodeBuddyVersion([string]$NodePath, [string]$CodeBuddyPath) {
    $output = & $NodePath $CodeBuddyPath --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $null -eq $output) {
        return 'unknown'
    }
    return ([string]($output | Select-Object -First 1)).Trim()
}

function Get-WorkBuddyVersion([string]$InstallRoot) {
    $executable = Join-Path $InstallRoot 'WorkBuddyAI.exe'
    if (-not (Test-Path -LiteralPath $executable)) {
        return 'unknown'
    }
    $version = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($version)) {
        $version = (Get-Item -LiteralPath $executable).VersionInfo.FileVersion
    }
    if ([string]::IsNullOrWhiteSpace($version)) { return 'unknown' }
    return ($version -split '[+ ]')[0]
}

function Get-WorkBuddyEnvironment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$CodeBuddyPath,
        [Parameter(Mandatory)][string]$WorkBuddyConfigDir,
        [Parameter(Mandatory)][string]$LauncherPath
    )

    $configDirectory = [IO.Path]::GetFullPath($WorkBuddyConfigDir)
    $productConfig = Join-Path $configDirectory 'cache\acc-product-config-v3.json'
    if (-not (Test-Path -LiteralPath $productConfig -PathType Leaf)) {
        throw "WorkBuddy product configuration was not found: $productConfig. Start WorkBuddy Desktop once for the current user."
    }
    $installRoot = Get-WorkBuddyInstallRoot $CodeBuddyPath
    $skills = Join-Path $installRoot 'resources\app.asar.unpacked\resources\plugins\workbuddy-builtin\skills'
    if (-not (Test-Path -LiteralPath $skills -PathType Container)) {
        throw "WorkBuddy built-in skills directory was not found: $skills"
    }
    $workBuddyVersion = Get-WorkBuddyVersion $installRoot
    $codeBuddyVersion = Get-CodeBuddyVersion $NodePath $CodeBuddyPath

    $environment = [ordered]@{
        ACC_PRODUCT_CONFIG_PATH = $productConfig
        CLIENT_INFO_IDE_TYPE = 'WorkBuddy'
        CLIENT_INFO_PLATFORM = 'WorkBuddy'
        CLIENT_INFO_PLATFORM_VERSION = $workBuddyVersion
        CLIENT_INFO_PLUGIN_NAME = 'workbuddy-desktop'
        CLIENT_INFO_PLUGIN_VERSION = $workBuddyVersion
        CLIENT_INFO_PRODUCT_NAME = 'WorkBuddy AI'
        CLIENT_INFO_PRODUCT_VERSION = $workBuddyVersion
        CLIENT_INFO_USER_AGENT_EXTENSION = "CLI/$codeBuddyVersion"
        CODEBUDDY_BUILTIN_SKILLS_DIR = $skills
        CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY = '1'
        CODEBUDDY_CONFIG_DIR = $configDirectory
        CODEBUDDY_DISABLE_CRON = '1'
        CODEBUDDY_DISABLE_REQUEST_VALIDATION = '1'
        CODEBUDDY_FORCE_HEADLESS_BUNDLE = '1'
        CODEBUDDY_HOST = 'workbuddy-desktop'
        CODEBUDDY_INTERNET_ENVIRONMENT = 'external'
        CODEBUDDY_WAIT_FOR_MCP_SERVERS_ENABLED = '0'
        NO_PROXY = '127.0.0.1,localhost'
        WORKBUDDY_CODEBUDDY_BIN = [IO.Path]::GetFullPath($LauncherPath)
        WORKBUDDY_CODEBUDDY_SCRIPT = [IO.Path]::GetFullPath($CodeBuddyPath)
        WORKBUDDY_CONFIG_DIR = $configDirectory
        WORKBUDDY_DATA_FOLDER_NAME = '.workbuddy-ai'
        WORKBUDDY_NODE_BIN = [IO.Path]::GetFullPath($NodePath)
    }
    foreach ($name in 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY') {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $uri = $null
            if ([Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -and
                $uri.IsLoopback -and
                [string]::IsNullOrEmpty($uri.UserInfo) -and
                ($uri.AbsolutePath -eq '/') -and
                [string]::IsNullOrEmpty($uri.Query) -and
                [string]::IsNullOrEmpty($uri.Fragment)) {
                $environment[$name] = $value
            }
        }
    }
    return $environment
}

function Read-McpResponse {
    param(
        [Parameter(Mandatory)][Diagnostics.Process]$Process,
        [Parameter(Mandatory)][int]$Id,
        [Parameter(Mandatory)][Diagnostics.Stopwatch]$Stopwatch,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [Parameter(Mandatory)][ref]$ReadTask,
        [Parameter(Mandatory)][Threading.Tasks.Task[string]]$ErrorTask
    )
    while ($Stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if ($ReadTask.Value.Wait(100)) {
            $line = $ReadTask.Value.Result
            if ($null -eq $line) {
                throw "MCP server stdout closed before response $Id. stderr: $($ErrorTask.Result)"
            }
            $ReadTask.Value = $Process.StandardOutput.ReadLineAsync()
            try { $message = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
            if ($message.id -eq $Id) {
                if ($null -ne $message.PSObject.Properties['error']) {
                    throw "MCP response $Id failed: $($message.error | ConvertTo-Json -Compress)"
                }
                return $message
            }
        }
        if ($Process.HasExited) {
            throw "MCP server exited with code $($Process.ExitCode). stderr: $($ErrorTask.Result)"
        }
    }
    throw "MCP response $Id timed out after $TimeoutSeconds seconds."
}

function Invoke-McpSmokeTest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$ServerPath,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Environment,
        [int]$TimeoutSeconds = 30
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = [IO.Path]::GetFullPath($NodePath)
    $startInfo.Arguments = ConvertTo-WindowsCommandLine @([IO.Path]::GetFullPath($ServerPath))
    $startInfo.WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($key in $Environment.Keys) {
        $startInfo.EnvironmentVariables[[string]$key] = [string]$Environment[$key]
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'MCP server process did not start.' }
        $errorTask = $process.StandardError.ReadToEndAsync()
        $readTask = $process.StandardOutput.ReadLineAsync()
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $initialize = [ordered]@{
            jsonrpc = '2.0'
            id = 1
            method = 'initialize'
            params = [ordered]@{
                protocolVersion = '2025-06-18'
                capabilities = @{}
                clientInfo = @{ name = 'workbuddy-portable-setup'; version = '1.0.0' }
            }
        } | ConvertTo-Json -Compress -Depth 8
        $process.StandardInput.WriteLine($initialize)
        $process.StandardInput.Flush()
        $initializeResponse = Read-McpResponse -Process $process -Id 1 -Stopwatch $stopwatch `
            -TimeoutSeconds $TimeoutSeconds -ReadTask ([ref]$readTask) -ErrorTask $errorTask

        $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}')
        $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
        $process.StandardInput.Flush()
        $toolsResponse = Read-McpResponse -Process $process -Id 2 -Stopwatch $stopwatch `
            -TimeoutSeconds $TimeoutSeconds -ReadTask ([ref]$readTask) -ErrorTask $errorTask
        $toolNames = @($toolsResponse.result.tools | ForEach-Object name | Sort-Object)
        if (($toolNames -join ',') -ne ($script:ExpectedTools -join ',')) {
            throw "tools/list returned an unexpected set: $($toolNames -join ', ')"
        }
        return [pscustomobject]@{
            Initialize = $true
            ToolsList = $true
            ToolNames = $toolNames
            ServerName = $initializeResponse.result.serverInfo.name
            ServerVersion = $initializeResponse.result.serverInfo.version
        }
    } finally {
        if ($process.Id -ne 0 -and -not $process.HasExited) {
            $process.StandardInput.Close()
            if (-not $process.WaitForExit(10000)) {
                & taskkill /pid $process.Id /t /f 2>$null | Out-Null
            }
        }
        $process.Dispose()
    }
}

function Get-TomlSectionData {
    param([string]$ConfigPath, [string]$SectionName)
    $result = [ordered]@{}
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $result }
    $active = $false
    foreach ($line in [IO.File]::ReadAllLines($ConfigPath)) {
        if ($line -match '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
            $active = $Matches[1].Trim() -eq $SectionName
            continue
        }
        if (-not $active -or $line -notmatch '^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$') { continue }
        $key = $Matches[1]
        $raw = $Matches[2]
        try {
            if ($raw -eq 'true') { $value = $true }
            elseif ($raw -eq 'false') { $value = $false }
            elseif ($raw -match '^\d+$') { $value = [int]$raw }
            else { $value = $raw | ConvertFrom-Json -ErrorAction Stop }
            $result[$key] = $value
        } catch {
            $result[$key] = $raw
        }
    }
    return $result
}

function Test-SdkResolvable([string]$NodePath, [string]$PluginRoot) {
    if (-not (Test-Path -LiteralPath (Join-Path $PluginRoot 'node_modules\@modelcontextprotocol\sdk'))) {
        return $false
    }
    $packagePath = Join-Path $PluginRoot 'package.json'
    & $NodePath -e "const {createRequire}=require('node:module'); createRequire(process.argv[1]).resolve('@modelcontextprotocol/sdk/server/mcp.js')" $packagePath 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Get-WorkBuddyDoctorReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$PluginRoot,
        [string]$CodexHome = (Get-DefaultCodexHome),
        [string]$CodeBuddyPath,
        [string]$WorkBuddyConfigDir
    )

    $root = [IO.Path]::GetFullPath($PluginRoot)
    $configHome = [IO.Path]::GetFullPath($CodexHome)
    $configPath = Join-Path $configHome 'config.toml'
    $serverPath = Join-Path $root 'lib\server.js'
    $nodeModules = Test-Path -LiteralPath (Join-Path $root 'node_modules') -PathType Container
    $buildOutput = Test-Path -LiteralPath $serverPath -PathType Leaf
    $issues = [Collections.Generic.List[string]]::new()
    $recommendations = [Collections.Generic.List[string]]::new()
    try { $nodePath = Get-NodeExecutable } catch { $nodePath = $null; $issues.Add($_.Exception.Message) }
    $sdkResolvable = $false
    if ($null -ne $nodePath) { $sdkResolvable = Test-SdkResolvable $nodePath $root }
    if (-not $nodeModules) { $issues.Add('node_modules is missing.') }
    if (-not $buildOutput) { $issues.Add('lib/server.js is missing.') }
    if (-not $sdkResolvable) { $issues.Add('@modelcontextprotocol/sdk is not resolvable.') }

    $mcp = Get-TomlSectionData $configPath 'mcp_servers.workbuddy'
    $mcpEnvironment = Get-TomlSectionData $configPath 'mcp_servers.workbuddy.env'
    $configuredArgs = @($mcp.args)
    $mcpEnabled = $mcp.Count -gt 0 -and (-not $mcp.Contains('enabled') -or [bool]$mcp.enabled)
    if ($mcp.Count -eq 0) {
        $issues.Add('The workbuddy MCP configuration is missing.')
    } elseif ($configuredArgs.Count -eq 0 -or
        [IO.Path]::GetFullPath([string]$configuredArgs[0]) -ne [IO.Path]::GetFullPath($serverPath) -or
        -not $mcp.Contains('cwd') -or
        [IO.Path]::GetFullPath([string]$mcp.cwd) -ne $root) {
        $issues.Add('The workbuddy MCP configuration contains an old or mismatched plugin path.')
    }
    if ($mcp.Count -gt 0 -and -not $mcpEnabled) {
        $issues.Add('The workbuddy MCP configuration is disabled.')
    }

    $duplicate = Join-Path (Split-Path -Parent $root) 'packages\workbuddy-control'
    if (Test-Path -LiteralPath $duplicate) {
        $issues.Add("An old workbuddy-control directory exists: $duplicate")
    }

    try {
        $resolvedCodeBuddy = Find-CodeBuddy -ExplicitPath $CodeBuddyPath
    } catch {
        $resolvedCodeBuddy = $null
        $issues.Add($_.Exception.Message)
    }
    if ([string]::IsNullOrWhiteSpace($WorkBuddyConfigDir)) {
        $WorkBuddyConfigDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.workbuddy-ai'
    }
    $resolvedWorkBuddyConfig = [IO.Path]::GetFullPath($WorkBuddyConfigDir)
    if (-not (Test-Path -LiteralPath $resolvedWorkBuddyConfig -PathType Container)) {
        $issues.Add("WorkBuddy configuration directory is missing: $resolvedWorkBuddyConfig")
    }

    $initialize = $false
    $toolsList = $false
    $toolNames = @()
    if ($null -ne $nodePath -and $sdkResolvable -and $buildOutput -and $mcpEnabled -and $mcpEnvironment.Count -gt 0) {
        try {
            $commandPath = if ([IO.Path]::IsPathRooted([string]$mcp.command)) {
                [string]$mcp.command
            } else {
                (Get-Command ([string]$mcp.command) -ErrorAction Stop).Source
            }
            $smoke = Invoke-McpSmokeTest -NodePath $commandPath -ServerPath ([string]$configuredArgs[0]) `
                -WorkingDirectory ([string]$mcp.cwd) -Environment $mcpEnvironment
            $initialize = $smoke.Initialize
            $toolsList = $smoke.ToolsList
            $toolNames = $smoke.ToolNames
        } catch {
            $issues.Add("MCP smoke test failed: $($_.Exception.Message)")
        }
    }

    if ($issues.Count -gt 0) {
        $recommendations.Add("Run $(Join-Path $root 'scripts\setup.ps1') to repair the reported setup issues.")
    }
    return [pscustomobject]@{
        PluginPath = $root
        NodeModules = $nodeModules
        BuildOutput = $buildOutput
        SdkResolvable = $sdkResolvable
        CodeBuddyPath = $resolvedCodeBuddy
        CodeBuddyVersion = if ($null -ne $nodePath -and $null -ne $resolvedCodeBuddy) { Get-CodeBuddyVersion $nodePath $resolvedCodeBuddy } else { $null }
        WorkBuddyConfigDir = $resolvedWorkBuddyConfig
        CodexConfigPath = $configPath
        McpCommand = $mcp.command
        McpArgs = $configuredArgs
        McpCwd = $mcp.cwd
        McpEnvironment = $mcpEnvironment
        Initialize = $initialize
        ToolsList = $toolsList
        ToolNames = $toolNames
        Issues = @($issues)
        Recommendations = @($recommendations)
    }
}

function Invoke-WorkBuddySetup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$PluginRoot,
        [string]$CodexHome = (Get-DefaultCodexHome),
        [string]$CodeBuddyPath,
        [string]$WorkBuddyConfigDir
    )

    $root = [IO.Path]::GetFullPath($PluginRoot)
    $nodePath = Get-NodeExecutable
    Write-Output "Node: PASS ($(& $nodePath --version))"
    $pnpm = Get-PnpmInvocation
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $corepack) {
        Write-Output 'corepack: SKIP (pnpm is installed directly)'
    } else {
        Write-Output "corepack: PASS ($(& $corepack.Source --version))"
    }
    Write-Output "pnpm: PASS ($(& $pnpm.FilePath @($pnpm.Prefix + '--version')))"

    Invoke-CheckedCommand -FilePath $pnpm.FilePath -Arguments @($pnpm.Prefix + @('install', '--frozen-lockfile')) `
        -WorkingDirectory $root -Label 'pnpm install --frozen-lockfile'
    Write-Output 'install: PASS'
    Invoke-CheckedCommand -FilePath $pnpm.FilePath -Arguments @($pnpm.Prefix + @('build')) `
        -WorkingDirectory $root -Label 'pnpm build'
    Write-Output 'build: PASS'

    $resolvedCodeBuddy = Find-CodeBuddy -ExplicitPath $CodeBuddyPath
    Write-Output "codebuddy: PASS ($resolvedCodeBuddy)"
    if ([string]::IsNullOrWhiteSpace($WorkBuddyConfigDir)) {
        $WorkBuddyConfigDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.workbuddy-ai'
    }
    $resolvedConfigDir = [IO.Path]::GetFullPath($WorkBuddyConfigDir)
    if (-not (Test-Path -LiteralPath $resolvedConfigDir -PathType Container)) {
        throw "WorkBuddy configuration directory was not found: $resolvedConfigDir"
    }
    Write-Output "WorkBuddy config: PASS ($resolvedConfigDir)"

    $resolvedCodexHome = [IO.Path]::GetFullPath($CodexHome)
    $launcher = New-WorkBuddyLauncher -CodexHome $resolvedCodexHome
    $environment = Get-WorkBuddyEnvironment -NodePath $nodePath -CodeBuddyPath $resolvedCodeBuddy `
        -WorkBuddyConfigDir $resolvedConfigDir -LauncherPath $launcher
    $serverPath = Join-Path $root 'lib\server.js'
    $configPath = Join-Path $resolvedCodexHome 'config.toml'
    Set-WorkBuddyMcpConfig -ConfigPath $configPath -NodePath $nodePath -ServerPath $serverPath `
        -PluginRoot $root -Environment $environment
    Write-Output "Codex config: PASS ($configPath)"

    $smoke = Invoke-McpSmokeTest -NodePath $nodePath -ServerPath $serverPath `
        -WorkingDirectory $root -Environment $environment
    Write-Output "initialize: PASS ($($smoke.ServerName) $($smoke.ServerVersion))"
    Write-Output "tools/list: PASS ($($smoke.ToolNames -join ', '))"
    Write-Output 'Setup complete. Fully restart Codex to load the workbuddy MCP tools.'
    return $smoke
}

Export-ModuleMember -Function @(
    'Find-CodeBuddy',
    'Get-DefaultCodexHome',
    'Get-WorkBuddyDoctorReport',
    'Get-WorkBuddyEnvironment',
    'Invoke-McpSmokeTest',
    'Invoke-WorkBuddySetup',
    'New-WorkBuddyLauncher',
    'Remove-WorkBuddyLauncher',
    'Remove-WorkBuddyMcpConfig',
    'Set-WorkBuddyMcpConfig'
)
