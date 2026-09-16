[CmdletBinding()]
param(
    [string]$CodexHome,
    [string]$CodeBuddyPath,
    [string]$WorkBuddyConfigDir,
    [string]$DesktopExtensionRoot
)

$ErrorActionPreference = 'Stop'
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Import-Module (Join-Path $PSScriptRoot 'WorkBuddyPortable.psm1') -Force

$parameters = @{ PluginRoot = $pluginRoot }
if ($PSBoundParameters.ContainsKey('CodexHome')) { $parameters.CodexHome = $CodexHome }
if ($PSBoundParameters.ContainsKey('CodeBuddyPath')) { $parameters.CodeBuddyPath = $CodeBuddyPath }
if ($PSBoundParameters.ContainsKey('WorkBuddyConfigDir')) { $parameters.WorkBuddyConfigDir = $WorkBuddyConfigDir }
if ($PSBoundParameters.ContainsKey('DesktopExtensionRoot')) { $parameters.DesktopExtensionRoot = $DesktopExtensionRoot }
$report = Get-WorkBuddyDoctorReport @parameters

function Show-Check([string]$Name, [bool]$Passed, [object]$Value) {
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Output ("{0}: {1} ({2})" -f $Name, $status, $Value)
}

Write-Output "Plugin path: $($report.PluginPath)"
Show-Check 'node_modules' $report.NodeModules $report.NodeModules
Show-Check 'Build output' $report.BuildOutput (Join-Path $report.PluginPath 'lib\server.js')
Show-Check 'SDK resolvable' $report.SdkResolvable '@modelcontextprotocol/sdk'
if ($report.DesktopExtensionConfigured) {
    Show-Check 'Desktop Extension' $report.DesktopExtension $report.DesktopExtensionRoot
    Show-Check 'Desktop Named Pipe' $report.DesktopPipe $report.DesktopExtensionVersion
} else {
    Write-Output 'Desktop Extension: SKIP (optional Desktop Mode POC is not installed)'
    Write-Output 'Desktop Named Pipe: SKIP (optional Desktop Mode POC is not installed)'
}
if (-not $report.DesktopExtensionConfigured) {
    Write-Output 'WorkBuddy Desktop 5.5.2: SKIP (optional Desktop Mode POC is not installed)'
} elseif ($report.WorkBuddyVersion -eq 'unknown') {
    Write-Output 'WorkBuddy Desktop 5.5.2: SKIP (WorkBuddy Desktop was not resolved)'
} else {
    Show-Check 'WorkBuddy Desktop 5.5.2' $report.WorkBuddyVersionVerified $report.WorkBuddyVersion
}
Write-Output "codebuddy path: $($report.CodeBuddyPath)"
Write-Output "codebuddy version: $($report.CodeBuddyVersion)"
Write-Output "WorkBuddy config: $($report.WorkBuddyConfigDir)"
Write-Output "Codex config: $($report.CodexConfigPath)"
Write-Output "MCP command: $($report.McpCommand)"
Write-Output "MCP args: $($report.McpArgs -join ', ')"
Write-Output "MCP cwd: $($report.McpCwd)"
Write-Output 'MCP env:'
foreach ($key in @($report.McpEnvironment.Keys | Sort-Object)) {
    if ($key -match '(?i)TOKEN|COOKIE|PASSWORD|SECRET|AUTH|PROXY') {
        Write-Output "  $key=<redacted>"
    } else {
        Write-Output "  $key=$($report.McpEnvironment[$key])"
    }
}
Show-Check 'MCP initialize' $report.Initialize $report.Initialize
Show-Check 'MCP tools/list' $report.ToolsList ($report.ToolNames -join ', ')
if ($report.DesktopExtensionConfigured) {
    Show-Check 'Five Desktop tools' $report.DesktopTools $report.DesktopTools
} else {
    Write-Output 'Five Desktop tools: SKIP (optional Desktop Mode POC is not installed)'
}

if ($report.Warnings.Count -gt 0) {
    Write-Output 'Warnings:'
    $report.Warnings | ForEach-Object { Write-Output "  - $_" }
}

if ($report.Issues.Count -eq 0) {
    Write-Output 'Result: PASS - no setup issues found.'
} else {
    Write-Output 'Issues:'
    $report.Issues | ForEach-Object { Write-Output "  - $_" }
    Write-Output 'Minimal repair:'
    $report.Recommendations | ForEach-Object { Write-Output "  - $_" }
    exit 1
}
