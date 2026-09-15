param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$desktopRoot = Join-Path $PSScriptRoot 'desktop'
$tauriRoot = Join-Path $desktopRoot 'src-tauri'
$tauriExecutable = Join-Path $tauriRoot 'target\debug\ethercat-workbench-desktop.exe'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'

function Stop-ProjectTauriInstance {
    param([Parameter(Mandatory)]$ProcessInfo)

    $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ParentProcessId -eq $ProcessInfo.ProcessId -and
        $_.Name -eq 'python.exe' -and
        [string]$_.CommandLine -match 'ethercat_debug_tool\.bridge'
    })
    Write-Host "清理本项目遗留的 Tauri 实例（PID $($ProcessInfo.ProcessId)）。" -ForegroundColor DarkGray
    Stop-Process -Id $ProcessInfo.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $ProcessInfo.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        if (Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue) {
            Write-Host "清理该实例遗留的 Python Bridge（PID $($child.ProcessId)）。" -ForegroundColor DarkGray
            Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-ProjectVite {
    param(
        [Parameter(Mandatory)]$ProcessInfo,
        [Parameter(Mandatory)][string]$ProjectPath,
        [Parameter(Mandatory)][array]$AllProcesses
    )

    if ($ProcessInfo.Name -ne 'node.exe') {
        return $false
    }

    $commandLine = [string]$ProcessInfo.CommandLine
    if ($commandLine.IndexOf($ProjectPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine -match '(?i)(vite|node_modules)') {
        return $true
    }

    # Vite is commonly launched with a relative script path, so confirm its
    # ownership from a descendant such as esbuild, whose command line is absolute.
    $pendingProcessIds = @($ProcessInfo.ProcessId)
    $visitedProcessIds = @{}
    while ($pendingProcessIds.Count -gt 0) {
        $processId = $pendingProcessIds[0]
        $pendingProcessIds = @($pendingProcessIds | Select-Object -Skip 1)
        if ($visitedProcessIds.ContainsKey($processId)) {
            continue
        }
        $visitedProcessIds[$processId] = $true
        foreach ($child in $AllProcesses | Where-Object { $_.ParentProcessId -eq $processId }) {
            $childCommandLine = [string]$child.CommandLine
            if ($childCommandLine.IndexOf($ProjectPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $childCommandLine -match '(?i)node_modules') {
                return $true
            }
            $pendingProcessIds += $child.ProcessId
        }
    }
    return $false
}

function Stop-ProjectVite {
    param([switch]$RejectForeignListener)

    $devPort = 1420
    $projectPath = [System.IO.Path]::GetFullPath($desktopRoot).TrimEnd('\')
    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $listeners = @(Get-NetTCPConnection -LocalPort $devPort -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $processInfo = $allProcesses | Where-Object { $_.ProcessId -eq $listener.OwningProcess } | Select-Object -First 1
        $isProjectVite = $processInfo -and (Test-ProjectVite $processInfo $projectPath $allProcesses)
        if ($isProjectVite) {
            Write-Host "清理本项目遗留的 Vite 开发服务器（PID $($listener.OwningProcess)）。" -ForegroundColor DarkGray
            Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
        } elseif ($RejectForeignListener) {
            throw "端口 $devPort 已被其他进程占用（PID $($listener.OwningProcess)）。请先停止该服务后重试。"
        }
    }
}

function Stop-ProjectDevProcesses {
    $projectPath = [System.IO.Path]::GetFullPath($desktopRoot).TrimEnd('\')
    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $projectRoots = @($allProcesses | Where-Object {
        $commandLine = [string]$_.CommandLine
        $_.ProcessId -ne $PID -and
        $commandLine.IndexOf($projectPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        ($commandLine -match '(?i)(tauri(\.js)?\s+dev|vite(\.js)?|cargo\s+run|ethercat-workbench-desktop\.exe)')
    })
    if (-not $projectRoots) {
        return
    }

    $owned = @{}
    foreach ($processInfo in $projectRoots) {
        $owned[$processInfo.ProcessId] = $processInfo
    }
    do {
        $added = $false
        foreach ($processInfo in $allProcesses) {
            if (-not $owned.ContainsKey($processInfo.ProcessId) -and $owned.ContainsKey($processInfo.ParentProcessId)) {
                $owned[$processInfo.ProcessId] = $processInfo
                $added = $true
            }
        }
    } while ($added)

    foreach ($processInfo in @($owned.Values | Sort-Object ProcessId -Descending)) {
        if (Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue) {
            Write-Host "清理本项目遗留的开发进程 $($processInfo.Name)（PID $($processInfo.ProcessId)）。" -ForegroundColor DarkGray
            Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not $Check) {
    $expectedTauriPath = [System.IO.Path]::GetFullPath($tauriExecutable)
    $projectInstances = @(Get-CimInstance Win32_Process -Filter "Name='ethercat-workbench-desktop.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and
        [System.IO.Path]::GetFullPath($_.ExecutablePath).Equals($expectedTauriPath, [System.StringComparison]::OrdinalIgnoreCase)
    })
    $responsiveInstances = @($projectInstances | Where-Object {
        $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        $process -and $process.Responding -and $process.MainWindowHandle -ne 0
    } | Sort-Object CreationDate -Descending)
    $keeper = $responsiveInstances | Select-Object -First 1
    foreach ($instance in $projectInstances) {
        if (-not $keeper -or $instance.ProcessId -ne $keeper.ProcessId) {
            Stop-ProjectTauriInstance $instance
        }
    }

    $markedBridges = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $commandLine = [string]$_.CommandLine
        $commandLine -match 'ethercat_debug_tool\.bridge' -and
        $commandLine -match '--workbench-host-root' -and
        $commandLine.IndexOf($tauriRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        (-not $keeper -or $_.ParentProcessId -ne $keeper.ProcessId)
    })
    foreach ($bridge in $markedBridges) {
        Write-Host "清理本项目遗留的 Python Bridge（PID $($bridge.ProcessId)）。" -ForegroundColor DarkGray
        Stop-Process -Id $bridge.ProcessId -Force -ErrorAction SilentlyContinue
    }

    if ($keeper) {
        Write-Host "EtherCAT Workbench 已在运行（PID $($keeper.ProcessId)），不会启动第二个实例。" -ForegroundColor Cyan
        exit 0
    }
}

if ((Test-Path $cargoBin) -and -not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $env:Path = "$cargoBin;$env:Path"
}

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
$corepackCommand = Get-Command corepack -ErrorAction SilentlyContinue
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$corepackPnpmRoot = Join-Path $env:LOCALAPPDATA 'node\corepack\v1\pnpm'
$cachedPnpm = $null
if (-not $pnpmCommand -and $nodeCommand -and $corepackCommand -and (Test-Path $corepackPnpmRoot)) {
    $cachedPnpm = Get-ChildItem $corepackPnpmRoot -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\pnpm.cjs') } |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1
}

if (-not $pnpmCommand -and -not $cachedPnpm -and -not $corepackCommand) {
    throw '未找到 pnpm 或 Corepack。请先安装 Node.js。'
}
if (-not $pnpmCommand -and -not $cachedPnpm) {
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw '未找到 Rust/Cargo。请先安装 Rust MSVC 工具链。'
}

if (-not $pnpmCommand) {
    $pnpmShimRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'EtherCATWorkbench\bin'
    $pnpmShimPath = Join-Path $pnpmShimRoot 'pnpm.cmd'
    [System.IO.Directory]::CreateDirectory($pnpmShimRoot) | Out-Null
    if ($cachedPnpm) {
        $shimCommand = '"{0}" pnpm@{1} --pm-on-fail=ignore %*' -f $corepackCommand.Source, $cachedPnpm.Name
    } else {
        $shimCommand = '"{0}" pnpm %*' -f $corepackCommand.Source
    }
    [System.IO.File]::WriteAllLines($pnpmShimPath, @('@echo off', $shimCommand), [System.Text.Encoding]::ASCII)
    $env:Path = "$pnpmShimRoot;$env:Path"
}

function Invoke-Pnpm {
    if ($pnpmCommand) {
        & $pnpmCommand.Source @args
    } elseif ($cachedPnpm) {
        & $corepackCommand.Source "pnpm@$($cachedPnpm.Name)" --pm-on-fail=ignore @args
    } else {
        & $corepackCommand.Source pnpm @args
    }
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm 命令执行失败，退出码：$LASTEXITCODE"
    }
}

if ($pnpmCommand) {
    Write-Host "使用 pnpm：$($pnpmCommand.Source)" -ForegroundColor DarkGray
} elseif ($cachedPnpm) {
    Write-Host "未找到全局 pnpm，使用本机缓存版本 $($cachedPnpm.Name)。" -ForegroundColor Cyan
} else {
    Write-Host '未找到本机 pnpm，Corepack 将下载项目所需版本，请稍候...' -ForegroundColor Cyan
}

if ($Check) {
    Invoke-Pnpm --version
    Write-Host '启动环境检查通过。' -ForegroundColor Green
    exit 0
}

Stop-ProjectVite -RejectForeignListener

Push-Location $desktopRoot
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Host '首次启动：正在安装前端依赖...' -ForegroundColor Cyan
        Invoke-Pnpm install
    }
    Invoke-Pnpm tauri:dev
} finally {
    Stop-ProjectVite
    Stop-ProjectDevProcesses
    Pop-Location
}
