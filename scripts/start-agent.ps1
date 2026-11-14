# 启动 Agent 服务（自动读取 code/agent/.env）
#
# 用法（在本仓库根目录）：
#   pwsh -File scripts/start-agent.ps1
#   pwsh -File scripts/start-agent.ps1 -Port 8101
#
# 没有 .env 或没有 key 也能启动：Agent 会降级为启发式规划 + 抽取式回答（mock=true）。

param(
  [int]$Port = 8101,
  [string]$HostAddr = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$agentDir = Join-Path $root 'code\agent'
$envFile = Join-Path $agentDir '.env'
$exampleFile = Join-Path $agentDir '.env.example'

if ($env:DEEPSEEK_API_KEY) {
  Write-Host "使用当前进程里的 DEEPSEEK_API_KEY（长度 $($env:DEEPSEEK_API_KEY.Length)）" -ForegroundColor Green
} elseif (Test-Path $envFile) {
  Get-Content $envFile -Encoding utf8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) { return }
    $kv = $line.Split('=', 2)
    $name = $kv[0].Trim()
    $value = $kv[1].Trim()
    if ($value) { Set-Item -Path "env:$name" -Value $value }
  }
  if ($env:DEEPSEEK_API_KEY) {
    Write-Host "已从 .env 读取 DEEPSEEK_API_KEY（长度 $($env:DEEPSEEK_API_KEY.Length)）" -ForegroundColor Green
  } else {
    Write-Host "没有配置 key，将以离线模式运行（Agent 用规则 + 抽取式回答）" -ForegroundColor Yellow
  }
} else {
  Write-Host "没找到 .env，也没有环境变量。" -ForegroundColor Yellow
  Write-Host "  想接模型：复制 .env.example 为 .env，填 DEEPSEEK_API_KEY" -ForegroundColor Yellow
  Write-Host "  不填也能跑：离线模式（规则规划 + 抽取式回答，mock=true）" -ForegroundColor Yellow
}

# 找 python：优先环境变量 LITEOFFICE_PYTHON，其次 PATH，最后提示
$python = $env:LITEOFFICE_PYTHON
if (-not $python -or -not (Test-Path $python)) {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { $python = $cmd.Source }
}
if (-not $python) {
  Write-Host "找不到 python。请安装 Python 3.11+ 或设置 LITEOFFICE_PYTHON 指向 python.exe" -ForegroundColor Red
  Write-Host "  例：`$env:LITEOFFICE_PYTHON='F:\Python311\python.exe'" -ForegroundColor Red
  exit 1
}

Write-Host "python: $python" -ForegroundColor DarkGray
Write-Host "启动：http://${HostAddr}:$Port/health" -ForegroundColor DarkGray
Push-Location $agentDir
try {
  & $python -m uvicorn app.main:app --host $HostAddr --port $Port
} finally {
  Pop-Location
}
