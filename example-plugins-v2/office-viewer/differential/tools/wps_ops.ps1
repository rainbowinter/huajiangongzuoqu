# WPS COM 操作执行器（双端操作差分的第一步）
#
# 读一份 transcript（JSON），在 WPS 里按同样的"语义操作"执行，然后把结果
# 投影成和插件侧可比的结构。物理按键不可靠，所以两端共用的是语义操作：
#   place / type / ime / key / select / paste / table
#
# 用法：
#   .\wps_ops.ps1 -Fixture fixtures\O01.docx -Ops ops\O01.json -Out out\O01.wps-ops.json
#
# 注意：DisplayAlerts=0，Visible=$false；结束一定 Quit + ReleaseComObject。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Fixture,
  [Parameter(Mandatory = $true)][string]$Ops,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'

# --- 单位：Word 用“字符位置”，1 个中文字符 / 西文字母都算 1 ---
function Get-ParagraphStart($doc, $paragraphIndex) {
  if ($paragraphIndex -le 1) { return 0 }
  # 第 N 段的起点 = 第 N-1 段末尾（含段落标记）
  return [int]$doc.Paragraphs.Item($paragraphIndex - 1).Range.End
}

function Move-Caret($app, $doc, $block, $offset) {
  $start = Get-ParagraphStart $doc ($block + 1)
  $range = $doc.Range($start, $start)
  $range.Select()
  if ($offset -gt 0) {
    $app.Selection.MoveRight(1, [int]$offset, 0) | Out-Null   # wdCharacter
  }
}

function Select-Range($app, $doc, $fromBlock, $fromOffset, $toBlock, $toOffset) {
  $s = (Get-ParagraphStart $doc ($fromBlock + 1)) + $fromOffset
  $e = (Get-ParagraphStart $doc ($toBlock + 1)) + $toOffset
  $doc.Range($s, $e).Select()
}

function Invoke-Op($app, $doc, $op) {
  switch ($op.op) {
    'place'  { Move-Caret $app $doc $op.block $op.offset }
    'placeCell' {
      $tableIndex = if ($null -ne $op.table) { [int]$op.table } else { 0 }
      $rowIndex = if ($null -ne $op.row) { [int]$op.row } else { 0 }
      $cellIndex = if ($null -ne $op.cell) { [int]$op.cell } else { 0 }
      $paragraphIndex = if ($null -ne $op.paragraph) { [int]$op.paragraph } else { 0 }
      $offset = if ($null -ne $op.offset) { [int]$op.offset } else { 0 }
      $table = $doc.Tables.Item($tableIndex + 1)
      $cell = $table.Cell($rowIndex + 1, $cellIndex + 1)
      $paragraph = $cell.Range.Paragraphs.Item($paragraphIndex + 1)
      $start = [int]$paragraph.Range.Start
      $range = $doc.Range($start, $start)
      $range.Select()
      if ($offset -gt 0) {
        $app.Selection.MoveRight(1, $offset, 0) | Out-Null
      }
    }
    'select' { Select-Range $app $doc $op.from.block $op.from.offset $op.to.block $op.to.offset }
    'type'   { $app.Selection.TypeText([string]$op.text) }
    'ime'    { $app.Selection.TypeText([string]$op.text) }
    'paste'  { $app.Selection.TypeText([string]$op.text) }
    'key' {
      switch ($op.key) {
        'Enter'       { $app.Selection.TypeParagraph() }
        'Shift+Enter' { $app.Selection.TypeText([char]11) }   # 垂直制表 = 软换行
        # Word/WPS 的 Selection.Delete(Unit, Count)：负 Count 往左删，
        # 正 Count 往右删。Backspace 必须传 -1，否则会删到光标**后面**的字。
        'Backspace'   {
          # UI 的退格在列表项开头先去掉编号（多级列表先降级），不合并段落。
          $selection = $app.Selection
          $atStart = $selection.Start -eq $selection.Paragraphs.Item(1).Range.Start
          $listType = 0
          try { $listType = $selection.Range.ListFormat.ListType } catch {}
          if ($atStart -and $listType -ne 0) {
            $selection.Range.ListFormat.RemoveNumbers() | Out-Null
          } else {
            $selection.Delete(1, -1) | Out-Null
          }
        }
        'Delete'      { $app.Selection.Delete(1, 1) | Out-Null }
        'Tab'         { $app.Selection.TypeText("`t") }
        'Ctrl+Z'      { $doc.Undo() | Out-Null }
        'Ctrl+Y'      { $doc.Redo() | Out-Null }
        default { throw "unsupported key: $($op.key)" }
      }
    }
    'format' {
      $on = if ($null -ne $op.value) { if ($op.value) { 1 } else { 0 } } else { 1 }
      switch ($op.key) {
        'bold'      { $app.Selection.Font.Bold = $on }
        'italic'    { $app.Selection.Font.Italic = $on }
        'underline' { $app.Selection.Font.Underline = $on }
        'strike'    { $app.Selection.Font.StrikeThrough = $on }
        'vertAlign' {
          $app.Selection.Font.Superscript = if ($op.value -eq 'superscript') { 1 } else { 0 }
          $app.Selection.Font.Subscript = if ($op.value -eq 'subscript') { 1 } else { 0 }
        }
        default { throw "unsupported format: $($op.key)" }
      }
    }
    'table' {
      # 把当前选中的文本转成表格；op 里给 rows/cols 和分隔符。
      $sep = if ($op.separator) { $op.separator } else { "`t" }
      $app.Selection.ConvertToTable($sep) | Out-Null
    }
    default { throw "unsupported op: $($op.op)" }
  }
}

function Read-Projection($doc) {
  $paragraphs = @()
  for ($i = 1; $i -le $doc.Paragraphs.Count; $i++) {
    $p = $doc.Paragraphs.Item($i)
    $text = $p.Range.Text
    if ($null -eq $text) { $text = "" }
    $text = $text -replace "`r", "" -replace "`a", "" -replace "`v", "`n"
    $numId = $null; $ilvl = $null
    try {
      if ($p.Range.ListFormat.ListType -ne 0) {
        $numId = [int]$p.Range.ListFormat.ListString.GetHashCode()
        $ilvl = [int]$p.Range.ListFormat.ListLevelNumber
      }
    } catch {}
    $runs = @()
    # 逐词读格式；WPS 的 Words 会把中文按词切，粒度与插件不同，先只取粗体/斜体
    for ($w = 1; $w -le [Math]::Min($p.Range.Words.Count, 80); $w++) {
      $word = $p.Range.Words.Item($w)
      $t = $word.Text -replace "`r", ""
      if ([string]::IsNullOrEmpty($t)) { continue }
      $runs += [ordered]@{
        text  = $t
        bold  = [bool]$word.Font.Bold
        italic = [bool]$word.Font.Italic
        font  = [string]$word.Font.Name
        size  = [double]$word.Font.Size
      }
    }
    $paragraphs += [ordered]@{
      text       = $text
      numbering  = if ($null -ne $numId) { [ordered]@{ numId = $numId; ilvl = $ilvl } } else { $null }
      runs       = $runs
    }
  }

  $tables = @()
  for ($t = 1; $t -le $doc.Tables.Count; $t++) {
    $table = $doc.Tables.Item($t)
    $cells = @()
    for ($r = 1; $r -le $table.Rows.Count; $r++) {
      $rowCells = @()
      for ($c = 1; $c -le $table.Columns.Count; $c++) {
        try {
          $cellText = [string]$table.Cell($r, $c).Range.Text
          $rowCells += ($cellText -replace "`r", "`n" -replace "`a", "" -replace "`v", "")
        } catch { $rowCells += $null }
      }
      $cells += ,$rowCells
    }
    $tables += [ordered]@{
      rows  = [int]$table.Rows.Count
      cols  = [int]$table.Columns.Count
      text  = [string]$table.Range.Text
      cells = $cells
    }
  }

  # 光标投影：Word 的 Range.Start 是全文字符位置；换算成「第几段第几个字符」。
  $caret = $null
  try {
    $selection = $app.Selection
    if ($selection.Start -eq $selection.End) {
      $position = [int]$selection.Start
      for ($i = 1; $i -le $doc.Paragraphs.Count; $i++) {
        $p = $doc.Paragraphs.Item($i)
        $start = [int]$p.Range.Start
        $end = [int]$p.Range.End
        # 段尾位置（position == end）属于段落标记的末尾；Word 的光标
        # 在回车后落在下一段开头，所以除了最后一段都归到下一段的 offset 0。
        $isLast = ($i -eq $doc.Paragraphs.Count)
        if ($position -ge $start -and ($position -lt $end -or ($position -eq $end -and $isLast))) {
          $caret = [ordered]@{
            block  = $i - 1
            offset = $position - $start
          }
          break
        }
        if ($position -eq $end -and -not $isLast) {
          $caret = [ordered]@{ block = $i; offset = 0 }
          break
        }
      }
    }
  } catch {}

  return [ordered]@{
    paragraphs = $paragraphs
    tables     = $tables
    caret      = $caret
  }
}

$fixturePath = (Resolve-Path $Fixture).Path
$opList = Get-Content -Raw -Encoding UTF8 $Ops | ConvertFrom-Json

$app = New-Object -ComObject KWPS.Application
try { $app.Visible = $false } catch {}
try { $app.DisplayAlerts = 0 } catch {}
try { $app.ScreenUpdating = $false } catch {}

$doc = $null
try {
  $doc = $app.Documents.Open($fixturePath, $false, $false, $false)
  $app.Selection.HomeKey(6) | Out-Null   # wdStory

  $step = 0
  foreach ($op in $opList) {
    $step++
    try {
      Invoke-Op $app $doc $op
    } catch {
      throw "step $step ($($op.op) $(if ($op.key) { $op.key } else { '' })) failed: $($_.Exception.Message)"
    }
  }

  $projection = Read-Projection $doc
  $projection | Add-Member -NotePropertyName id -NotePropertyValue ([IO.Path]::GetFileNameWithoutExtension($Fixture)) -Force
  $projection | Add-Member -NotePropertyName ops -NotePropertyValue $opList.Count -Force
  $projection | ConvertTo-Json -Depth 12 | Set-Content -Path $Out -Encoding utf8
  "ok   $([IO.Path]::GetFileName($Fixture))  ops=$($opList.Count)  paras=$($projection.paragraphs.Count)  tables=$($projection.tables.Count)"
} finally {
  if ($doc) { try { $doc.Close(0) } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }
  try { $app.Quit() } catch {}
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
  [GC]::Collect()
}
