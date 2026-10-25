/**
 * Render the notification card itself to PNG — one per tone — for the README.
 *
 * CopyFromScreen returns a blank frame in this environment, so the capture uses
 * PrintWindow with PW_RENDERFULLCONTENT: the window draws itself into a bitmap
 * instead of the screen being copied. That also means the result contains the
 * card and nothing else — no desktop wallpaper, no other application, no
 * personal information — which is what makes it safe to publish.
 *
 * Two modes:
 *
 *   node test/render-screenshots.mjs            — generate the card scripts and
 *                                                 run the whole capture (default)
 *   DSH_GENERATE_ONLY=1 node test/...mjs        — only write the scripts under
 *                                                 .screenshot-scratch/ and print
 *                                                 the commands; the caller then
 *                                                 drives the two PowerShell
 *                                                 processes itself. This is how
 *                                                 the run works inside a sandbox
 *                                                 that denies child_process
 *                                                 spawn but allows a shell.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildScript } from '../notify.js'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'docs', 'screenshots')
// Scratch space stays inside the repository: the sandbox denies writes to the
// system temp directory, and a capture is not worth widening the sandbox for.
const scratchRoot = join(here, '..', '.screenshot-scratch')
const ps = process.env.DSH_ATTENTION_POWERSHELL
  ?? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * The three tones, each with a body that shows off the card at its best.
 *
 * `title` here is what a real card receives: the CONVERSATION's name, resolved
 * from the session's `session/title` event. The screenshots therefore show the
 * headline the user actually sees — not the fixed product label, which now sits
 * on the small `brand` line above it. Rendering the product label as the
 * headline would document a layout the plugin no longer produces.
 */
export const CASES = [
  {
    file: 'card-ok.png',
    tone: 'ok',
    brand: 'DeepSeek Harness',
    title: '重构 hotkey.js 的组合键解析',
    body: '已完成：重构了 `hotkey.js` 的组合键解析，**删掉**了重复的修饰键查表，`parseHotkey` 现在只走一条路径。测试 15/15 通过，用时 2 分 11 秒。',
  },
  {
    file: 'card-ask.png',
    tone: 'ask',
    brand: 'DeepSeek Harness',
    title: '给 dsh-attention 仓库起名',
    body: '需要你选择：GitHub 上 `dsh-attention` 这个名字已被 6 个用户占用，仓库该叫什么？',
  },
  {
    file: 'card-alert.png',
    tone: 'alert',
    brand: 'DeepSeek Harness',
    title: '插件安装失败，import 阶段被丢弃',
    body: '出错：`pnpm install` 在插件目录失败，`jose` 解析不到 — 插件在 import 阶段被静默丢弃。',
  },
]

const CAPTURE = [
  'Add-Type -AssemblyName System.Drawing',
  "$ErrorActionPreference='Stop'",
  // Wait for the card to publish its handle.
  '$deadline=([DateTime]::Now).AddSeconds(20)',
  'while(-not (Test-Path $env:HWNDFILE) -and ([DateTime]::Now) -lt $deadline){ Start-Sleep -Milliseconds 150 }',
  'if(-not (Test-Path $env:HWNDFILE)){ Set-Content -LiteralPath $env:SHOTLOG -Value "nohwnd" -Encoding utf8; exit 1 }',
  '$h=[IntPtr][long](Get-Content -LiteralPath $env:HWNDFILE -Raw).Trim()',
  'Start-Sleep -Milliseconds 900',
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Rr,B;}[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport(\"user32.dll\")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);[DllImport(\"user32.dll\")]public static extern bool SetProcessDPIAware();}'",
  '[void][W]::SetProcessDPIAware()',
  '$r=New-Object W+R',
  '[void][W]::GetWindowRect($h,[ref]$r)',
  '$cw=$r.Rr-$r.L; $ch=$r.B-$r.T',
  '$bmp=New-Object System.Drawing.Bitmap($cw,$ch)',
  '$g=[System.Drawing.Graphics]::FromImage($bmp)',
  '$ok=[W]::PrintWindow($h,$g.GetHdc(),2)',
  '$g.ReleaseHdc()',
  '$bmp.Save($env:SHOTPNG,[System.Drawing.Imaging.ImageFormat]::Png)',
  '$g.Dispose(); $bmp.Dispose()',
  'Set-Content -LiteralPath $env:SHOTLOG -Value "printwindow=$ok size=$cw x $ch" -Encoding utf8',
].join('\n')

/**
 * Write one card script with its handle-publishing hook injected, plus the
 * shared capture script. Returns the paths the driver needs.
 */
export function generateScripts(cases, dir) {
  mkdirSync(dir, { recursive: true })
  const capFile = join(dir, 'capture.ps1')
  writeFileSync(capFile, `\ufeff${CAPTURE}`, 'utf8')
  const cards = cases.map((item) => {
    let script = buildScript(
      { sound: false, popup: true, popupTimeoutMs: 20_000, balloon: false, box: false, powershell: ps, brand: item.brand },
      item.title,
      item.body,
      item.tone,
    )
    script = script.replace(
      '[System.Windows.Forms.Application]::Run($f)',
      [
        `$f.add_Shown({ Set-Content -LiteralPath '$dir\\hwnd-${item.tone}.txt' -Value ([string]$f.Handle) -Encoding utf8 })`
          .replaceAll('$dir', dir.replaceAll('\'', '\'\'')),
        '[System.Windows.Forms.Application]::Run($f)',
      ].join('\n'),
    )
    const cardFile = join(dir, `card-${item.tone}.ps1`)
    writeFileSync(cardFile, `\ufeff${script}`, 'utf8')
    return { ...item, cardFile, hwndFile: join(dir, `hwnd-${item.tone}.txt`), png: join(dir, `shot-${item.tone}.png`), log: join(dir, `log-${item.tone}.txt`) }
  })
  return { capFile, cards }
}

function captureInProcess(card, capFile) {
  return new Promise((resolve) => {
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', card.cardFile], {
      stdio: 'ignore',
      windowsHide: true,
    })
    spawnSync(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', capFile], {
      stdio: 'ignore',
      timeout: 40_000,
      env: { ...process.env, HWNDFILE: card.hwndFile, SHOTPNG: card.png, SHOTLOG: card.log },
    })
    try { child.kill() } catch { /* already closed */ }
    resolve()
  })
}

const generateOnly = process.env.DSH_GENERATE_ONLY === '1'

if (generateOnly) {
  // Sandbox mode: the caller (a shell) runs the two PowerShell processes.
  const { cards } = generateScripts(CASES, scratchRoot)
  console.log(`scripts written under ${scratchRoot}`)
  for (const card of cards) {
    console.log(`\n[${card.tone}] ${card.file}`)
    console.log(`  card:    "${ps}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${card.cardFile}"`)
    console.log(`  capture: HWNDFILE="${card.hwndFile}" SHOTPNG="${card.png}" SHOTLOG="${card.log}" "${ps}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scratchRoot}\\capture.ps1"`)
  }
} else {
  mkdirSync(scratchRoot, { recursive: true })
  const dir = mkdtempSync(join(scratchRoot, 'run-'))
  const { capFile, cards } = generateScripts(CASES, dir)
  console.log(`rendering ${cards.length} cards to ${outDir}`)
  for (const card of cards) {
    await captureInProcess(card, capFile)
    const detail = existsSync(card.log) ? readFileSync(card.log, 'utf8').trim() : '(no capture log)'
    if (existsSync(card.png)) {
      mkdirSync(outDir, { recursive: true })
      copyFileSync(card.png, join(outDir, card.file))
      console.log(`  ${card.file}  ${detail}`)
    } else {
      console.log(`  ${card.file}  FAILED: ${detail}`)
    }
  }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* disposable */ }
}
