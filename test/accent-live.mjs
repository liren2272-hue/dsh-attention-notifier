/**
 * Photograph the real delivery path, one popup per tone.
 *
 * ring() is what the plugin actually calls, so this proves the colour the user
 * will see rather than the colour a test reads out of the script text. The grab
 * runs in a separate DPI-aware process because the spawner's own screen metrics
 * would otherwise be virtualised, and that process reports back whether the
 * frame it took actually contained the expected accent.
 *
 * Naive timing shot the wrong card twice: too early and the frame is still the
 * previous colour, too late and the frame is the desktop. So each tone retries
 * on a short cadence until the capturer confirms the colour, and a tone that
 * never verifies is reported as a failure instead of being written out as a
 * convincing but wrong picture.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ring } from '../notify.js'

const dir = join(process.cwd(), 'test', 'accent')
mkdirSync(dir, { recursive: true })

const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const capture = join(process.cwd(), 'test', 'capture-once.ps1')

const cfg = {
  sound: false,
  popup: true,
  popupTimeoutMs: 9000,
  balloon: false,
  box: false,
  powershell,
  soundFile: 'C:\\Windows\\Media\\notify.wav',
  logFile: '',
}

const cases = [
  ['ok', '任务结束（completed）', '蓝色条：这一轮任务成功完成', '79,110,247'],
  ['ask', '需要你选择', '橙色条：任务停下来等你决定', '245,158,11'],
  ['alert', '任务结束（error）', '红色条：任务失败或被中断', '239,68,68'],
]

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

let failures = 0
for (const [tone, title, body, rgb] of cases) {
  const fired = ring(cfg, title, body, null, tone)
  const out = join(dir, `shot-${tone}.png`)

  let verified = false
  let attempts = 0
  for (let i = 0; i < 8 && !verified; i += 1) {
    attempts += 1
    sleep(900)
    const shot = spawnSync(
      powershell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', capture, '-Out', out, '-Expect', rgb],
      { encoding: 'utf8', windowsHide: true },
    )
    verified = shot.status === 0
    if (!verified && shot.status !== 2) {
      console.log(`${tone}: capturer failed (${shot.status}) ${shot.stderr?.trim() ?? ''}`)
      break
    }
  }

  if (verified) {
    console.log(`${tone}: ring=${fired} verified on attempt ${attempts} (${rgb})`)
  } else {
    failures += 1
    console.log(`${tone}: ring=${fired} NOT VERIFIED after ${attempts} attempts (${rgb})`)
  }
  sleep(6500)
}

if (failures > 0) {
  console.log(`\n${failures} tone(s) could not be verified`)
  process.exitCode = 1
} else {
  console.log('\nall three tones verified on screen')
}
