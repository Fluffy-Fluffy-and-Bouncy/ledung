// The Windows half of Ledung's tray icon (issue #347, docs/steps/tray-icon.md): a Windows PowerShell 5.1 script with
// .NET's NotifyIcon and a Windows Forms menu, all part of Windows, so there is no program of ours to download, sign or
// trust (choice A). It talks to Ledung only over its own stdin and stdout, one line at a time (src/platform/tray.ts).
//
// - In: a JSON line: the state ({tip, status, waiting, restart}), {ask} with the Exit question's text, or {stop}.
// - Out: one of the fixed words open, restart, exit, exit-confirmed.
// - It removes the icon and exits on {stop}, when its input ends (Ledung stopped, however it stopped) or, as a second
//   net, when the process in LEDUNG_TRAY_PARENT is gone (checked every second). The icon is hidden and disposed on
//   every way out, in a finally too: an icon whose process ends without that stays drawn until the mouse passes over
//   it (acceptance round 1, point 5).
//
// Input is read with ReadLineAsync on its own StreamReader and polled from a Forms timer, so the menu stays live while
// it waits: Console.In's own ReadLineAsync blocks in .NET Framework. Handlers assign through $script:, as Windows
// PowerShell runs each one in a child scope.

/** The script, run as `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command <this>`. */
export const WINDOWS_TRAY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
# Started hidden, Windows hides the first window this process shows, whatever it asks for: that was the Exit dialog,
# open but invisible (spike, 2026-11-17). An invisible window shown once takes that first turn.
$sink = New-Object System.Windows.Forms.Form
$sink.ShowInTaskbar = $false
$sink.Opacity = 0
$sink.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$sink.Show()
$sink.Hide()

$out = [Console]::Out
function Send([string]$word) { $out.WriteLine($word); $out.Flush() }

# Ledung's own icon, scaled down, once plain and once with the amber "waiting for you" dot.
$source = [System.Drawing.Image]::FromFile($env:LEDUNG_TRAY_ICON)
# The page's PNG is square with white corners; the icon is its rounded square (icon.svg's rx 112 of 512), cut out.
$scaled = New-Object System.Drawing.Bitmap 32, 32
$sg = [System.Drawing.Graphics]::FromImage($scaled)
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$edges = New-Object System.Drawing.Imaging.ImageAttributes
$edges.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
$sg.DrawImage($source, (New-Object System.Drawing.Rectangle 0, 0, 32, 32), 0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel, $edges)
$sg.Dispose()
$rounded = New-Object System.Drawing.Drawing2D.GraphicsPath
$rounded.AddArc(0, 0, 14, 14, 180, 90)
$rounded.AddArc(18, 0, 14, 14, 270, 90)
$rounded.AddArc(18, 18, 14, 14, 0, 90)
$rounded.AddArc(0, 18, 14, 14, 90, 90)
$rounded.CloseFigure()
function New-TrayIcon([bool]$dot) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.FillPath((New-Object System.Drawing.TextureBrush $scaled), $rounded)
  if ($dot) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(22, 24, 29))), 18, 18, 14, 14)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(224, 175, 104))), 20, 20, 10, 10)
  }
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$plain = New-TrayIcon $false
$dotted = New-TrayIcon $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$status = $menu.Items.Add('Ledung')
$status.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$open = $menu.Items.Add('Open Ledung')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Send 'open' })
$restart = $menu.Items.Add('Restart Ledung')
$restart.Visible = $false
$restart.add_Click({ Send 'restart' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add('Exit Ledung')
$exitItem.add_Click({ Send 'exit' })

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = $plain
$icon.Text = 'Ledung'
$icon.ContextMenuStrip = $menu
$icon.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send 'open' } })
$icon.Visible = $true

# The Exit question: a small dialog in front, Exit Ledung and Cancel (Esc).
function Confirm-Exit([string]$text) {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Ledung'
  $f.Icon = $plain
  $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $f.MaximizeBox = $false
  $f.MinimizeBox = $false
  $f.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $f.TopMost = $true
  $f.AutoSize = $true
  $f.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
  $f.Padding = New-Object System.Windows.Forms.Padding 14
  $layout = New-Object System.Windows.Forms.FlowLayoutPanel
  $layout.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
  $layout.AutoSize = $true
  $layout.Location = New-Object System.Drawing.Point 14, 14
  $label = New-Object System.Windows.Forms.Label
  $label.AutoSize = $true
  $label.MaximumSize = New-Object System.Drawing.Size 360, 0
  $label.Margin = New-Object System.Windows.Forms.Padding 0, 0, 0, 14
  $label.Text = $text
  $buttons = New-Object System.Windows.Forms.FlowLayoutPanel
  $buttons.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
  $buttons.AutoSize = $true
  $buttons.Anchor = [System.Windows.Forms.AnchorStyles]::Right
  $yes = New-Object System.Windows.Forms.Button
  $yes.Text = 'Exit Ledung'
  $yes.AutoSize = $true
  $yes.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $no = New-Object System.Windows.Forms.Button
  $no.Text = 'Cancel'
  $no.AutoSize = $true
  $no.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $buttons.Controls.Add($yes)
  $buttons.Controls.Add($no)
  $layout.Controls.Add($label)
  $layout.Controls.Add($buttons)
  $f.Controls.Add($layout)
  $f.AcceptButton = $yes
  $f.CancelButton = $no
  $f.add_Shown({ $f.Activate() })
  # Input is still read while it is open, so Ledung stopping closes it with the icon (Quit).
  $script:dialog = $f
  try { $result = $f.ShowDialog() } finally { $script:dialog = $null }
  $f.Dispose()
  return $result -eq [System.Windows.Forms.DialogResult]::OK
}

function Apply([string]$line) {
  $m = $line | ConvertFrom-Json
  if ($m.stop) { Quit; return }
  if ($m.ask) {
    # One question at a time; a second Exit while it is open just leaves it open.
    if ($null -eq $script:dialog -and (Confirm-Exit ([string]$m.ask)) -and -not $script:quitting) { Send 'exit-confirmed' }
    return
  }
  $tip = [string]$m.tip
  # The tooltip's limit in Windows Forms.
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
  $icon.Text = $tip
  $status.Text = [string]$m.status
  $restart.Visible = [bool]$m.restart
  if ([int]$m.waiting -gt 0) { $icon.Icon = $dotted } else { $icon.Icon = $plain }
}

function Remove-Icon {
  try { $icon.Visible = $false } catch { }
  try { $icon.Dispose() } catch { }
}

function Quit {
  if ($script:quitting) { return }
  $script:quitting = $true
  $script:timer.Stop()
  if ($null -ne $script:dialog) { $script:dialog.Close() }
  Remove-Icon
  [System.Windows.Forms.Application]::Exit()
}

$script:dialog = $null
$script:quitting = $false
$parent = $null
try { $parent = [System.Diagnostics.Process]::GetProcessById([int]$env:LEDUNG_TRAY_PARENT) } catch { }
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
$script:pending = $reader.ReadLineAsync()
$script:ticks = 0
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 200
$script:timer.add_Tick({
  if ($script:quitting) { return }
  try {
    while ($script:pending.IsCompleted -and -not $script:quitting) {
      $line = $null
      if (-not $script:pending.IsFaulted) { $line = $script:pending.Result }
      if ($null -eq $line) { Quit; return }
      $script:pending = $reader.ReadLineAsync()
      try { Apply $line } catch { }
    }
    $script:ticks++
    if ($script:ticks % 5 -eq 0 -and $null -ne $parent) {
      $parent.Refresh()
      if ($parent.HasExited) { Quit; return }
    }
  } catch { Quit }
})
$script:timer.Start()
try { [System.Windows.Forms.Application]::Run() } finally { Remove-Icon }
`;
