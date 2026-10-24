/**
 * Capture the card itself, so "it overflows" can be SEEN rather than inferred.
 *
 * Every screenshot attempt so far used CopyFromScreen, which returns a blank
 * frame in this environment — so nothing that was measured could ever be checked
 * against what the user actually sees. PrintWindow with PW_RENDERFULLCONTENT asks
 * the window to render itself into a bitmap instead of copying the screen, which
 * works even when the card is not the visible surface.
 *
 * The card logs its own HWND at Shown; the capturer reads that handle, calls
 * PrintWindow, and saves a PNG. Then the image is inspected directly.
 */
import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { buildScript } from '../notify.js'

const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const dir = mkdtempSync(join(tmpdir(), 'attention-shot-'))

const BODY = process.env.BODY
  ?? '这是一段非常长的正文用来测试行数上限是否真的生效，它应该被限制在三行以内并在末尾显示省略号而不是继续向下延伸压到底部的时间轴上面去。再补充一些文字让它更长一些，确保确实超过了四行的容量。继续补充内容以确保足够长。'

const hwndFile = join(dir, 'hwnd.txt')
const png = join(dir, 'card.png')

// The card script, with its own handle written out at Shown so the capturer can
// address the exact window instead of guessing.
let script = buildScript(
  { sound: false, popup: true, popupTimeoutMs: 14_000, balloon: false, box: false, powershell: ps },
  'DeepSeek Harness',
  BODY,
)
script = script.replace(
  '[System.Windows.Forms.Application]::Run($f)',
  [
    `$f.add_Shown({ Set-Content -LiteralPath '${hwndFile}' -Value ([string]$f.Handle) -Encoding utf8 })`,
    '[System.Windows.Forms.Application]::Run($f)',
  ].join('\n'),
)

const CAPTURE = [
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -AssemblyName System.Windows.Forms',
  "$ErrorActionPreference='Stop'",
  // Wait for the card to publish its handle.
  '$deadline=([DateTime]::Now).AddSeconds(20)',
  'while(-not (Test-Path $env:HWNDFILE) -and ([DateTime]::Now) -lt $deadline){ Start-Sleep -Milliseconds 150 }',
  'if(-not (Test-Path $env:HWNDFILE)){ Set-Content -LiteralPath $env:SHOTLOG -Value "nohwnd" -Encoding utf8; exit 1 }',
  '$h=[IntPtr][long](Get-Content -LiteralPath $env:HWNDFILE -Raw).Trim()',
  // Give it a moment to paint.
  'Start-Sleep -Milliseconds 900',
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Rr,B;}[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport(\"user32.dll\")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);[DllImport(\"user32.dll\")]public static extern bool SetProcessDPIAware();}'",
  '[void][W]::SetProcessDPIAware()',
  '$r=New-Object W+R',
  '[void][W]::GetWindowRect($h,[ref]$r)',
  '$cw=$r.Rr-$r.L; $ch=$r.B-$r.T',
  '$bmp=New-Object System.Drawing.Bitmap($cw,$ch)',
  '$g=[System.Drawing.Graphics]::FromImage($bmp)',
  // PW_RENDERFULLCONTENT (2) makes the window draw itself, including layered
  // surfaces, instead of copying whatever is on screen at that rectangle.
  '$ok=[W]::PrintWindow($h,$g.GetHdc(),2)',
  '$g.ReleaseHdc()',
  '$bmp.Save($env:SHOTPNG,[System.Drawing.Imaging.ImageFormat]::Png)',
  'Set-Content -LiteralPath $env:SHOTLOG -Value "printwindow=$ok size=$cw x $ch" -Encoding utf8',
].join('\n')

const cardFile = join(tmpdir(), 'dsh-attention', `shotcard-${process.pid}.ps1`)
const capFile = join(tmpdir(), 'dsh-attention', `shotcap-${process.pid}.ps1`)
mkdirSync(dirname(cardFile), { recursive: true })
writeFileSync(cardFile, `\ufeff${script}`, 'utf8')
writeFileSync(capFile, `\ufeff${CAPTURE}`, 'utf8')

const log = join(dir, 'log.txt')
const card = spawn(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', cardFile], { stdio: 'ignore', windowsHide: true })
spawnSync(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', capFile], {
  stdio: 'ignore',
  timeout: 30_000,
  env: { ...process.env, HWNDFILE: hwndFile, SHOTPNG: png, SHOTLOG: log },
})
try { card.kill() } catch { /* already closed */ }

console.log(existsSync(log) ? readFileSync(log, 'utf8').trim() : '(no capture log)')

const keep = join(process.cwd(), 'test', 'shots')
mkdirSync(keep, { recursive: true })
if (existsSync(png)) {
  const dest = join(keep, 'card.png')
  copyFileSync(png, dest)
  console.log(`saved: ${dest}`)
} else {
  console.log('no image produced')
}

try {
  rmSync(cardFile, { force: true })
  rmSync(capFile, { force: true })
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* disposable */
}
