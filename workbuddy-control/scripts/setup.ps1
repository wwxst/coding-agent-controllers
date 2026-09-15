[CmdletBinding()]
param(
    [string]$CodexHome,
    [string]$CodeBuddyPath,
    [string]$WorkBuddyConfigDir
)

$ErrorActionPreference = 'Stop'
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Import-Module (Join-Path $PSScriptRoot 'WorkBuddyPortable.psm1') -Force

$parameters = @{ PluginRoot = $pluginRoot }
if ($PSBoundParameters.ContainsKey('CodexHome')) { $parameters.CodexHome = $CodexHome }
if ($PSBoundParameters.ContainsKey('CodeBuddyPath')) { $parameters.CodeBuddyPath = $CodeBuddyPath }
if ($PSBoundParameters.ContainsKey('WorkBuddyConfigDir')) { $parameters.WorkBuddyConfigDir = $WorkBuddyConfigDir }

Invoke-WorkBuddySetup @parameters
