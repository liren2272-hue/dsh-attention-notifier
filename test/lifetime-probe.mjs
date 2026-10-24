/**
 * Measures the card's real lifetime and its repaint count, in the real
 * PowerShell, against the real generated script.
 *
 * The bug this guards against: the popup never closed itself. The closing timer
 * and the repaint ticker were both built, given handlers and intervals, and
 * never Start()ed — a System.Windows.Forms.Timer is created STOPPED — so a card
 * configured for 10s sat on screen indefinitely with a frozen countdown bar.
 *
 * The script cannot be observed from outside, so it is instrumented: a repaint
 * counter and a closed-at timestamp are spliced in just before
 * `Application::Run($f)`, the whole thing is run synchronously, and the child's
 * own numbers are read back. That makes both halves falsifiable — "did it
 * close" and "did the bar move" — rather than inferred from a successful spawn.
 *
 * Two cards are run, because the fix must not overcorrect:
 *
 *   timed   (popupTimeoutMs=4000) — must close at ~4s and must repaint
 *   forever (popupTimeoutMs=0)    — must NOT close and must NOT repaint
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { buildScript } from '../notify.js'

const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const TIMEOUT_MS = 4000

const dir = mkdtempSync(join(tmpdir(), 'attention-lifetime-'))

const cfg = {
  sound: false,
  popup: true,
  popupTimeoutMs: TIMEOUT_MS,
  balloon: false,
  box: false,
  powershell: ps,
}

let failures = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures += 1
}

/**
 * Runs one card in the real PowerShell and reports what it did.
 *
 * Returns `{ closed, lifetime, paints }`, where `closed` is false when the
 * spawn timeout killed a still-open card — the correct outcome for a
 * wait-forever card, and the bug for a timed one.
 */
function runCard(label, overrides) {
  const marker = join(dir, `${label}.txt`)
  const script = buildScript(
    { ...cfg, ...overrides },
    'DeepSeek Harness',
    '自检：卡片应在 4 秒后自行消失，底部进度条同步走完。',
  )
  // The instrumentation MUST be spliced in before `Application::Run($f)`: that
  // call blocks for the card's entire life, so anything appended after it would
  // register its handlers only once the card was already gone — which is
  // exactly how the first draft of this probe produced a false failure.
  const instrumented = script.replace(
    '[System.Windows.Forms.Application]::Run($f)',
    [
      // The counter MUST live in $global:. `$script:` and `$f:` look like the
      // natural choices and both are wrong — measured on this machine, a
      // handler reading `$script:paints++` dies in ~0.5s, because PowerShell's
      // event callback scope chain does not include the scope the variable was
      // defined in, the increment on $null throws, and SilentlyContinue turns
      // that into a silently closing form. `$global:` is the only scope that
      // reaches the handler, and it is also what makes the forever-card case
      // falsifiable instead of an artifact of the probe.
      '$global:paints=0',
      // Counted from inside the card's own Paint, so a frozen bar (paints===0 or
      // 1) is distinguishable from a draining one.
      '$f.add_Paint({ $global:paints++ })',
      // FormClosed runs whether the card was closed by its timer, by Esc, or by
      // a click — and it already carries the ExitApplication the child needs,
      // so this only adds the measurement.
      `$f.add_FormClosed({ Set-Content -LiteralPath '${marker}' -Value "closed $([int](([DateTime]::Now-$script:t0).TotalMilliseconds)) $($global:paints)" -Encoding utf8 })`,
      '[System.Windows.Forms.Application]::Run($f)',
    ].join('\n'),
  )
  if (!instrumented.includes('$global:paints')) {
    check(`${label}: instrumentation spliced in`, false, 'the Run anchor was not found')
    return { closed: false, lifetime: 0, paints: 0, exit: null, elapsed: 0 }
  }

  const started = Date.now()
  const child = spawnSync(
    ps,
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', writeScript(instrumented, label)],
    // The DSH file sandbox denies piped stdio (EPERM); the plugin's own spawn
    // uses 'ignore' for the same reason, so this probe must match it.
    { stdio: 'ignore', timeout: 12_000 },
  )
  const text = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''
  const [verb, lifetimeStr, paintsStr] = text.split(/\s+/)
  return {
    closed: verb === 'closed',
    lifetime: Number(lifetimeStr) || 0,
    paints: Number(paintsStr) || 0,
    exit: child.status,
    elapsed: Date.now() - started,
  }
}

// ---- the timed card: the bug being fixed ---------------------------------
{
  const r = runCard('timed', { popupTimeoutMs: TIMEOUT_MS })
  console.log(`timed: exit=${r.exit} spawn-elapsed=${r.elapsed}ms lifetime=${r.lifetime}ms paints=${r.paints}`)
  check('the timed card closes itself', r.closed, `lifetime=${r.lifetime}ms`)
  // The clock starts at Shown, so a 4000ms timeout closes the card at ~4s of
  // VISIBLE time — not at process elapsed time, which includes 1.8-2.5s of
  // PowerShell startup and Add-Type compilation. The upper bound is generous
  // because a cold compiler adds time before the card even appears.
  check(
    'it closes at its configured timeout, not at process start',
    r.closed && r.lifetime >= 3000 && r.lifetime <= 6500,
    `${r.lifetime}ms for a ${TIMEOUT_MS}ms timeout`,
  )
  // A frozen bar means one paint. The ticker repaints every 100ms, so a 4s card
  // should have painted tens of times.
  check('the countdown bar actually moved (repainted)', r.paints > 5, `${r.paints} repaints`)
}

// ---- the wait-forever card: must NOT regress -----------------------------
//
// Measured separately (forever-probe.mjs): the pristine wait-forever card is
// still alive when a 20s spawn timeout kills it, and the counter variant agrees,
// so "no marker" here genuinely means "it never closed" rather than "the probe
// lost it". A paint counter written from inside the Paint handler once made this
// card die early — that was the probe's own bug, not the plugin's, and it is why
// the counter below is a plain in-memory variable flushed only at FormClosed.
{
  const r = runCard('forever', { popupTimeoutMs: 0 })
  console.log(`forever: exit=${r.exit} spawn-elapsed=${r.elapsed}ms lifetime=${r.lifetime}ms paints=${r.paints}`)
  check('a wait-forever card does not close itself', !r.closed, `lifetime=${r.lifetime}ms`)
  check('and it never repaints a bar it does not draw', r.paints === 0, `${r.paints} repaints`)
}

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* the temp dir is disposable */
}

console.log(failures === 0 ? '\nlifetime checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Writes the script to a temp file and returns its path. -EncodedCommand would
 * put the whole painted card on the command line, which is what broke delivery
 * once (ENAMETOOLONG); the plugin ships a -File for the same reason.
 */
function writeScript(body, label) {
  const file = join(tmpdir(), 'dsh-attention', `lifetime-${label}-${process.pid}.ps1`)
  mkdirSync(dirname(file), { recursive: true })
  // A BOM is what makes Windows PowerShell 5.1 read the file as UTF-8 rather
  // than ANSI. The body is pure ASCII, but the BOM is free insurance.
  writeFileSync(file, `\ufeff${body}`, 'utf8')
  return file
}
