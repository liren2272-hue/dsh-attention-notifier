/**
 * Regression guard for the detached-spawn bug.
 *
 * `ring()` used to spawn PowerShell with `detached: true`. On Windows a
 * detached child gets no console and exited 0 without ever running: spawn
 * reported success, notify.log recorded a ring, and nothing reached the screen.
 * That is why the plugin looked alive in the log but never rang in a real
 * session. The matrix below reproduces it and must keep showing the attached
 * child running and the detached one not; `ring()` must stay on the attached
 * side by never passing `detached`.
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ring } from '../notify.js'

const dir = join(tmpdir(), 'dsh-attention')
mkdirSync(dir, { recursive: true })
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

let failures = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures += 1
}

// ---- 1. the environment still behaves as it did when we found the bug ----
for (const detached of [false, true]) {
  const marker = join(dir, `matrix-${detached ? 'detached' : 'attached'}.txt`)
  writeFileSync(marker, '')
  const escaped = marker.replace(/\\/g, '\\\\')
  const script =
    "[IO.File]::AppendAllText('" + escaped + "', 'RAN ' + (Get-Date -Format o) + \"`n\")"
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')],
    { detached, stdio: 'ignore', windowsHide: true })
  if (detached) child.unref()
  await new Promise((r) => setTimeout(r, 5000))
  const ran = readFileSync(marker, 'utf8').includes('RAN')
  check(`a ${detached ? 'detached' : 'attached'} child ${detached ? 'still does not run' : 'runs'}`,
    detached ? !ran : ran)
}

// ---- 2. ring() must not opt into that broken mode ----
const cfg = {
  sound: true,
  popup: true,
  popupTimeoutMs: 3000,
  soundFile: 'C:\\Windows\\Media\\notify.wav',
  powershell: ps,
  title: 'RingRegression',
  logFile: join(dir, 'ring-regression.log'),
}
const options = []
const recorded = ring({ ...cfg, spawn: (file, args, opts) => {
  options.push(opts)
  return { on() {}, unref() {} }
} }, 'RingRegression', 'body')
check('ring reports success', recorded === true)
check('ring spawns without detached', options.length === 1 && !options[0].detached,
  `options=${JSON.stringify(options[0])}`)
check('ring keeps stdio ignored so it never blocks the host',
  options[0]?.stdio === 'ignore')

// ---- 3. and the real thing actually fires ----
const before = (() => {
  try { return readFileSync(cfg.logFile, 'utf8').split('\n').filter(Boolean).length }
  catch { return 0 }
})()
ring(cfg, 'RingRegression', 'a real ring')
await new Promise((r) => setTimeout(r, 4000))
const after = (() => {
  try { return readFileSync(cfg.logFile, 'utf8').split('\n').filter(Boolean).length }
  catch { return 0 }
})()
check('a real ring is recorded', after > before, `${before} -> ${after}`)

console.log(failures === 0 ? '\nall spawn-mode checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
