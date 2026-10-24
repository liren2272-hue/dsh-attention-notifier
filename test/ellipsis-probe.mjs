/**
 * Does the real card truncate the body? Count the ellipsis it draws.
 *
 * Every attempt to reason about this from measurements has failed, and for an
 * instructive reason: PowerShell resolves `MeasureString(text, font, width)` to an
 * overload that ignores the width, so a standalone probe measures a constant
 * height regardless of the text column. The card itself calls the same thing, so
 * its own $need is suspect too — but its PAINT WALK is not. The walk measures each
 * span against $lw and draws "…" when it runs out of lines.
 *
 * So the ground truth is: did the card draw an ellipsis? This counts it, by
 * instrumenting the generated script to log every ellipsis draw. If a 54-character
 * body draws none, it was fully displayed and there is no truncation problem.
 *
 * This also settles whether the right inset needs to change at all for that
 * reason — the answer to "is content being lost" is not a measurement dispute, it
 * is a count.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { buildScript } from '../notify.js'

const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const dir = mkdtempSync(join(tmpdir(), 'attention-ellipsis-'))

const BODIES = {
  short: '已生成报告。',
  medium: '任务结束（completed）：已生成报告，共 12 页，导出路径见附件。',
  long: '这是一段用来测试换行的中文正文，长度恰好五十四个字符，需要验证在更窄的文字列里依然能够完整显示三行而不会被截断。',
  verylong: '这是一段更长的用来测试换行的中文正文，长度接近八十个字符，目的是确认当内容确实超过三行时卡片会截断并显示省略号而不是无限增长或者直接崩溃。',
}

/**
 * Count the ellipses a real card draws for a body.
 *
 * @param {string} name
 * @param {string} body
 * @returns {{ellipses: number, drew: boolean}}
 */
function countEllipses(name, body) {
  const out = join(dir, `${name}.txt`)
  const script = buildScript(
    { sound: false, popup: true, popupTimeoutMs: 2500, balloon: false, box: false, powershell: ps },
    'DeepSeek Harness',
    body,
  )

  // The walk draws "…" in two places when it runs out of lines. Replace each with
  // a call that also appends a marker, so the count is exact rather than inferred
  // from a screenshot.
  const marker = `Add-Content -LiteralPath '${out}' -Value 'ELLIPSIS' -Encoding utf8; `
  let instrumented = script
  let hits = 0
  instrumented = instrumented.replace(/\$gr\.DrawString\("…",\$fn,\$br,\$\w+,\$by\)/g, (match) => {
    hits += 1
    return `${marker}${match}`
  })
  if (hits === 0) {
    console.log(`FAIL ${name}: no ellipsis draw call found in the generated script`)
    return { ellipses: -1, drew: false }
  }

  const file = join(tmpdir(), 'dsh-attention', `ell-${name}-${process.pid}.ps1`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `\ufeff${instrumented}`, 'utf8')

  spawnSync(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: 'ignore', timeout: 25_000 })
  try { rmSync(file, { force: true }) } catch { /* disposable */ }

  const text = existsSync(out) ? readFileSync(out, 'utf8') : ''
  const ellipses = (text.match(/ELLIPSIS/g) ?? []).length
  return { ellipses, drew: ellipses > 0 }
}

console.log('Does the card truncate? (an ellipsis means the tail was cut)\n')
console.log('body      chars  ellipses  verdict')
let truncations = 0
for (const [name, body] of Object.entries(BODIES)) {
  const r = countEllipses(name, body)
  const verdict = r.ellipses < 0 ? 'probe failed' : r.ellipses === 0 ? 'fully shown' : `TRUNCATED (${r.ellipses})`
  if (r.ellipses > 0) truncations += 1
  console.log(`${name.padEnd(10)} ${String([...body].length).padEnd(5)} ${String(r.ellipses).padEnd(9)} ${verdict}`)
}

console.log(`
Reading: 'fully shown' means every character reached the screen. The medium body
(37 chars) is a realistic notification, and the long body (54) is the designer's
stress case; if either is TRUNCATED, the card is losing content and the fix is in
the height box, not in the text column.

The three-line cap is intended: a card must not grow to fit a paragraph. So the
verylong body SHOULD truncate — that is the feature working.`)

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* disposable */
}
