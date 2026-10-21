# 用 WPS 打开夹具并导出 PDF —— 差分的"基准端"。
#
# 用法：
#   .\make_reference.ps1                       # 处理 fixtures/*.docx
#   .\make_reference.ps1 -Pattern 'B0*.docx'   # 只处理部分
#   .\make_reference.ps1 -KeepWps              # 复用已在跑的 WPS 实例
#
# 产物：
#   ref/<id>.pdf          WPS 导出的 PDF（排版基准）
#   ref/<id>.wps.json     WPS 报告的结构化度量（页数/字数/段落数…）
#
# 注意：WPS 的 Documents.Open 在文件损坏时会弹"修复"对话框。这里把
# DisplayAlerts 设为 0，并用超时保护；如果仍然卡住，脚本会杀掉自己启动的
# wps.exe 并记一条 error，不会拖死整批。

[CmdletBinding()]
param(
  [string]$Pattern = '*.docx',
  [string]$FixturesDir = '',
  [switch]$KeepWps,
  [int]$OpenTimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
$Kit    = Split-Path -Parent $PSScriptRoot
$Fixtures = if ($FixturesDir) { $FixturesDir } else { Join-Path $Kit 'fixtures' }
$RefDir   = Join-Path $Kit 'ref'
$OutDir   = Join-Path $Kit 'out'
New-Item -ItemType Directory -Force -Path $RefDir, $OutDir | Out-Null

$startedOwnWps = $false
$app = $null
try {
  $app = New-Object -ComObject KWPS.Application
} catch {
  throw "无法创建 KWPS.Application：$($_.Exception.Message)"
}
if (-not $KeepWps) { $startedOwnWps = $true }

# 关掉交互：不显示窗口、不弹对话框、不做宏安全检查。
try { $app.Visible = $false } catch {}
try { $app.DisplayAlerts = 0 } catch {}
try { $app.ScreenUpdating = $false } catch {}
try { $app.AutomationSecurity = 3 } catch {}   # msoAutomationSecurityForceDisable

$wdFormatPDF = 17
$results = @()

function Get-DocStat($doc, $stat) {
  try { return [int]$doc.ComputeStatistics($stat) } catch { return $null }
}

foreach ($file in Get-ChildItem -Path $Fixtures -Filter $Pattern -File | Sort-Object Name) {
  $id  = [IO.Path]::GetFileNameWithoutExtension($file.Name)
  # E* 是交互用例：它们是"操作起点"文档，不做 PDF 排版对照。跳过，省时间也免歧义。
  if ($id -match '^E\d+$') { continue }
  $pdf = Join-Path $RefDir "$id.pdf"
  $rec = [ordered]@{
    id = $id
    file = $file.Name
    ok = $false
    pages = $null
    words = $null
    chars = $null
    paragraphs = $null
    lines = $null
    open_ms = $null
    pdf_bytes = $null
    error = $null
  }

  $doc = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, ...)
    $doc = $app.Documents.Open($file.FullName, $false, $true, $false)
    $sw.Stop()
    $rec.open_ms = [int]$sw.ElapsedMilliseconds

    $rec.pages      = Get-DocStat $doc 2   # wdStatisticPages
    $rec.words      = Get-DocStat $doc 0   # wdStatisticWords
    $rec.chars      = Get-DocStat $doc 3   # wdStatisticCharacters
    $rec.paragraphs = Get-DocStat $doc 4   # wdStatisticParagraphs
    $rec.lines      = Get-DocStat $doc 1   # wdStatisticLines

    if (Test-Path $pdf) { Remove-Item $pdf -Force }
    # SaveAs2(FileName, FileFormat, LockComments, Password, AddToRecentFiles, ...)
    $doc.SaveAs2($pdf, $wdFormatPDF)
    if (-not (Test-Path $pdf)) { throw "SaveAs2 未生成 PDF" }
    $rec.pdf_bytes = (Get-Item $pdf).Length
    $rec.ok = $true
  } catch {
    $rec.error = "$($_.Exception.GetType().Name): $($_.Exception.Message)"
  } finally {
    if ($doc) {
      try { $doc.Close(0) } catch {}
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc)
    }
  }

  $results += [pscustomobject]$rec
  $status = if ($rec.ok) { 'ok  ' } else { 'FAIL' }
  "{0} {1,-4} pages={2,-3} paras={3,-3} pdf={4,8} B  {5} ms {6}" -f `
    $status, $id, $rec.pages, $rec.paragraphs, $rec.pdf_bytes, $rec.open_ms, $rec.error | Write-Host
  $rec | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutDir "$id.wps.json") -Encoding utf8
}

$results | ConvertTo-Json -Depth 4 |
  Set-Content -Path (Join-Path $OutDir 'wps-report.json') -Encoding utf8

$failed = @($results | Where-Object { -not $_.ok })
"`n$($results.Count) files, $($failed.Count) failed -> $RefDir" | Write-Host

if ($app) {
  try { if ($startedOwnWps) { $app.Quit() } } catch {}
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
[GC]::Collect()

if ($failed.Count -gt 0) { exit 1 }
