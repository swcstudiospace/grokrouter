# GrokRouter source installer for Windows 10/11 (x64 or Arm64).
#
# Pinned one-liner (runs in a child PowerShell, so nothing persists):
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/swcstudiospace/grokrouter/source-v0.1.0-beta.48/scripts/install-windows.ps1 | iex"
#
# It must also run from a checkout (-File) and through `irm | iex`, so it takes
# no param block and reads optional settings from the environment:
#   GROKROUTER_NO_OPEN=1        do not launch GrokRouter after installing
#   GROKROUTER_INSTALL_DIR=...  install somewhere other than %LOCALAPPDATA%\Programs\GrokRouter
# The body runs in a child scope so `irm | iex` in an open window does not leak
# strict mode or preference changes into the caller's session.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Set-StrictMode -Version Latest

    $Repository = 'swcstudiospace/grokrouter'
    $SourceRef = 'source-v0.1.0-beta.48'
    $MinimumNode = [version]'22.12.0'

    function Stop-Install([string]$Reason) {
        throw [System.InvalidOperationException]::new($Reason)
    }

    function Get-WindowsArchitecture {
        # The machine environment holds the native value even when this shell is
        # an x64 process emulated on Arm64, where PROCESSOR_ARCHITECTURE says AMD64.
        $native = $null
        try {
            $native = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
        } catch {
            $native = $null
        }
        if (-not $native) {
            $native = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        }
        if (-not $native) {
            $native = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
        }
        switch -Regex ($native) {
            '^(AMD64|X64)$' { return 'x64' }
            '^ARM64$' { return 'arm64' }
            default { Stop-Install "GrokRouter supports 64-bit Windows on x64 or Arm64 only (this computer reports '$native')" }
        }
    }

    function Get-NodeVersion {
        $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) { return $null }
        $text = (& $node.Path -p 'process.versions.node' | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $text -notmatch '^\d+\.\d+\.\d+$') { return $null }
        return [version]$text
    }

    function Find-GitBash {
        # Git for Windows' bin\bash.exe sets up the MSYS PATH (sha256sum, find,
        # tar) the build needs. System32\bash.exe is WSL and would build in Linux.
        $roots = New-Object System.Collections.Generic.List[string]
        $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($git) {
            $directory = Split-Path -Parent $git.Path
            for ($level = 0; $level -lt 3 -and $directory; $level++) {
                $roots.Add($directory)
                $directory = Split-Path -Parent $directory
            }
        }
        foreach ($key in @('HKCU:\SOFTWARE\GitForWindows', 'HKLM:\SOFTWARE\GitForWindows')) {
            $installed = Get-ItemProperty -LiteralPath $key -Name InstallPath -ErrorAction SilentlyContinue
            if ($installed) { $roots.Add([string]$installed.InstallPath) }
        }
        foreach ($base in @($env:ProgramW6432, $env:ProgramFiles, $env:LOCALAPPDATA)) {
            if ($base) {
                $roots.Add((Join-Path $base 'Git'))
                $roots.Add((Join-Path $base 'Programs\Git'))
            }
        }
        $systemRoot = if ($env:SystemRoot) { $env:SystemRoot.TrimEnd('\') + '\' } else { 'C:\Windows\' }
        foreach ($root in $roots) {
            $candidate = Join-Path $root 'bin\bash.exe'
            if ((Test-Path -LiteralPath $candidate -PathType Leaf) `
                -and (Test-Path -LiteralPath (Join-Path $root 'usr\bin') -PathType Container) `
                -and -not $candidate.StartsWith($systemRoot, [StringComparison]::OrdinalIgnoreCase)) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
        return $null
    }

    function Test-SourceRoot([string]$Root) {
        return $Root `
            -and (Test-Path -LiteralPath (Join-Path $Root 'scripts\build-windows-app.sh') -PathType Leaf) `
            -and (Test-Path -LiteralPath (Join-Path $Root 'installer-windows\main.cjs') -PathType Leaf)
    }

    function Stop-InstalledGrokRouter([string]$Directory) {
        $prefix = $Directory.TrimEnd('\') + '\'
        $running = @(Get-Process -Name GrokRouter -ErrorAction SilentlyContinue | Where-Object {
                $path = $null
                try { $path = $_.Path } catch { $path = $null }
                $path -and $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
            })
        if ($running.Count -eq 0) { return }
        Write-Host 'Closing the running GrokRouter...'
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
        $running | Wait-Process -Timeout 20 -ErrorAction SilentlyContinue
    }

    $temporary = $null
    $previousAppOnly = $env:ROUTER_BUILD_APP_ONLY
    $exitCode = 0
    try {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or [Environment]::OSVersion.Version.Major -lt 10) {
            Stop-Install 'this installer supports Windows 10 and Windows 11 only'
        }
        $architecture = Get-WindowsArchitecture

        $missing = New-Object System.Collections.Generic.List[string]
        $nodeVersion = Get-NodeVersion
        if (-not $nodeVersion -or $nodeVersion -lt $MinimumNode -or -not (Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue)) {
            $found = if ($nodeVersion) { "found $nodeVersion" } else { 'not found' }
            $missing.Add("Node.js $MinimumNode or newer with npm ($found):  winget install --exact --id OpenJS.NodeJS.LTS")
        }
        $bash = Find-GitBash
        if (-not $bash) {
            $missing.Add('Git for Windows (provides the bash used by the build):  winget install --exact --id Git.Git')
        }
        if ($missing.Count -gt 0) {
            Write-Host ''
            Write-Host 'GrokRouter is built locally from source and needs these free tools first:'
            foreach ($line in $missing) { Write-Host "  - $line" }
            Write-Host 'Install them, close this window, then run the GrokRouter command again in a new PowerShell window.'
            Stop-Install 'required build tools are missing'
        }

        $installDir = if ($env:GROKROUTER_INSTALL_DIR) { $env:GROKROUTER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\GrokRouter' }
        $installDir = [IO.Path]::GetFullPath($installDir).TrimEnd('\')
        $installParent = Split-Path -Parent $installDir
        $installLeaf = Split-Path -Leaf $installDir
        if (Test-Path -LiteralPath (Join-Path $installDir 'unins000.exe')) {
            # Moving a setup.exe install would orphan its Settings > Apps entry.
            Stop-Install 'GrokRouter was installed by its Windows setup program; uninstall it from Settings > Apps first'
        }
        # A user-chosen directory is only replaced when it already holds GrokRouter;
        # anything else is left alone rather than renamed and later pruned.
        if ((Test-Path -LiteralPath $installDir) -and
            -not (Test-Path -LiteralPath (Join-Path $installDir 'GrokRouter.exe') -PathType Leaf) -and
            (Get-ChildItem -LiteralPath $installDir -Force | Select-Object -First 1)) {
            Stop-Install "$installDir already exists and is not a GrokRouter install; choose an empty or new folder"
        }

        $sourceRoot = $null
        if ($PSScriptRoot) {
            $checkout = Split-Path -Parent $PSScriptRoot
            if (Test-SourceRoot $checkout) { $sourceRoot = (Resolve-Path -LiteralPath $checkout).Path }
        }
        if (-not $sourceRoot) {
            # Short name: Electron's node_modules paths are deep and PowerShell 5.1
            # still honours MAX_PATH.
            $temporary = Join-Path ([IO.Path]::GetTempPath()) ('grokrouter-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path $temporary | Out-Null
            $archive = Join-Path $temporary 'source.zip'
            $url = "https://github.com/$Repository/archive/refs/tags/$SourceRef.zip"
            # Process-scoped only; older .NET defaults can still offer TLS 1.0.
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Write-Host 'Downloading GrokRouter source from GitHub...'
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
            } catch {
                Stop-Install "could not download $url ($($_.Exception.Message))"
            }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($archive, $temporary)
            $extracted = @(Get-ChildItem -LiteralPath $temporary -Directory -Filter 'grokrouter-*')
            if ($extracted.Count -eq 1 -and (Test-SourceRoot $extracted[0].FullName)) { $sourceRoot = $extracted[0].FullName }
        }
        if (-not $sourceRoot) { Stop-Install 'the source archive was incomplete' }

        Write-Host "Building GrokRouter for Windows $architecture from the version-pinned source (this downloads Electron once)..."
        $env:ROUTER_BUILD_APP_ONLY = '1'
        Push-Location -LiteralPath $sourceRoot
        # npm and the packager log progress on stderr. Windows PowerShell 5.1
        # turns that into errors when it wraps the stream, so only the exit code
        # decides success here.
        $ErrorActionPreference = 'Continue'
        try {
            & $bash 'scripts/build-windows-app.sh' $architecture | Out-Null
            $buildExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = 'Stop'
            Pop-Location
        }
        if ($buildExit -ne 0) { Stop-Install "the local build failed with exit code $buildExit; the messages above explain why" }
        $builtApp = Join-Path $sourceRoot "build\windows\GrokRouter-win32-$architecture"
        if (-not (Test-Path -LiteralPath (Join-Path $builtApp 'GrokRouter.exe') -PathType Leaf)) {
            Stop-Install 'the build did not produce GrokRouter.exe'
        }

        New-Item -ItemType Directory -Force -Path $installParent | Out-Null

        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $staging = Join-Path $installParent "$installLeaf.installing-$stamp"
        $backupName = "$installLeaf.previous-$stamp"
        $backup = Join-Path $installParent $backupName
        $hadPrevious = Test-Path -LiteralPath $installDir
        $movedPrevious = $false
        try {
            # Copy, not move: the build output may be a checkout's build folder, and
            # the temp directory can sit on a different volume from the install.
            Copy-Item -LiteralPath $builtApp -Destination $staging -Recurse
            if ($hadPrevious) {
                Stop-InstalledGrokRouter $installDir
                Move-Item -LiteralPath $installDir -Destination $backup
                $movedPrevious = $true
            }
            Move-Item -LiteralPath $staging -Destination $installDir
        } catch {
            # Any failed step leaves the previous install where it was and no staging copy.
            if ($movedPrevious -and -not (Test-Path -LiteralPath $installDir)) {
                Move-Item -LiteralPath $backup -Destination $installDir
            }
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
            throw
        }
        if ($hadPrevious) {
            Get-ChildItem -LiteralPath $installParent -Directory -Filter "$installLeaf.previous-*" |
                Where-Object { $_.Name -ne $backupName -and (Test-Path -LiteralPath (Join-Path $_.FullName 'GrokRouter.exe') -PathType Leaf) } |
                Remove-Item -Recurse -Force
            Write-Host "Kept the previous GrokRouter at $backup."
        }

        $exe = Join-Path $installDir 'GrokRouter.exe'
        # Same per-user Start Menu entry the Windows setup program creates.
        $shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'GrokRouter.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $exe
        $shortcut.WorkingDirectory = $installDir
        $shortcut.IconLocation = "$exe,0"
        $shortcut.Description = 'GrokRouter'
        $shortcut.Save()

        if ($env:GROKROUTER_NO_OPEN -ne '1') {
            Write-Host ''
            Write-Host "GrokRouter is installed in $installDir and on the Start menu. Opening it now..."
            Start-Process -FilePath $exe -WorkingDirectory $installDir
        } else {
            Write-Host ''
            Write-Host "GrokRouter is installed in $installDir."
        }
    } catch {
        [Console]::Error.WriteLine('')
        [Console]::Error.WriteLine("GrokRouter could not be installed: $($_.Exception.Message)")
        $exitCode = 1
    } finally {
        $env:ROUTER_BUILD_APP_ONLY = $previousAppOnly
        if ($temporary -and (Test-Path -LiteralPath $temporary)) {
            Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if ($exitCode -ne 0) {
        # `exit` would close an interactive window that ran `irm ... | iex`
        # before the reason above could be read; throwing still fails the
        # `powershell -Command` one-liner with exit code 1.
        if ($PSCommandPath) { exit $exitCode }
        throw 'GrokRouter installation failed.'
    }
}
