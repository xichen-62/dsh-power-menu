# dsh-power-menu 一键安装脚本
#
# 把 dsh-power-menu 装进 DSH Desktop 的 profile，并补齐
# `dsh.profile.bundles`，让宿主半在重启后真正加载。
#
# 安装方式（自动选择）：
#   - 机器上有 git：用 `github:xichen-62/dsh-power-menu`（pnpm 的 git 依赖）
#   - 机器上没有 git：自动下载 GitHub Release 里的 .tgz，再用本地文件安装，
#     全程不调用 git（这就是 ERR_PNPM_GIT_RESOLVE_FAILED 的解法）
#
# 顺带处理两个最常见的安装问题：
#   1. 旧的 link/junction 残留会让 pnpm 报「没有写入权限」
#      （ERR_PNPM_EPERM: rename ... -> node_modules\dsh-power-menu），
#      脚本会先移除链接再安装；
#   2. 插件管理器只写 dependencies、不写 dsh.profile.bundles，
#      装完点按钮会 404，脚本会补上。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Tarball
#      强制走 tgz 安装（即使装了 git 也不用）
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Github -WritePath
#      坚持用 github: spec：没有 git 时先下载便携版 git（约 38 MB）；
#      -WritePath 才会把它写进用户 PATH（默认只对本次安装生效）
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -TgzPath .\dsh-power-menu-0.1.22.tgz
#      完全离线：手动指定本地 tgz
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Sha256 <hash>
#      手动指定安装包 SHA-256；默认会尝试 Release 的 SHA256SUMS.txt
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Mirror
#      GitHub 直连慢或不通时，改用 gh-proxy 镜像（git 和 tgz 都支持）
#
# 装完请重启 DSH Desktop。

param(
  [string]$Profile = 'desktop',
  [switch]$Mirror,
  [switch]$Tarball,
  [switch]$Github,
  [switch]$NoPathUpdate,
  [switch]$WritePath,
  [string]$TgzPath = '',
  [string]$Sha256 = '',
  [string]$Version = '0.1.22'
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-power-menu'
$releaseUrl = "https://github.com/xichen-62/dsh-power-menu/releases/download/v$Version/dsh-power-menu-$Version.tgz"
$mingitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip'

function Find-DshCli {
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd'),
    'D:\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd'
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

function Get-FileSha256($path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-TarballChecksum($path) {
  $expected = $Sha256.Trim().ToLowerInvariant()
  if ($expected.StartsWith('sha256:')) { $expected = $expected.Substring(7) }
  if ($expected -ne '') {
    $actual = Get-FileSha256 $path
    if ($actual -ne $expected) {
      Remove-Item -LiteralPath $path -Force
      throw "[$pluginName] SHA-256 不匹配：期望 $expected，实际 $actual。安装包已删除。"
    }
    Write-Host "[$pluginName] SHA-256 校验通过。" -ForegroundColor Green
    return
  }

  # No explicit hash: use the Release SHA256SUMS.txt when it exists. A missing
  # checksum file is a warning, not a silent pass.
  $checksumUrl = "https://github.com/xichen-62/dsh-power-menu/releases/download/v$Version/SHA256SUMS.txt"
  $sumsPath = Join-Path $env:TEMP ("dsh-power-menu-" + [guid]::NewGuid().ToString('N') + '-SHA256SUMS.txt')
  try {
    Invoke-WebRequest -Uri $checksumUrl -OutFile $sumsPath -UseBasicParsing
  } catch {
    Write-Host "[$pluginName] 没有取到 SHA256SUMS.txt，跳过自动校验；可用 -Sha256 手动指定。" -ForegroundColor Yellow
    return
  }

  try {
    $line = Get-Content -LiteralPath $sumsPath -Encoding UTF8 |
      Where-Object { $_ -match "dsh-power-menu-$([regex]::Escape($Version))\.tgz" } |
      Select-Object -First 1
    if (-not $line) {
      Write-Host "[$pluginName] SHA256SUMS.txt 里没有 $Version 的记录，跳过自动校验。" -ForegroundColor Yellow
      return
    }
    $expectedFromFile = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = Get-FileSha256 $path
    if ($actual -ne $expectedFromFile) {
      Remove-Item -LiteralPath $path -Force
      throw "[$pluginName] SHA-256 不匹配：期望 $expectedFromFile，实际 $actual。安装包已删除。"
    }
    Write-Host "[$pluginName] SHA-256 校验通过。" -ForegroundColor Green
  } finally {
    Remove-Item -LiteralPath $sumsPath -Force -ErrorAction SilentlyContinue
  }
}

function Save-ReleaseTarball {
  $cacheDir = Join-Path $env:LOCALAPPDATA "$pluginName\cache"
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $dest = Join-Path $cacheDir "dsh-power-menu-$Version.tgz"

  if ((Test-Path -LiteralPath $dest) -and ((Get-Item -LiteralPath $dest).Length -gt 10KB)) {
    Assert-TarballChecksum $dest
    Write-Host "[$pluginName] 使用已下载的安装包：$dest"
    return $dest
  }

  $urls = if ($Mirror) {
    @("https://gh-proxy.com/$releaseUrl")
  } else {
    @($releaseUrl, "https://gh-proxy.com/$releaseUrl")
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  [Net.ServicePointManager]::CheckCertificateRevocationList = $false
  $oldProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  $lastError = $null

  foreach ($url in $urls) {
    Write-Host "[$pluginName] 正在下载安装包（不依赖 git）：$url"
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
    try {
      Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
      if ((Get-Item -LiteralPath $dest).Length -gt 10KB) {
        Assert-TarballChecksum $dest
        $ProgressPreference = $oldProgress
        return $dest
      }
      $lastError = '下载到的文件太小，可能不是安装包'
    } catch {
      $lastError = $_.Exception.Message
    }
  }

  $ProgressPreference = $oldProgress
  throw "[$pluginName] 下载安装包失败：$lastError`n可以改用 -Mirror 走镜像，或用 -TgzPath 指定已经拷到本机的 tgz。"
}

function Ensure-PortableGit {
  $root = Join-Path $env:LOCALAPPDATA "$pluginName\mingit"
  $gitExe = Join-Path $root 'cmd\git.exe'

  if (-not (Test-Path $gitExe)) {
    Write-Host "[$pluginName] 没有 git，正在下载便携版 git（约 38 MB，只需要一次）…" -ForegroundColor Yellow
    $zip = Join-Path $env:TEMP ("mingit-" + [guid]::NewGuid().ToString('N') + '.zip')
    $urls = if ($Mirror) {
      @("https://gh-proxy.com/$mingitUrl")
    } else {
      @($mingitUrl, "https://gh-proxy.com/$mingitUrl")
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::CheckCertificateRevocationList = $false
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    $downloaded = $false
    $lastError = $null

    foreach ($url in $urls) {
      Write-Host "[$pluginName] 下载：$url"
      if (Test-Path $zip) { Remove-Item $zip -Force }
      try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        if ((Get-Item $zip).Length -gt 5MB) { $downloaded = $true; break }
        $lastError = '下载到的文件太小，可能不是便携 git'
      } catch {
        $lastError = $_.Exception.Message
      }
    }

    $ProgressPreference = $oldProgress
    if (-not $downloaded) {
      throw "[$pluginName] 便携版 git 下载失败：$lastError`n可以先用 -Tarball 安装，或手动装 git 后再试。"
    }

    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Expand-Archive -Path $zip -DestinationPath $root -Force
    Remove-Item $zip -Force
  }

  # 本次安装立刻可用
  $env:PATH = "$root\cmd;$env:PATH"

  # 写进用户 PATH 是永久副作用，默认不做；需要 GUI 里粘仓库地址时加 -WritePath。
  if ($WritePath -and -not $NoPathUpdate) {
    $cmdDir = Join-Path $root 'cmd'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$cmdDir*") {
      [Environment]::SetEnvironmentVariable('Path', "$cmdDir;$userPath", 'User')
      Write-Host "[$pluginName] 已把便携 git 写进用户 PATH；重启 DSH 后，插件管理器里粘贴仓库地址也能装。" -ForegroundColor Green
    }
  } else {
    Write-Host "[$pluginName] 便携 git 只在本次安装生效，未写用户 PATH（需要时加 -WritePath）。" -ForegroundColor Yellow
  }

  # 便携 git 自己关掉证书吊销检查，避免 GitHub 下载被 CRYPT_E_NO_REVOCATION_CHECK 打断
  & $gitExe config --system http.schannelCheckRevoke false 2>$null
  Write-Host "[$pluginName] 便携 git 就绪：$gitExe"
}

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  Write-Host "[$pluginName] profile '$Profile' 还没初始化，交给 dsh CLI 创建。" -ForegroundColor Yellow
}

# 1) 清理旧的 junction（link: 安装残留），只删链接，不动源码目录
$linkTarget = Join-Path $profileDir "node_modules\$pluginName"
if (Test-Path -LiteralPath $linkTarget) {
  $item = Get-Item -LiteralPath $linkTarget -Force
  if ($item.LinkType -eq 'Junction') {
    Write-Host "[$pluginName] 检测到旧的 junction 链接，正在移除（源码目录不受影响）…" -ForegroundColor Yellow
    cmd /c rmdir "$linkTarget"
  }
}

# 2) 找 dsh CLI
$dshCli = Find-DshCli
if (-not $dshCli) {
  Write-Host "[$pluginName] 没有找到 dsh CLI。" -ForegroundColor Red
  Write-Host "改用手动方式：在 DSH 的「插件管理器 → 添加插件」里输入" -ForegroundColor Yellow
  Write-Host "  github:xichen-62/dsh-power-menu" -ForegroundColor Yellow
  Write-Host "装完之后运行同目录下的 enable.ps1，再重启 DSH。" -ForegroundColor Yellow
  exit 1
}

# 3) 选择安装来源：有 git 走 git；没有 git 默认走 Release tgz；-Github 则先备便携 git
$hasGit = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
$spec = $null

if ($TgzPath) {
  if (-not (Test-Path -LiteralPath $TgzPath)) { throw "[$pluginName] 找不到指定的 tgz：$TgzPath" }
  $resolved = (Resolve-Path -LiteralPath $TgzPath).Path
  Assert-TarballChecksum $resolved
  $spec = "file:$resolved"
  Write-Host "[$pluginName] 使用本地安装包：$resolved"
} elseif ($Github) {
  if (-not $hasGit) { Ensure-PortableGit }
  $spec = if ($Mirror) {
    'git+https://gh-proxy.com/https://github.com/xichen-62/dsh-power-menu.git'
  } else {
    'github:xichen-62/dsh-power-menu'
  }
} elseif ($Tarball -or -not $hasGit) {
  if (-not $hasGit -and -not $Tarball) {
    Write-Host "[$pluginName] 没有检测到 git，改用 Release 安装包（跳过 git 依赖解析）。" -ForegroundColor Yellow
  }
  $file = Save-ReleaseTarball
  $spec = "file:$file"
} else {
  $spec = if ($Mirror) {
    'git+https://gh-proxy.com/https://github.com/xichen-62/dsh-power-menu.git'
  } else {
    'github:xichen-62/dsh-power-menu'
  }
}

# 重装前先移除旧条目：pnpm 会把 Git 依赖解析到的 commit 钉在 pnpm-lock.yaml 里，
# 不先 remove，再 add 同一个地址时会直接复用旧 commit——DSH 升级后插件「倒退」就是这么来的。
try {
  & $dshCli plugin --profile $Profile remove $pluginName 2>$null | Out-Null
} catch {
  # 没装过，或者 remove 失败：都不影响后面的安装
}

Write-Host "[$pluginName] 正在安装（$spec）…"
& $dshCli plugin --profile $Profile add $spec
if ($LASTEXITCODE -ne 0) {
  throw "[$pluginName] 安装失败（退出码 $LASTEXITCODE）。`n如果看到 ERR_PNPM_GIT_RESOLVE_FAILED，说明这台机器没有 git：加 -Github 自动装便携 git，或加 -Tarball 走安装包。`n如果提示网络问题，可以加 -Mirror 参数重试；如果看到 ERR_PNPM_EPERM，请把完整输出发到仓库 issue。"
}

# 4) 补 dsh.profile.bundles
$enableScript = Join-Path $PSScriptRoot 'enable.ps1'
if (Test-Path $enableScript) {
  & $enableScript -Profile $Profile
} else {
  Write-Host "[$pluginName] 没找到 enable.ps1，请手动把 dsh-power-menu 加进 profile 的 dsh.profile.bundles。" -ForegroundColor Yellow
}

Write-Host ''
Write-Host "[$pluginName] 安装完成。请重启 DSH Desktop 让插件生效。" -ForegroundColor Green
