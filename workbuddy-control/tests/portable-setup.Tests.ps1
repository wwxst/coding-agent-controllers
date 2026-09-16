$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $pluginRoot 'scripts\WorkBuddyPortable.psm1'
Import-Module $modulePath -Force

function New-TestDirectory([string]$Name) {
    $path = Join-Path $TestDrive $Name
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    return $path
}

function New-FakeWorkBuddy([string]$Root) {
    $bin = Join-Path $Root 'resources\app.asar.unpacked\cli\bin'
    $skills = Join-Path $Root 'resources\app.asar.unpacked\resources\plugins\workbuddy-builtin\skills'
    New-Item -ItemType Directory -Path $bin, $skills -Force | Out-Null
    $codeBuddy = Join-Path $bin 'codebuddy'
    Copy-Item (Join-Path $pluginRoot 'tests\fixtures\fake-codebuddy.mjs') $codeBuddy
    return $codeBuddy
}

Describe 'WorkBuddy portable configuration' {
    It 'imports the portable module in Windows PowerShell 5.1' {
        $windowsPowerShell = Get-Command powershell.exe -ErrorAction Stop
        $command = "`$ErrorActionPreference = 'Stop'; Import-Module '$modulePath' -Force"

        & $windowsPowerShell.Source -NoProfile -NonInteractive -Command $command

        $LASTEXITCODE | Should Be 0
    }

    It 'preserves other MCP servers and is idempotent across absolute paths' {
        $root = New-TestDirectory 'portable install with spaces'
        $config = Join-Path $root 'config.toml'
        @"
model = "gpt-test"

[mcp_servers.other]
command = "other-command"
args = ["--keep"]
"@ | Set-Content -LiteralPath $config -Encoding utf8

        $environment = [ordered]@{
            WORKBUDDY_CODEBUDDY_BIN = 'C:\Users\tester\workbuddy launcher.exe'
            WORKBUDDY_CONFIG_DIR = 'C:\Users\tester\.workbuddy-ai'
            NO_PROXY = '127.0.0.1,localhost'
        }
        Set-WorkBuddyMcpConfig -ConfigPath $config `
            -NodePath 'C:\Program Files\nodejs\node.exe' `
            -ServerPath (Join-Path $root 'lib\server.js') `
            -PluginRoot $root `
            -Environment $environment
        $first = Get-Content -Raw -LiteralPath $config

        Set-WorkBuddyMcpConfig -ConfigPath $config `
            -NodePath 'C:\Program Files\nodejs\node.exe' `
            -ServerPath (Join-Path $root 'lib\server.js') `
            -PluginRoot $root `
            -Environment $environment
        $second = Get-Content -Raw -LiteralPath $config

        $second | Should Be $first
        $second | Should Match '\[mcp_servers\.other\]'
        $second | Should Match 'command = "other-command"'
        $second | Should Match '\[mcp_servers\.workbuddy\]'
        $expectedRoot = [IO.Path]::GetFullPath($root)
        $second | Should Match ([regex]::Escape($expectedRoot.Replace('\', '\\')))
    }

    It 'removes only the workbuddy MCP configuration' {
        $config = Join-Path (New-TestDirectory 'uninstall') 'config.toml'
        @"
[mcp_servers.other]
command = "keep-me"

[mcp_servers.workbuddy]
command = "node"
args = ["C:\\old\\server.js"]

[mcp_servers.workbuddy.env]
WORKBUDDY_CONFIG_DIR = "C:\\old"

[notice]
hide = true
"@ | Set-Content -LiteralPath $config -Encoding utf8

        Remove-WorkBuddyMcpConfig -ConfigPath $config
        $contents = Get-Content -Raw -LiteralPath $config

        $contents | Should Match '\[mcp_servers\.other\]'
        $contents | Should Match 'keep-me'
        $contents | Should Match '\[notice\]'
        $contents | Should Not Match '\[mcp_servers\.workbuddy(?:\.env)?\]'
    }

    It 'preserves an unowned launcher and unrelated files during uninstall' {
        $codexHome = New-TestDirectory 'unowned launcher codex'
        $config = Join-Path $codexHome 'config.toml'
        @"
[mcp_servers.other]
command = "keep-me"

[mcp_servers.workbuddy]
command = "node"
"@ | Set-Content -LiteralPath $config -Encoding utf8
        $launcherDirectory = Join-Path $codexHome 'bin\workbuddy-control'
        New-Item -ItemType Directory -Path $launcherDirectory -Force | Out-Null
        $launcher = Join-Path $launcherDirectory 'workbuddy-codebuddy.exe'
        $unrelated = Join-Path $launcherDirectory 'user-file.txt'
        Set-Content -LiteralPath $launcher -Value 'not created by setup' -Encoding utf8
        Set-Content -LiteralPath $unrelated -Value 'keep me' -Encoding utf8
        $desktopExtensionRoot = Join-Path (New-TestDirectory 'unowned uninstall extension') `
            'workbuddy-control-desktop'
        New-Item -ItemType Directory -Path $desktopExtensionRoot -Force | Out-Null
        $extensionFile = Join-Path $desktopExtensionRoot 'user-file.txt'
        Set-Content -LiteralPath $extensionFile -Value 'keep me' -Encoding utf8

        & (Join-Path $pluginRoot 'scripts\uninstall.ps1') -CodexHome $codexHome `
            -DesktopExtensionRoot $desktopExtensionRoot | Out-Null

        (Test-Path -LiteralPath $launcher) | Should Be $true
        (Test-Path -LiteralPath $unrelated) | Should Be $true
        (Test-Path -LiteralPath $extensionFile) | Should Be $true
        $contents = Get-Content -Raw -LiteralPath $config
        $contents | Should Match '\[mcp_servers\.other\]'
        $contents | Should Not Match '\[mcp_servers\.workbuddy\]'
    }

    It 'fails clearly when an explicit codebuddy path does not exist' {
        $missing = Join-Path (New-TestDirectory 'missing-codebuddy') 'codebuddy'
        $message = try {
            Find-CodeBuddy -ExplicitPath $missing | Out-Null
            ''
        } catch {
            $_.Exception.Message
        }
        $message | Should Match 'codebuddy was not found'
    }

    It 'reports stale paths and missing dependencies' {
        $root = New-TestDirectory 'doctor plugin'
        New-Item -ItemType Directory -Path (Join-Path $root 'lib') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $root 'lib\server.js') -Value '// built' -Encoding utf8
        $codexHome = New-TestDirectory 'doctor codex'
        @"
[mcp_servers.workbuddy]
command = "node"
args = ["C:\\old-copy\\workbuddy-control\\lib\\server.js"]
cwd = "C:\\old-copy\\workbuddy-control"
"@ | Set-Content -LiteralPath (Join-Path $codexHome 'config.toml') -Encoding utf8

        $report = Get-WorkBuddyDoctorReport -PluginRoot $root -CodexHome $codexHome `
            -DesktopExtensionRoot (Join-Path $codexHome 'desktop-extension') `
            -WorkBuddyConfigDir (Join-Path $codexHome 'workbuddy-config') `
            -CodeBuddyPath (Join-Path $codexHome 'missing-codebuddy')

        $report.NodeModules | Should Be $false
        $report.SdkResolvable | Should Be $false
        ($report.Issues -join "`n") | Should Match 'old or mismatched plugin path'
        ($report.Recommendations -join "`n") | Should Match 'setup.ps1'
    }

    It 'reports a disabled workbuddy MCP instead of smoke-testing it as healthy' {
        $root = New-TestDirectory 'disabled plugin'
        $codexHome = New-TestDirectory 'disabled codex'
        @"
[mcp_servers.workbuddy]
command = "node"
args = ["$(Join-Path $root 'lib\server.js')"]
cwd = "$root"
enabled = false
"@ | Set-Content -LiteralPath (Join-Path $codexHome 'config.toml') -Encoding utf8

        $report = Get-WorkBuddyDoctorReport -PluginRoot $root -CodexHome $codexHome `
            -DesktopExtensionRoot (Join-Path $codexHome 'desktop-extension') `
            -WorkBuddyConfigDir (Join-Path $codexHome 'workbuddy-config') `
            -CodeBuddyPath (Join-Path $codexHome 'missing-codebuddy')

        ($report.Issues -join "`n") | Should Match 'disabled'
        $report.Initialize | Should Be $false
        $report.ToolsList | Should Be $false
    }

    It 'does not persist proxy URLs that may contain credentials' {
        $workBuddyRoot = New-TestDirectory 'proxy WorkBuddy install'
        $codeBuddy = New-FakeWorkBuddy $workBuddyRoot
        $workBuddyConfig = New-TestDirectory 'proxy workbuddy config'
        New-Item -ItemType Directory -Path (Join-Path $workBuddyConfig 'cache') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $workBuddyConfig 'cache\acc-product-config-v3.json') `
            -Value '{"environment":"test"}' -Encoding utf8
        $launcher = Join-Path (New-TestDirectory 'proxy launcher') 'workbuddy-codebuddy.exe'
        Set-Content -LiteralPath $launcher -Value 'launcher' -Encoding utf8
        $node = (Get-Command node -ErrorAction Stop).Source
        $savedProxy = $env:HTTPS_PROXY
        try {
            $env:HTTPS_PROXY = 'https://proxy.example/path?token=secret'

            $environment = Get-WorkBuddyEnvironment -NodePath $node -CodeBuddyPath $codeBuddy `
                -WorkBuddyConfigDir $workBuddyConfig -LauncherPath $launcher

            $environment.Contains('HTTPS_PROXY') | Should Be $false
        } finally {
            $env:HTTPS_PROXY = $savedProxy
        }
    }

    It 'reads existing single-quoted Codex MCP paths' {
        $root = New-TestDirectory 'single quoted plugin'
        $codexHome = New-TestDirectory 'single quoted codex'
        $serverPath = Join-Path $root 'lib\server.js'
        New-Item -ItemType Directory -Path (Split-Path -Parent $serverPath) -Force | Out-Null
        Set-Content -LiteralPath $serverPath -Value '// built' -Encoding utf8
        $escapedServer = $serverPath.Replace('\', '\\')
        $escapedRoot = $root.Replace('\', '\\')
        @"
[mcp_servers.workbuddy]
command = 'node'
args = ['$escapedServer']
cwd = '$escapedRoot'
"@ | Set-Content -LiteralPath (Join-Path $codexHome 'config.toml') -Encoding utf8

        $report = Get-WorkBuddyDoctorReport -PluginRoot $root -CodexHome $codexHome `
            -DesktopExtensionRoot (Join-Path $codexHome 'desktop-extension') `
            -WorkBuddyConfigDir (Join-Path $codexHome 'workbuddy-config') `
            -CodeBuddyPath (Join-Path $codexHome 'missing-codebuddy')

        ($report.Issues -join "`n") | Should Not Match 'old or mismatched plugin path'
        $report.McpArgs[0] | Should Be $serverPath
        $report.McpCwd | Should Be $root
    }
}

Describe 'WorkBuddy Desktop Extension installation' {
    It 'installs the owned bridge without writing to the WorkBuddy program directory' {
        $extensionRoot = Join-Path (New-TestDirectory 'desktop extensions') 'workbuddy-control-desktop'
        $codeBuddy = New-FakeWorkBuddy (New-TestDirectory 'desktop install WorkBuddy')
        Mock Get-WorkBuddyVersion { '5.5.2' } -ModuleName WorkBuddyPortable

        Install-WorkBuddyDesktopExtension -PluginRoot $pluginRoot -DesktopExtensionRoot $extensionRoot `
            -CodeBuddyPath $codeBuddy

        (Test-Path -LiteralPath (Join-Path $extensionRoot 'extension.json')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $extensionRoot 'distribution.json')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $extensionRoot 'server\index.cjs')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $extensionRoot 'server\pipe-security.ps1')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $extensionRoot 'server\pipe-server.ps1')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $extensionRoot '.workbuddy-control-owned')) | Should Be $true
    }

    It 'removes only an owned Desktop Extension directory' {
        $owned = Join-Path (New-TestDirectory 'owned desktop extensions') 'workbuddy-control-desktop'
        $codeBuddy = New-FakeWorkBuddy (New-TestDirectory 'owned desktop WorkBuddy')
        Mock Get-WorkBuddyVersion { '5.5.2' } -ModuleName WorkBuddyPortable
        Install-WorkBuddyDesktopExtension -PluginRoot $pluginRoot -DesktopExtensionRoot $owned `
            -CodeBuddyPath $codeBuddy
        Remove-WorkBuddyDesktopExtension -DesktopExtensionRoot $owned
        (Test-Path -LiteralPath $owned) | Should Be $false

        $unowned = Join-Path (New-TestDirectory 'unowned desktop extensions') 'workbuddy-control-desktop'
        New-Item -ItemType Directory -Path $unowned -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $unowned 'user-file.txt') -Value 'keep me' -Encoding utf8
        Remove-WorkBuddyDesktopExtension -DesktopExtensionRoot $unowned
        (Test-Path -LiteralPath (Join-Path $unowned 'user-file.txt')) | Should Be $true
    }

    It 'reports Extension, Pipe, Desktop version, and Desktop tool verification separately' {
        Mock Get-WorkBuddyVersion { '5.5.2' } -ModuleName WorkBuddyPortable
        Mock Invoke-WorkBuddyDesktopPipePing {
            [pscustomobject]@{ extensionVersion = '0.1.0' }
        } -ModuleName WorkBuddyPortable
        $root = New-TestDirectory 'desktop doctor plugin'
        New-Item -ItemType Directory -Path (Join-Path $root 'lib') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $root 'node_modules\@modelcontextprotocol\sdk') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $root 'lib\server.js') -Value '// built' -Encoding utf8
        $codexHome = New-TestDirectory 'desktop doctor codex'
        $codeBuddy = New-FakeWorkBuddy (New-TestDirectory 'desktop doctor WorkBuddy')
        $workBuddyConfig = New-TestDirectory 'desktop doctor config'
        $extensionRoot = Join-Path (New-TestDirectory 'desktop doctor extensions') 'workbuddy-control-desktop'
        Install-WorkBuddyDesktopExtension -PluginRoot $pluginRoot -DesktopExtensionRoot $extensionRoot `
            -CodeBuddyPath $codeBuddy
        Mock Get-WorkBuddyVersion { '5.5.3' } -ModuleName WorkBuddyPortable

        $report = Get-WorkBuddyDoctorReport -PluginRoot $root -CodexHome $codexHome `
            -CodeBuddyPath $codeBuddy -WorkBuddyConfigDir $workBuddyConfig `
            -DesktopExtensionRoot $extensionRoot

        $report.DesktopExtension | Should Be $true
        $report.DesktopPipe | Should Be $true
        $report.WorkBuddyVersion | Should Be '5.5.3'
        $report.WorkBuddyVersionVerified | Should Be $false
        ($report.Issues -join "`n") | Should Match 'only supports WorkBuddy Desktop 5.5.2'
        $report.DesktopTools | Should Be $false
    }

    It 'does not install the optional Desktop Extension during standard Jobs setup' {
        $setupContents = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot 'scripts\setup.ps1')
        $moduleContents = Get-Content -Raw -LiteralPath $modulePath

        $setupContents | Should Match '\[switch\]\$EnableDesktopMode'
        $moduleContents | Should Match 'if \(\$EnableDesktopMode\)'
    }

    It 'rejects Desktop Extension installation unless WorkBuddy Desktop is exactly 5.5.2' {
        Mock Get-WorkBuddyVersion { '5.5.3' } -ModuleName WorkBuddyPortable
        $extensionRoot = Join-Path (New-TestDirectory 'wrong version extensions') 'workbuddy-control-desktop'
        $codeBuddy = New-FakeWorkBuddy (New-TestDirectory 'wrong version WorkBuddy')

        $message = try {
            Install-WorkBuddyDesktopExtension -PluginRoot $pluginRoot -DesktopExtensionRoot $extensionRoot `
                -CodeBuddyPath $codeBuddy
            ''
        } catch {
            $_.Exception.Message
        }
        $message | Should Match 'only supports WorkBuddy Desktop 5\.5\.2'
        (Test-Path -LiteralPath $extensionRoot) | Should Be $false
    }
}

Describe 'WorkBuddy portable setup end to end' {
    It 'restores dependencies, builds, preserves config, and completes MCP initialize and tools/list' {
        Mock Get-Command { $null } -ModuleName WorkBuddyPortable -ParameterFilter { $Name -eq 'corepack' }
        Mock Import-Module {}
        $copyRoot = New-TestDirectory 'cloned repository path with spaces'
        foreach ($file in 'package.json', 'pnpm-lock.yaml', 'tsconfig.json') {
            Copy-Item (Join-Path $pluginRoot $file) $copyRoot
        }
        Copy-Item (Join-Path $pluginRoot 'src') $copyRoot -Recurse
        Copy-Item (Join-Path $pluginRoot 'scripts') $copyRoot -Recurse
        Copy-Item (Join-Path $pluginRoot 'desktop-extension') $copyRoot -Recurse

        $workBuddyRoot = New-TestDirectory 'fake WorkBuddy install'
        $codeBuddy = New-FakeWorkBuddy $workBuddyRoot
        $workBuddyConfig = New-TestDirectory 'workbuddy user config'
        New-Item -ItemType Directory -Path (Join-Path $workBuddyConfig 'cache') -Force | Out-Null
        $largeProductConfig = '{"payload":"' + ('x' * 400000) + '"}'
        [IO.File]::WriteAllText(
            (Join-Path $workBuddyConfig 'cache\acc-product-config-v3.json'),
            $largeProductConfig,
            [Text.UTF8Encoding]::new($false)
        )

        $codexHome = New-TestDirectory 'codex home'
        $desktopExtensionRoot = Join-Path (New-TestDirectory 'desktop extension home') 'workbuddy-control-desktop'
        @"
[mcp_servers.other]
command = "keep-me"
"@ | Set-Content -LiteralPath (Join-Path $codexHome 'config.toml') -Encoding utf8

        $setup = Join-Path $copyRoot 'scripts\setup.ps1'
        $output = & $setup -CodexHome $codexHome -CodeBuddyPath $codeBuddy `
            -WorkBuddyConfigDir $workBuddyConfig -DesktopExtensionRoot $desktopExtensionRoot 6>&1 | Out-String
        $firstConfig = Get-Content -Raw -LiteralPath (Join-Path $codexHome 'config.toml')
        $secondOutput = & $setup -CodexHome $codexHome -CodeBuddyPath $codeBuddy `
            -WorkBuddyConfigDir $workBuddyConfig -DesktopExtensionRoot $desktopExtensionRoot 6>&1 | Out-String
        $secondConfig = Get-Content -Raw -LiteralPath (Join-Path $codexHome 'config.toml')

        (Test-Path (Join-Path $copyRoot 'node_modules')) | Should Be $true
        (Test-Path (Join-Path $copyRoot 'lib\server.js')) | Should Be $true
        (Test-Path (Join-Path $copyRoot 'node_modules\@modelcontextprotocol\sdk')) | Should Be $true
        $output | Should Match 'initialize: PASS'
        $output | Should Match 'tools/list: PASS'
        $output | Should Match 'corepack: SKIP'
        $secondOutput | Should Match 'tools/list: PASS'
        $secondConfig | Should Be $firstConfig
        $secondConfig | Should Match '\[mcp_servers\.other\]'
        (Test-Path -LiteralPath $desktopExtensionRoot) | Should Be $false

        $launcher = Join-Path $codexHome 'bin\workbuddy-control\workbuddy-codebuddy.exe'
        $marker = Join-Path $codexHome 'bin\workbuddy-control\workbuddy-codebuddy.sha256'
        (Test-Path -LiteralPath $launcher) | Should Be $true
        (Test-Path -LiteralPath $marker) | Should Be $true
        & (Join-Path $copyRoot 'scripts\uninstall.ps1') -CodexHome $codexHome `
            -DesktopExtensionRoot $desktopExtensionRoot | Out-Null
        $uninstalledConfig = Get-Content -Raw -LiteralPath (Join-Path $codexHome 'config.toml')
        (Test-Path -LiteralPath $launcher) | Should Be $false
        (Test-Path -LiteralPath $marker) | Should Be $false
        (Test-Path -LiteralPath $desktopExtensionRoot) | Should Be $false
        $uninstalledConfig | Should Match '\[mcp_servers\.other\]'
        $uninstalledConfig | Should Not Match '\[mcp_servers\.workbuddy(?:\.env)?\]'
    }
}
