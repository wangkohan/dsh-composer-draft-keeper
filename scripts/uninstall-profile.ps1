# 一键回滚：把 dsh-composer-draft-keeper 从 desktop profile 摘掉
#
# 什么时候用：重启后 DSH 起不来 / 界面异常 / 想看"没插件时什么样"
# 怎么用：先完全退出 DSH，再右键这个文件 →「使用 PowerShell 运行」
#         或者在 PowerShell 里执行：powershell -ExecutionPolicy Bypass -File <本文件路径>

$ErrorActionPreference = 'Stop'
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
$pkg       = Join-Path $profileDir 'package.json'
$pluginDir = Join-Path $profileDir 'node_modules\dsh-composer-draft-keeper'

Write-Host "=== 回滚 dsh-composer-draft-keeper ===" -ForegroundColor Cyan

# 1. 检查 DSH 是否还开着（改了也会被回写覆盖）
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "✗ DSH 还在运行（$($running.Count) 个进程）。请先完全退出（托盘图标右键 → 退出），再跑这个脚本。" -ForegroundColor Red
    exit 1
}

# 2. 从 package.json 的 bundles 里删掉这一项
if (Test-Path $pkg) {
    $json = Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
    $bundles = $json.dsh.profile.bundles
    $before = $bundles.Count
    $json.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne 'dsh-composer-draft-keeper' })
    $after = $json.dsh.profile.bundles.Count

    # ConvertTo-Json 在 PowerShell 5 里对深嵌套会截断，这里手工写回更稳
    $backup = "$pkg.bak-rollback-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $pkg $backup
    $json | ConvertTo-Json -Depth 20 | Set-Content $pkg -Encoding UTF8
    Write-Host "✓ bundles: $before → $after 项（备份：$(Split-Path $backup -Leaf)）" -ForegroundColor Green
} else {
    Write-Host "✗ 找不到 $pkg" -ForegroundColor Red
}

# 3. 删掉插件目录
if (Test-Path $pluginDir) {
    Remove-Item $pluginDir -Recurse -Force
    Write-Host "✓ 已删除 node_modules\dsh-composer-draft-keeper" -ForegroundColor Green
} else {
    Write-Host "· 插件目录本来就不在，跳过" -ForegroundColor DarkGray
}

# 4. 提醒：镜像数据还留在 localStorage 里，不影响官方功能
Write-Host ""
Write-Host "完成。现在可以启动 DSH。" -ForegroundColor Cyan
Write-Host "注意：插件自己的镜像键（dsh.draft-keeper.v1.*）还留在本地存储里，不影响官方草稿；" -ForegroundColor DarkGray
Write-Host "      想彻底清干净，重新装回插件后在设置页点「一键清空」即可。" -ForegroundColor DarkGray
