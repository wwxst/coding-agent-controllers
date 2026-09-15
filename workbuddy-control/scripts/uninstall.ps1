[CmdletBinding()]
param([string]$CodexHome)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WorkBuddyPortable.psm1') -Force
if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = Get-DefaultCodexHome
}
$resolvedCodexHome = [IO.Path]::GetFullPath($CodexHome)
$configPath = Join-Path $resolvedCodexHome 'config.toml'
Remove-WorkBuddyMcpConfig -ConfigPath $configPath

Remove-WorkBuddyLauncher -CodexHome $resolvedCodexHome

Write-Output "Removed workbuddy MCP configuration from $configPath"
Write-Output 'Repository source and WorkBuddy were not modified.'
