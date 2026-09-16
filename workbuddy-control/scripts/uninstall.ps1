[CmdletBinding()]
param(
    [string]$CodexHome,
    [string]$DesktopExtensionRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WorkBuddyPortable.psm1') -Force
if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = Get-DefaultCodexHome
}
$resolvedCodexHome = [IO.Path]::GetFullPath($CodexHome)
$configPath = Join-Path $resolvedCodexHome 'config.toml'
Remove-WorkBuddyMcpConfig -ConfigPath $configPath

Remove-WorkBuddyLauncher -CodexHome $resolvedCodexHome

$extensionParameters = @{}
if ($PSBoundParameters.ContainsKey('DesktopExtensionRoot')) {
    $extensionParameters.DesktopExtensionRoot = $DesktopExtensionRoot
}
Remove-WorkBuddyDesktopExtension @extensionParameters

Write-Output "Removed workbuddy MCP configuration from $configPath"
Write-Output 'Removed the owned WorkBuddy Desktop Extension when present.'
Write-Output 'Repository source and WorkBuddy were not modified.'
