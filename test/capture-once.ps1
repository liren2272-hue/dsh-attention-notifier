param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Expect
)
# One-shot, DPI-aware screen grab that also asserts the frame it just took shows
# the expected accent colour. Retrying from the caller is how a card that is not
# up yet, or one already gone, gets distinguished from a wrong colour.
#
# DPI awareness must be claimed before any Screen metric exists, otherwise
# CopyFromScreen reads the virtualised region and the popup in the bottom-right
# corner falls outside the capture.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class ShotOnceDpi{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
$null = [ShotOnceDpi]::SetProcessDPIAware()

$r = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.X, $r.Y, 0, 0, $bmp.Size)
$g.Dispose()

$parts = $Expect.Split(',')
$target = [System.Drawing.Color]::FromArgb([int]$parts[0], [int]$parts[1], [int]$parts[2])

# Only the bottom-right corner can hold the card, so sample a window there
# rather than every pixel on a 2560x1600 screen.
$x0 = [Math]::Max(0, $r.Width - 900)
$y0 = [Math]::Max(0, $r.Height - 500)
$hit = $false
for ($y = $y0; $y -lt $r.Height -and -not $hit; $y += 2) {
  for ($x = $x0; $x -lt $r.Width; $x += 2) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.R -eq $target.R -and $c.G -eq $target.G -and $c.B -eq $target.B) { $hit = $true; break }
  }
}

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

if ($hit) { Write-Output "found $Expect" ; exit 0 } else { Write-Output "no $Expect in frame" ; exit 2 }
