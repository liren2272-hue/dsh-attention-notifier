import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { buildScript } from '../notify.js'
import { POPUP_PRESETS, popup, resolvePopup } from '../popup.js'
import { createHarness } from './harness.mjs'

let clock = 1_000_000
Date.now = () => clock

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** The script carries title then body, both base64; the last one is the body. */
function decodeBody(script) {
  const matches = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)]
  const last = matches.at(-1)?.[1] ?? ''
  return Buffer.from(last, 'base64').toString('utf8')
}

/**
 * The generated script now travels through a temp FILE rather than a base64
 * -EncodedCommand argument: the painted card outgrew the Windows command-line
 * limit (spawn failed with ENAMETOOLONG and the notifier went silent). So a test
 * reads the script back off disk, from the -File argument the plugin passed.
 */
function scriptFromArgs(args) {
  const i = args.indexOf('-File')
  if (i === -1) return ''
  const file = args[i + 1]
  try {
    return readFileSync(file, 'utf8').replace(/^\ufeff/, '')
  } catch {
    return ''
  }
}

function makeRings() {
  const rings = []
  const spawn = (file, args, options) => {
    rings.push({
      file,
      args,
      options,
      script: scriptFromArgs(args),
    })
    return { on() {}, unref() {} }
  }
  return { rings, spawn }
}

/**
 * Build a harness with the real `apply()` on top of a fake ctx.
 *
 * The diagnostics defaults are overridden HERE, not left to each scenario. Both
 * `ring()` and `write()` fall back to the machine-wide files in `%TEMP%` when
 * the config says nothing, so a suite that does not override them writes its own
 * noise into the very logs a human reads to answer "did it actually fire". That
 * is worse than a stray temp file: it fills the one artefact used to diagnose the
 * feature with thousands of lines that were never delivered to anyone. Scenarios
 * that test the trace pass their own `traceFile` and win by spreading after this.
 */
function setup({ config = {}, agents = [], tools = null, initiator = undefined, sessions = null } = {}) {
  const { rings, spawn } = makeRings()
  const harness = createHarness({ agents, tools, initiator, sessions })
  apply(harness.ctx, { spawn, logFile: '', trace: false, ...config })
  return { harness, rings }
}

/**
 * The card's headline, as it was handed to the painter.
 *
 * `buildScript` embeds the headline as the FIRST `FromBase64String` call and the
 * body as the last, so a test can read back exactly what the user would see
 * without running PowerShell.
 */
function decodeTitle(script) {
  const matches = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)]
  return Buffer.from(matches[0]?.[1] ?? '', 'base64').toString('utf8')
}

// ---- 1. script shape -------------------------------------------------------

{
  const script = buildScript(
    { sound: true, balloon: true, soundFile: 'C:\\Windows\\Media\\notify.wav' },
    'DeepSeek Harness',
    "需要你选择：'quoted' \"double\"",
  )
  check('title and body travel as base64', script.includes('[Convert]::FromBase64String('))
  check('raw body text never reaches the script literal', !script.includes('quoted'))
  check('plays the configured sound file', script.includes("SoundPlayer 'C:\\Windows\\Media\\notify.wav'"))
  check('shows a tray balloon tip', script.includes('ShowBalloonTip(6000,$title,$body'))
  const silent = buildScript({ sound: false, balloon: false }, 't', 'b')
  check(
    'both channels off produces neither sound nor balloon',
    !silent.includes('SoundPlayer') && !silent.includes('ShowBalloonTip'),
  )
}

// ---- 2. turn end rings with the last assistant summary ---------------------

{
  const { harness, rings } = setup()
  harness.emit('session/event', { id: 's1' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已生成报告，共 12 页。' }] } },
  })
  check('an assistant message alone does not ring', rings.length === 0, `rings=${rings.length}`)

  harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  check('turn end rings once', rings.length === 1, `rings=${rings.length}`)
  const body = decodeBody(rings[0]?.script ?? '')
  check('turn-end body names the reason', body.includes('completed'), body)
  check('turn-end body carries the summary', body.includes('已生成报告'), body)
}

// ---- 3. dedupe inside the quiet window ------------------------------------

{
  const { harness, rings } = setup({ config: { minIntervalMs: 4_000 } })
  harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  check('a repeat inside the quiet window rings once', rings.length === 1, `rings=${rings.length}`)

  clock += 5_000
  harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  check('a repeat after the quiet window rings again', rings.length === 2, `rings=${rings.length}`)
}

// ---- 4. a question rings, then nudges up to the cap ----------------------

{
  const { harness, rings } = setup({ config: { remindEveryMs: 120_000, maxReminders: 2 } })
  const answer = harness.waterfall('user-questions/request', {
    questions: [{ id: 'q1', question: '导出为 PDF 还是 Markdown？' }],
    agent: { id: 's1' },
  })
  check('a question rings immediately', rings.length === 1, `rings=${rings.length}`)
  check('the question body names what is being asked', decodeBody(rings[0].script).includes('导出为 PDF'))

  clock += 120_000
  await harness.fireTimer(0)
  check('an unanswered question nudges after remindEveryMs', rings.length === 2, `rings=${rings.length}`)
  check('the nudge says it is still waiting', decodeBody(rings[1].script).includes('仍在等待你的回应'))

  clock += 120_000
  await harness.fireTimer(0)
  check('nudges stop at maxReminders', rings.length === 3, `rings=${rings.length}`)
  check('no timer survives the cap', harness.businessTimers().length === 0, `live=${harness.businessTimers().length}`)

  harness.settleNext({ answers: [{ id: 'q1', selected: ['PDF'] }] })
  const settled = await answer
  check('the answerer chain still receives the human answer', settled?.answers?.[0]?.selected?.[0] === 'PDF')
}

// ---- 5. answering cancels the pending nudge ------------------------------

{
  const { harness, rings } = setup({ config: { remindEveryMs: 120_000, maxReminders: 3 } })
  const answer = harness.waterfall('user-questions/request', {
    questions: [{ id: 'q', question: '继续吗？' }],
    agent: { id: 's1' },
  })
  check('an open question schedules a nudge', harness.businessTimers().length === 1)
  harness.settleNext({ answers: [{ id: 'q', selected: ['是'] }] })
  await answer
  check('answering cancels the pending nudge', harness.businessTimers().length === 0, `live=${harness.businessTimers().length}`)
  check('only the first ring happened', rings.length === 1, `rings=${rings.length}`)
}

// ---- 6. approval rings with the localized reason -------------------------

{
  const { harness, rings } = setup()
  const outcome = harness.waterfall('approval/request', {
    agent: { id: 's1' },
    toolName: 'pwsh',
    displayReason: { en: 'Delete the build directory', zh: '删除构建目录' },
  })
  check('an approval request rings once', rings.length === 1, `rings=${rings.length}`)
  const body = decodeBody(rings[0].script)
  check('approval prefers the Chinese displayReason', body.includes('删除构建目录'), body)
  check('approval does not fall back to the English text', !body.includes('Delete the build directory'), body)

  harness.settleNext('allowed-once')
  check('the approval chain still decides', (await outcome) === 'allowed-once')
}

// ---- 7. delegated children stay silent -----------------------------------

{
  const child = { id: 'child', root: false }
  const { harness, rings } = setup({ agents: [child] })
  harness.emit('session/event', { id: 'child' }, { type: 'turn/end', data: { reason: 'completed' } })
  check('a delegated child finishing does not ring', rings.length === 0, `rings=${rings.length}`)

  const parent = setup({ agents: [{ id: 'root', root: true }] })
  parent.harness.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { reason: 'completed' } })
  check('the root agent finishing rings', parent.rings.length === 1, `rings=${parent.rings.length}`)
}

// ---- 8. every switch can be turned off ----------------------------------

{
  const { harness, rings } = setup({
    config: { notifyOnTurnEnd: false, notifyOnQuestion: false, notifyOnApproval: false },
  })
  harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  harness.waterfall('user-questions/request', { questions: [{ id: 'q', question: '?' }], agent: { id: 's1' } })
  harness.waterfall('approval/request', { agent: { id: 's1' }, toolName: 'pwsh' })
  check('all notifications off means silence', rings.length === 0, `rings=${rings.length}`)
  check('and no nudge timers either', harness.businessTimers().length === 0, `live=${harness.businessTimers().length}`)
}

// ---- 9. prompt guidance --------------------------------------------------

{
  const { harness } = setup()
  check('registers one prompt section', harness.sections.length === 1, `sections=${harness.sections.length}`)
  const text = harness.sections[0]?.text ?? ''
  check('guidance names the tool to use', text.includes('ask_user_question'))
  check('guidance says when a human decision is owed', text.includes('不可逆'))
  check('guidance tells the model not to ask about trivia', text.includes('不要为琐事提问'))
  const off = setup({ config: { askGuidance: false } })
  check('guidance can be switched off', off.harness.sections.length === 0)
}

// ---- 10. delivery failure is contained ----------------------------------

{
  const harness = createHarness()
  apply(harness.ctx, {
    logFile: '',
    trace: false,
    spawn: () => {
      throw new Error('boom')
    },
  })
  harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  check(
    'a failing spawn is logged rather than thrown',
    harness.logs.warn.some((line) => line.includes('could not ring')),
    JSON.stringify(harness.logs.warn),
  )
}

// ---- 11. endings the user caused stay quiet ------------------------------

{
  const { harness, rings } = setup({ config: { minIntervalMs: 0 } })
  harness.emit('session/event', { id: 's1' }, {
    type: 'turn/end',
    data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  check('the user pressing stop does not ring', rings.length === 0, `rings=${rings.length}`)

  harness.emit('session/event', { id: 's1' }, {
    type: 'turn/end',
    data: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'no observable progress for 60000ms' } } },
  })
  check('a step-watchdog interrupt does not ring', rings.length === 0, `rings=${rings.length}`)

  harness.emit('session/event', { id: 's1' }, {
    type: 'turn/end',
    data: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'deploy gate rejected the turn' } } },
  })
  check('an unrelated hook abort still rings', rings.length === 1, `rings=${rings.length}`)

  harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
  check('a failed turn rings', rings.length === 2, `rings=${rings.length}`)
}

// ---- 12. the config surface is safe to hand-edit -------------------------

{
  // A patch row is plain YAML, so a typo is accepted and then silently ignored.
  // Naming the unknown key is the difference between "I turned it off" and
  // "the plugin is broken".
  const harness = createHarness()
  apply(harness.ctx, { popupMS: 5000, notifyOnQuestion: true, logFile: '', trace: false })
  check(
    'an unknown config key is named, not swallowed',
    harness.logs.warn.some((line) => line.includes('unknown config key') && line.includes('popupMS')),
    JSON.stringify(harness.logs.warn),
  )

  // ...but injection points must still pass through: the harness ships `spawn`
  // through the same object, and dropping it would break every test above.
  const { rings, spawn } = makeRings()
  const injected = createHarness()
  apply(injected.ctx, { spawn, logFile: '', trace: false })
  injected.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  check('an injected key still reaches the plugin', rings.length === 1, `rings=${rings.length}`)
}

{
  // popupMs is a FLOOR on the visible time; popupTimeoutMs is the value that
  // decides when the card leaves. Both are clamped so a hand-edited patch
  // cannot brick delivery, and maxReminders=999 would nag forever otherwise.
  const { harness, rings } = setup({ config: { popupMs: 0, maxReminders: 999, minIntervalMs: -50 } })
  const script = buildScript(
    { popup: true, popupMs: 0, popupTimeoutMs: 0, sound: false, balloon: false, box: false },
    't',
    'b',
  )
  check('a zero popup duration is clamped up', !/\$timer\.Interval=0\b/.test(script), 'popupMs=0')

  harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  const popupScript = rings[0]?.script ?? ''
  // The shipped default is now 10s: a card that never leaves accumulates in the
  // corner and gives the human no sense of how stale it is. So the default run
  // must arm the closing timer with exactly 10000, not park it.
  const interval = /\$timer\.Interval=\[int\]::MaxValue/.test(popupScript)
    ? 'parked'
    : Number(/\$timer\.Interval=(\d+)/.exec(popupScript)?.[1] ?? 0)
  check('the default card closes itself after 10s', interval === 10_000, String(interval))
  check(
    'a negative quiet window cannot deadlock delivery',
    harness.logs.warn.some((line) => line.includes('clamped')),
    JSON.stringify(harness.logs.warn),
  )

  // popupMs must not be a dead switch. It used to be the only knob and was left
  // in the config surface when popupTimeoutMs took over, so turning it changed
  // nothing — the worst outcome for a hand-edited patch. As a floor it is real:
  // a timeout below it is raised to it, and it can never pull the timeout DOWN
  // (0 and nonsense are ignored).
  const raised = buildScript(
    { popup: true, popupMs: 30_000, popupTimeoutMs: 2000, sound: false, balloon: false, box: false },
    't',
    'b',
  )
  check('popupMs raises a too-short timeout up to the floor', /\$timer\.Interval=30000\b/.test(raised))
  const ignored = buildScript(
    { popup: true, popupMs: 2000, popupTimeoutMs: 30_000, sound: false, balloon: false, box: false },
    't',
    'b',
  )
  check('popupMs never pulls a longer timeout down', /\$timer\.Interval=30000\b/.test(ignored))
  const nonsense = buildScript(
    { popup: true, popupMs: 'abc', popupTimeoutMs: 5000, sound: false, balloon: false, box: false },
    't',
    'b',
  )
  check('a nonsense popupMs is ignored, not obeyed', /\$timer\.Interval=5000\b/.test(nonsense))
  // 0 means "wait for the human" and must win over the floor entirely.
  const forever = buildScript(
    { popup: true, popupMs: 9000, popupTimeoutMs: 0, sound: false, balloon: false, box: false },
    't',
    'b',
  )
  check('popupTimeoutMs=0 stays parked even with a popupMs floor', /\$timer\.Interval=\[int\]::MaxValue/.test(forever))
}

{
  // The trace writes on every listener entry. It has to be switchable off, or
  // a notifier becomes the thing filling the temp directory.
  const harness = createHarness()
  apply(harness.ctx, { trace: false, logFile: '' })
  check(
    'diagnostics can be switched off',
    !harness.logs.info.some((line) => line.includes('writing diagnostics')),
    JSON.stringify(harness.logs.info),
  )
  const on = createHarness()
  apply(on.ctx, { trace: true, logFile: '', traceFile: 'C:\\nonexistent-dir\\deep\\trace.log' })
  check(
    'a custom trace file is honoured',
    on.logs.info.some((line) => line.includes('C:\\nonexistent-dir\\deep\\trace.log')),
    JSON.stringify(on.logs.info),
  )
}

// ---- 13. the accent rule carries the meaning ----------------------------
//
// Blue = finished, orange = blocked on you, red = failed or interrupted. The
// rule is the only thing readable from the corner of an eye, so each event
// class must land on its own colour; two classes sharing one would make the
// distinction unreachable without reading the text.

{
  const SUCCESS = '79,110,247'
  const ASK = '245,158,11'
  const ALERT = '239,68,68'

  /**
   * The accent is the one FromArgb(r,g,b) triplet the painted card resolves for
   * $script:accent, so reading it back is how a test sees the colour the user
   * will actually see.
   */
  function accentOf(script) {
    const m = /\$script:accent=\[System\.Drawing\.Color\]::FromArgb\((\d+),(\d+),(\d+)\)/.exec(script ?? '')
    return m === null ? null : `${m[1]},${m[2]},${m[3]}`
  }

  /** Apply the plugin with a spawn that keeps the generated scripts. */
  function recorder(config = {}) {
    const scripts = []
    const harness = createHarness()
    apply(harness.ctx, {
      ...config,
      logFile: '',
      trace: false,
      spawn: (_file, args) => {
        scripts.push(scriptFromArgs(args))
        return { on() {}, unref() {} }
      },
    })
    return { harness, scripts, check: (label, expected) => check(label, accentOf(scripts[0]) === expected, String(accentOf(scripts[0]))) }
  }

  const question = recorder()
  question.harness.waterfall('user-questions/request', {
    questions: [{ id: 'q', question: '选哪个？' }],
    agent: { id: 'r' },
  })
  question.check('a question uses the ask accent', ASK)

  const approval = recorder()
  approval.harness.waterfall('approval/request', { agent: { id: 'r' }, toolName: 'pwsh' })
  approval.check('an approval uses the ask accent', ASK)

  const completed = recorder()
  completed.harness.emit('session/event', { id: 'r' }, { type: 'turn/end', data: { reason: 'completed' } })
  completed.check('a completed turn uses the success accent', SUCCESS)

  for (const [label, reason] of [
    ['a failed turn', { kind: 'error' }],
    ['a hook-aborted turn', { kind: 'aborted', reason: { kind: 'hook', reason: 'gate rejected' } }],
  ]) {
    const run = recorder()
    run.harness.emit('session/event', { id: 'r' }, { type: 'turn/end', data: { reason } })
    run.check(`${label} uses the alert accent`, ALERT)
  }

  // An unknown tone must not throw inside delivery; it degrades to success.
  check(
    'an unknown tone falls back to the success accent',
    accentOf(buildScript({ popup: true, sound: false, balloon: false, box: false }, 't', 'b', 'nonsense')) === SUCCESS,
  )

  // A nudge repeats the request, so it keeps that request's colour.
  {
    const scripts = []
    const harness = createHarness()
    apply(harness.ctx, {
      remindEveryMs: 60_000,
      maxReminders: 1,
      logFile: '',
      trace: false,
      spawn: (_file, args) => {
        scripts.push(scriptFromArgs(args))
        return { on() {}, unref() {} }
      },
    })
    harness.waterfall('user-questions/request', {
      questions: [{ id: 'q', question: '继续吗？' }],
      agent: { id: 'r' },
    })
    const live = harness.businessTimers()
    if (live.length > 0) live[0].callback()
    check('a nudge keeps the ask accent', accentOf(scripts[1]) === ASK, String(accentOf(scripts[1])))
  }
}

// ---- 14. layout survives a scaled display ----------------------------------
//
// Found the hard way: the title label was a fixed 22px tall. On a 150% display
// a 10pt CJK line is taller than that, and a Label with AutoEllipsis that
// cannot fit one line paints NOTHING — the card showed its body and no title.
// These guards keep the layout tied to the fonts and to the real DPI.

{
  const script = buildScript({ popup: true, sound: false, balloon: false, box: false }, 't', 'b')

  check('the popup reads the display scale instead of assuming 96 DPI', script.includes('$k=$gfx.DpiX/96'))
  // The card is painted, not composed from Labels: type metrics come from the
  // real fonts so line boxes cannot be too short at any scale factor.
  check(
    'the title line box is derived from its font',
    script.includes('$headH=[int][Math]::Ceiling($hf.GetHeight($gfx))'),
  )
  check(
    'the body line box is derived from its font',
    script.includes('$lineH=[int][Math]::Ceiling($bf.GetHeight($gfx))'),
  )
  // A line box must be CEILED, not truncated. `[int]` on a 19.30px line height
  // gives a 19px box, one pixel short of the line it must hold — and under
  // `LineLimit` GDI+ then paints that line as NOTHING. Worse, it fails by
  // script: Latin still draws (its ascender/descender fits) while CJK draws
  // nothing, so an English eyebrow survived and a Chinese one vanished with no
  // other visible difference. Every GetHeight() line box has to be ceiled.
  {
    const boxes = [...script.matchAll(/\$(lineH|headH|brandH)=\[int\](.*)/g)]
    check(
      'every line box is ceiled, not truncated',
      boxes.length >= 3 && boxes.every(([, , rest]) => rest.startsWith('[Math]::Ceiling(')),
      JSON.stringify(boxes.map(([all]) => all.trim())),
    )
  }
  check(
    'the card height follows the message',
    // The height comes from SIMULATING the walk: the same character-by-character
    // accumulation the painter uses, counted into lines and times $lineH.
    //
    // It is deliberately NOT a MeasureString call. `MeasureString(text,font,int)`
    // — and the SizeF form — resolve in PowerShell to overloads that ignore the
    // width and return the height of UNWRAPPED text, so they report fewer lines
    // than the walk paints. That mismatch reserved a two-line box for a body that
    // wraps to three, and the third line was painted past the card's bottom edge:
    // the vertical overflow, which no amount of margin tuning touched. Sharing one
    // loop between measuring and painting is what stops them drifting again.
    script.includes('$simLines=1') &&
      script.includes('$simW+=$gfx.MeasureString([string]$ch,$bf).Width') &&
      script.includes('$need=$simLines*$lineH') &&
      script.includes('$bodyH=[Math]::Max($lineH*2,'),
  )
  check('the body is capped at three lines so a paragraph cannot stretch the card', script.includes('$lineH*3'))
  // The line budget must be enforced BEFORE $by advances, and the overflow
  // ellipsis must be drawn at the last painted line's own y.
  //
  // The bug this locks out: the wrap branch advanced $by and only then broke, so
  // $by sat one line BELOW the last painted line and the "…" was drawn at that
  // out-of-box y — a mark on top of the countdown hairline, which is exactly what
  // a four-line body looked like. Skipping the advance (not merely the draw) is
  // what keeps the ellipsis inside the body box.
  check(
    'the line budget is checked before the walk advances',
    script.includes('if($lineUsed+1 -ge $maxLines){ $run=""; $runW=0; break }'),
  )
  check(
    'the overflow ellipsis sits on the last painted line, not below it',
    // The condition is "text left over", not "counter at max": the budget check
    // now fires BEFORE the counter increments, so at bail-out $lineUsed is still
    // one short and testing it suppressed the ellipsis entirely — a truncated body
    // simply stopped mid-sentence with no sign that more existed.
    script.includes('if($ci -lt $txt.Length){ $gr.DrawString("…",$fn,$br,$bx,$by) }') &&
      // ...and it must use the running $bx of that line, never a reset $tx.
      !script.includes('$gr.DrawString("…",$fn,$br,$tx,$by)'),
  )
  check('the card stays inside the working area', script.includes('$wa.Right-$w-'))
  // The right inset is deliberately WIDER than the left, and this is the
  // assertion that keeps it that way. The text column already starts after a 42px
  // tile and a 13px gutter, so a symmetric 17px inset on the right read as text
  // crowded against the edge even though the margin was the same number. Anything
  // that ends at the text column's right edge — the wrap width, the status chip,
  // the countdown hairline — must use $padR, or that element sits out of line
  // with the text beside it.
  //
  // 40 is also a measured CEILING: below a 326px text column a 54-char body stops
  // fitting the three-line box and starts getting ellipsised, so "wrap earlier"
  // would silently become "lose content". The upper bound in this assertion is
  // what stops a well-meaning "more space" edit from crossing it.
  check(
    'the text column keeps a wider inset on the right than the left',
    script.includes('$padR=[int](28*$k)') &&
      script.includes('$lw=$w-$tx-$padR') &&
      // 40 must actually be greater than 17, not just different.
      Number(/padR=\[int\]\((\d+)\*\$k\)/.exec(script)?.[1] ?? 0) >
        Number(/padX=\[int\]\((\d+)\*\$k\)/.exec(script)?.[1] ?? 0),
  )
  check('the status chip hangs off the text column’s right edge, not the card’s',
    script.includes('$cx=$w-$padR-$cw'))
  // The chip's internal spacing. The old formula (`tw+18`) left ONE pixel between
  // the text and the right edge — 17 of those 18px was spent positioning the text
  // after the dot — so a four-character status sat hard against the border. The
  // padding is now stated as the space wanted around the dot-and-text group:
  // 10 to the dot, 6 from dot to text, 10 after the text. These assertions pin
  // the three gaps rather than the derived width, because the width is `tw+32`
  // only if all three hold.
  check(
    'the status chip has breathing room on both sides of its text',
    script.includes('$cw=$tw+[int](32*$k)') &&
      script.includes('$db=[int](6*$k)') &&
      // dot sits 10px in, text starts 22px in -> 6px between them
      script.includes('$gr.FillEllipse($gb,($cx+[int](10*$k))') &&
      script.includes('$gr.DrawString($script:statusText,$cf,$ctb,($cx+[int](22*$k))'),
  )
  check(
    'the chip is taller so the text is not vertically cramped',
    Number(/chipH=\[int\]\((\d+)\*\$k\)/.exec(script)?.[1] ?? 0) >= 24,
  )
  // The dot must stay vertically centred in the chip, which is computed from
  // $chipH — if someone hardcodes a y offset instead, a taller chip would leave
  // the dot drifting.
  check(
    'the chip dot stays vertically centred',
    script.includes('($cy+$chipH/2-$db/2)'),
  )
  check('the countdown hairline spans the content, so it ends at the text margin',
    script.includes('RR $padX $ty ($w-$padX-$padR)'))
  // A long headline must ellipsise rather than run into the edge.
  //
  // The headline is trimmed by hand — measuring the accumulated run, exactly as
  // the body walk does — instead of delegating to GDI+'s EllipsisCharacter.
  // GDI+ compares the PADDED per-character width against the box, so it cuts a
  // run that already fits (giving up a character it had room for) and, on the
  // flip side, leaves a run that genuinely overflows with no ellipsis at all.
  // Both are "the bold title is too long and shows no …", which is what this
  // reports.
  check('a long headline is trimmed to the text column',
    script.includes('$gr.DrawString($hrun+"…",$hf,$tb2,$tx,$headY)') &&
      // the ellipsis' own width must be reserved while trimming, not appended after
      script.includes('if(($gr.MeasureString($hrun+"…",$hf).Width) -le $tw2){ break }') &&
      !script.includes('$gr.DrawString($title,$hf,$tb2,(New-Object System.Drawing.RectangleF($tx,$headY,$tw2,$headH)),$tfmt)'))
  // The headline's box must END AT THE CHIP, not at the card's right margin.
  //
  // The bug this locks out: the headline was laid out to the full text column
  // `$lw`, which runs to the same right edge the "已完成" chip is pinned to — so
  // a long conversation name put its last characters directly under the chip.
  // No pixel overlapped, but the text visibly collided with the badge. `$tw2` is
  // derived from the chip's own left edge ($cx) minus a 12px gap, so the two
  // columns line up at every title length.
  check('the headline stops short of the status chip',
    script.includes('$tw2=[int]($cx-$tx-[int](12*$k))') &&
      // ...and the clamp must still fall back to the full column when the chip
      // is so wide that the remaining box could not hold a word: a sliver of a
      // headline is worse than a slightly crowded one.
      script.includes('if($tw2 -lt [int](40*$k)){ $tw2=$lw }'),
  )
  // THE EYEBROW ORDERING GUARD.
  //
  // `$bw` is `$cx - $tx - 8k`, so the chip's left edge has to be computed
  // BEFORE the eyebrow is drawn. When the eyebrow came first, PowerShell read
  // the unset `$cx` as 0, the subtraction went negative, the 12px floor took
  // over, and the product line was painted into a sliver too narrow for one
  // glyph — an eyebrow that occupied its row and showed nothing, which read as
  // "the small DeepSeek Harness line disappeared".
  check('the chip is measured before the eyebrow that depends on it',
    script.indexOf('$cx=$w-$padR-$cw') < script.indexOf('$bw=[int]($cx-$tx-'),
  )
  check('the eyebrow is clamped to the chip and ellipsised',
    script.includes('$bw=[int]($cx-$tx-[int](8*$k))') &&
      script.includes('$bft.Trimming=[System.Drawing.StringTrimming]::EllipsisCharacter') &&
      script.includes('$bft.FormatFlags=[System.Drawing.StringFormatFlags]::LineLimit') &&
      script.includes('$gr.DrawString($brandName,$sf,$sb,'),
  )
  // The eyebrow is the PRODUCT line and the headline is the CONVERSATION — two
  // different strings. Sharing one variable is what printed "DeepSeek Harness"
  // as the headline on every card.
  check('the eyebrow paints the brand, never the headline',
    script.includes('$brandName=') && !script.includes('$gr.DrawString($title,$sf,'),
  )
  // Every glyph, tile, chip and hairline now comes from one Paint handler.
  check('the card is drawn by a single Paint handler', script.includes('$f.Add_Paint({'))
  check(
    'the card has a rounded body rather than square corners',
    script.includes('function RR($x,$y,$ww,$hh,$r)') && script.includes('AddArc'),
  )
  check(
    'the semantic accent reaches the painted card',
    script.includes('$script:accent=[System.Drawing.Color]::FromArgb('),
  )
}

// ---- 15. popup stays on top ------------------------------------------------
//
// Two failures were measured on this machine, and the guards below lock in the
// fix for each so a rewrite cannot quietly drop either:
//
//   a. WS_EX_TOPMOST can be lost. `$f.TopMost=$true` only turns into the style
//      bit while the handle is being created, and under ShowDialog's modal loop
//      the card's own process was observed reporting ex=0x10000 (plain window)
//      with a shell overflow island covering it. Writing the bit via
//      SetWindowLong is what made it persist.
//
//   b. SetWindowPos(HWND_TOPMOST) on an already-topmost window does NOT reorder
//      z-order. Windows sees the window is in the right band already and does
//      nothing, so the old "re-assert topmost every 250ms" timer was a no-op —
//      and any topmost window created afterwards by another application (Office
//      raises its own) stayed above the card for good. Dropping to
//      HWND_NOTOPMOST and coming back is the only way to move to the top of the
//      band, which is the bug the user reported as "not really always on top".

{
  const script = buildScript({ popup: true, sound: false, balloon: false, box: false }, 't', 'b')

  check('the form is declared topmost', script.includes('$f.TopMost=$true'))
  check(
    'a SetTopmost helper writes the WS_EX_TOPMOST bit directly',
    script.includes('function SetTopmost($h){') &&
      script.includes('GetWindowLong($h,-20)') &&
      /\$ex -bor 0x8/.test(script) &&
      script.includes('SetWindowLong($h,-20,$ex2)'),
  )
  // The Shown handler also starts the closing/repaint timers, so this asserts
  // the shape rather than one exact string: the handler must exist, must call
  // SetTopmost on the form's handle, and must not have been demoted to a
  // no-op handler that only re-asserts topmost.
  check(
    'the topmost bit is asserted when the form is shown',
    /\$f\.Add_Shown\(\{ SetTopmost \$f\.Handle/.test(script) &&
      !script.includes('$f.Add_Shown({})'),
  )
  // The z-order fix: NOTOPMOST (-2) then TOPMOST (-1). Without the -2 hop the
  // -1 call is ignored for an already-topmost window and an Office surface
  // stays on top of the card forever.
  check(
    're-entering the topmost band drops to NOTOPMOST first',
    script.includes('[IntPtr]::new(-2)') && script.includes('[IntPtr]::new(-1)'),
  )
  check(
    'the NOTOPMOST hop comes BEFORE the TOPMOST call',
    /new\(-2\),0,0,0,0,0x413\)[^\n]*new\(-1\),0,0,0,0,0x413\)/.test(script),
  )
  check(
    'z-order changes are sent with SWP_NOSENDCHANGING so a host cannot veto them',
    script.includes('0x413'),
  )
  check(
    'no reliance on SetWindowPos alone',
    !/\$null=\[AttentionDpi\]::SetWindowPos\(\$f\.Handle,\[IntPtr\]::new\(-1\),0,0,0,0,0x13\)\s*$/m.test(script),
  )
  // The card has to survive a foreground application that is not the harness.
  // PowerPoint in slideshow (and any full-screen app) paints over every
  // non-topmost window, and a plain topmost window still loses to a later
  // topmost one. The WS_EX_TOOLWINDOW bit is what makes the card un-coverable
  // and un-focusable at the same time, so it is asserted with the topmost bit
  // rather than left to the form property.
  check(
    'the card is a tool window so a full-screen app cannot bury it',
    /\(\$ex -bor 0x8\) -bor 0x80/.test(script),
  )
  // WS_EX_NOACTIVATE is set through the Form's CreateParams, i.e. as part of the
  // window's birth style, and that placement is the whole point. Written onto a
  // live window with SetWindowLong it destroyed the card (measured 7-21ms
  // lifetimes); present at creation it is safe and keeps the foreground where it
  // was. So the assertion is about WHERE the bit lives, not whether it exists.
  check(
    'the no-activate bit is set at window creation, not patched on afterwards',
    script.includes('cp.ExStyle|=0x08000000'),
  )
  check(
    'the card is a QuietCard subclass so it shows without activation',
    script.includes('public class QuietCard:Form') &&
      script.includes('ShowWithoutActivation'),
  )
  check(
    'the live window style is NOT patched with the no-activate bit later',
    !script.includes('$ex2=($ex -bor 0x8) -bor 0x80) -bor 0x08000000') &&
      !/-bor 0x08000000; \[void\]\[AttentionDpi\]::SetWindowLong/.test(script),
  )
  check(
    'focus is kept off the foreground app via SWP_NOACTIVATE on z-order calls',
    script.includes('0x413'),
  )
  check(
    'the topmost bit is re-asserted fast enough to never visibly vanish',
    /\$topmost\.Interval=250/.test(script),
  )
  // Two traps, both measured, both encoded here.
  //
  // 1. Polarity: repair when something IS above. A revision had it inverted
  //    (`-eq [IntPtr]::Zero`), so a covered card was never repaired — the bug
  //    where even the plain, non-topmost DSH window sat on the card.
  // 2. Invisible windows: explorer's ForegroundStaging window sits above every
  //    topmost window in z-order and is permanently invisible. Comparing the
  //    raw GW_HWNDPREV against zero therefore never reports "clear", and the
  //    repair fires forever. AssertTop must walk past invisible windows.
  check(
    'the repair condition is positive, not inverted',
    !script.includes('GetWindow($h,3) -eq [IntPtr]::Zero'),
  )
  check(
    'the repair walks past invisible windows before deciding',
    script.includes('-not [AttentionDpi]::IsWindowVisible($p)') &&
      script.includes('function AssertTop($h){'),
  )
  check(
    'the repair is driven by the topmost timer',
    script.includes('$topmost.add_Tick({ AssertTop $f.Handle })'),
  )
  // The flicker fix. SetTopmost's repair is a real reorder (NOTOPMOST ->
  // TOPMOST is the only way to move an already-topmost window), so an
  // unthrottled repair on a 250ms timer reorders the card ~4 times a second for
  // its whole life — measured at 17 reorders during a 4s card. That is the
  // flicker the animation introduced, and it is z-order, not repaint: double
  // buffering and partial invalidation were both measured against it and left
  // the count unchanged at 17.
  //
  // So the repair must be throttled to at most once per second. These assertions
  // lock in the guard, the window, and — critically — that the guard RETURNS
  // rather than falling through to the repair.
  check(
    'the z-order repair is throttled so the card is not reordered 4x a second',
    /\$script:lastFix=\[DateTime\]::MinValue/.test(script) &&
      /function AssertTop\(\$h\)\{ if\(\(\(\[DateTime\]::Now-\$script:lastFix\)\.TotalMilliseconds\) -lt 1000\)\{ return \}/.test(script) &&
      /\$script:lastFix=\[DateTime\]::Now/.test(script),
  )
  // The stamp must live in $script:, not $global:. AssertTop is an ordinary
  // function so $script: reaches it, and a card must not leak state into the
  // child process's global scope for a value that dies with the form.
  check(
    'the throttle stamp is scoped to the script, not the process',
    script.includes('$script:lastFix') && !script.includes('$global:lastFix'),
  )
  // Double buffering kills the OTHER flicker: GDI+ erases to BackColor and
  // repaints, so the card flashes its flat background between frames. It is set
  // from C# in the QuietCard constructor, and that placement is load-bearing —
  // measured: `$f.SetStyle(...)` from PowerShell THROWS (protected method), and
  // under SilentlyContinue that is invisible, which is how a "double-buffered"
  // card once shipped with no double buffering and kept flickering. So the
  // assertion is about WHERE the style lives, never about a PowerShell call.
  check(
    'double buffering is set inside the QuietCard constructor, not from PowerShell',
    /public QuietCard\(\)\{SetStyle\(ControlStyles\.OptimizedDoubleBuffer\|ControlStyles\.AllPaintingInWmPaint,true\);\}/.test(script),
  )
  check(
    'the background erase that flashes the card is suppressed',
    script.includes('protected override void OnPaintBackground(System.Windows.Forms.PaintEventArgs e){}'),
  )
  // The corners are cut out of the window, not painted over. This is the fix for
  // the black wedges that appeared once the erase was suppressed: a
  // double-buffered window starts out black, and Paint only fills the rounded
  // path, so anything outside that path keeps the buffer's black.
  //
  // The assertion is about the SHAPE matching the drawing, not merely that a
  // region exists: a rectangular region, or one with a different radius than the
  // Paint handler's card, would bring the wedges back at a different size. So the
  // region must be the same RR helper with the same bounds and radius as
  // `$card=RR 0 0 ($w-1) ($h-1) ([int](13*$k))`.
  check(
    'the corners are cut from the window itself, with the card’s exact shape',
    /\$f\.Region=New-Object System\.Drawing\.Region\(\(RR 0 0 \(\$w-1\) \(\$h-1\) \(\[int\]\(13\*\$k\)\)\)\)/.test(script),
  )
  // A region is expressed in the form's own coordinates, so it must be set after
  // the form has a size — and after RR exists, since that is what builds it.
  check(
    'the region is set after the card has its size',
    script.indexOf('$f.Region=') > script.indexOf('$f.Size=') &&
      script.indexOf('$f.Region=') > script.indexOf('function RR('),
  )
  // ...and the anti-aliased corner band needs something correct to blend against.
  // The card is drawn with SmoothingMode=AntiAlias, so the rounded edge is a band
  // of partially transparent pixels. With OnPaintBackground suppressed (the
  // flicker fix) the double buffer starts out pure BLACK, so that band was
  // blending toward black and read as a dark ring inside the corners. Filling
  // the client area with the card's own darkest tone first is the fix.
  check(
    'the anti-aliased corner band blends against the card’s own tone',
    /\$base=New-Object System\.Drawing\.SolidBrush\(\[System\.Drawing\.Color\]::FromArgb\(26,28,34\)\)/.test(script) &&
      /\$gr\.FillRectangle\(\$base,0,0,\$w,\$h\)/.test(script) &&
      // ...and it must land BEFORE the gradient card is painted over it.
      script.indexOf('$gr.FillRectangle($base') < script.indexOf('$gr.FillPath($bg,$card)'),
  )
  // The base brush is created per repaint, so it must be disposed with the rest.
  check(
    'the base brush is disposed with the others',
    /\$base\.Dispose\(\); \$bg\.Dispose\(\)/.test(script),
  )
  // ...and the broken call must not come back.
  check(
    'no attempt to call the protected SetStyle from PowerShell',
    !/\$f\.SetStyle\(/.test(script) && !/\$f\.DoubleBuffered\s*=/.test(script),
  )
  // ShowDialog's modal loop collapses when WS_EX_TOOLWINDOW is set (measured:
  // ~11ms lifetime vs 2547ms plain), so the card must be pumped with
  // Application::Run instead. Both halves are asserted: no ShowDialog, and a
  // close handler that actually exits the message loop.
  check('the card is pumped with Application::Run, not ShowDialog', !script.includes('ShowDialog') && script.includes('Application]::Run($f)'))
  check(
    'closing the card exits the message loop so the child terminates',
    script.includes('Application]::Exit()') && script.includes('$f.Add_FormClosed('),
  )
  // GetWindowLong(GWL_EXSTYLE) was measured returning the TOPMOST bit clear for
  // a window that was provably painting topmost, so any guard keyed on that
  // readback decides wrongly. The style must be written unconditionally.
  check(
    'no z-order guard depends on reading back the TOPMOST style bit',
    !/GetWindowLong\(\$h,-20\)[^;]*; if/.test(script),
  )
}

// ---- 16. the card's lifetime and its dismissal paths ------------------------
//
// History: the default once became "wait for the human" because a card that
// vanished after 9s before the user looked was the whole complaint. That
// overcorrected — cards that never leave accumulate in the corner. The shipped
// default is now an explicit 10s, short enough not to pile up, long enough to
// be noticed; 0 still means "stay until dismissed", and Esc/click always work.

{
  const forever = buildScript({ popup: true, popupTimeoutMs: 0, sound: false, balloon: false, box: false }, 't', 'b')
  check(
    'a card with no timeout parks its closing timer instead of arming it',
    /\$timer\.Interval=\[int\]::MaxValue/.test(forever),
    'popupTimeoutMs=0',
  )
  check('a card can still be dismissed with Esc', forever.includes('$f.KeyPreview=$true') && /KeyCode -eq 'Escape'/.test(forever))
  // One handler on the form, not one per Label: the whole card is painted now,
  // so there are no child controls left to swallow the click.
  check(
    'clicking the card closes it',
    (forever.match(/Send-Jump; FocusDsh; \$f\.Close\(\)/g) ?? []).length === 1,
  )
  // A wait-forever card must not run the repaint timer at all.
  check('a card with no timeout runs no repaint timer', forever.includes('$script:tickr=$null'))

  const bounded = buildScript({ popup: true, popupTimeoutMs: 12_000, sound: false, balloon: false, box: false }, 't', 'b')
  check(
    'a positive timeout still arms the closing timer',
    /\$timer\.Interval=12000\b/.test(bounded),
  )
  check('a timed card repaints its countdown', bounded.includes('$script:tickr.add_Tick({ $f.Invalidate() })'))

  // A System.Windows.Forms.Timer is created STOPPED. Building one, giving it a
  // Close handler and an interval is not enough — without Start() it never
  // ticks, which is exactly how the shipped card ended up stuck on screen
  // forever with a frozen countdown bar. Both timers must be started, and from
  // Shown so the timeout is charged against visible time rather than the
  // child's PowerShell startup.
  check(
    'the closing timer is actually started',
    /\$timer\.Start\(\)/.test(bounded),
  )
  check(
    'the repaint ticker is actually started',
    /\$script:tickr\.Start\(\)/.test(bounded),
  )
  check(
    'both timers are started from Shown, not at script top level',
    /Add_Shown\(\{ SetTopmost \$f\.Handle; \$timer\.Start\(\); if\(\$script:tickr\)\{ \$script:tickr\.Start\(\) \} \}\)/.test(bounded),
  )
  // ...and the wait-forever card must NOT start a repaint ticker it does not
  // have, nor close itself early.
  check(
    'a wait-forever card starts no timers on Shown',
    !/\$timer\.Start\(\)/.test(forever) && !/\$script:tickr\.Start\(\)/.test(forever),
  )

  // A fractional or nonsense value must not produce a NaN interval, which
  // would close the card immediately (or never) and be invisible in the script.
  for (const bad of ['abc', undefined, null, -5, 1.9]) {
    const script = buildScript({ popup: true, popupTimeoutMs: bad, sound: false, balloon: false, box: false }, 't', 'b')
    const interval = /\$timer\.Interval=\[int\]::MaxValue/.test(script)
      ? 'parked'
      : Number(/\$timer\.Interval=(\d+)/.exec(script)?.[1] ?? NaN)
    const ok = interval === 'parked' || (Number.isFinite(interval) && interval >= 1000)
    check(`popupTimeoutMs=${String(bad)} yields a sane interval`, ok, String(interval))
  }

  // The host half: the key must survive resolveConfig's clamp rather than be
  // dropped as unknown, and a hand-edited 0 must not be clamped up to 1000.
  const clampedHost = createHarness()
  apply(clampedHost.ctx, { popupTimeoutMs: 0, logFile: '', trace: false })
  check(
    'popupTimeoutMs=0 is not reported as an unknown key',
    !clampedHost.logs.warn.some((line) => line.includes('popupTimeoutMs')),
    JSON.stringify(clampedHost.logs.warn),
  )
  const tooLong = createHarness()
  apply(tooLong.ctx, { popupTimeoutMs: 9_999_999, logFile: '', trace: false })
  check(
    'an absurd popupTimeoutMs is clamped, not obeyed',
    tooLong.logs.warn.some((line) => line.includes('clamped') && line.includes('popupTimeoutMs')),
    JSON.stringify(tooLong.logs.warn),
  )
}

// ---- 17. clicking the card returns you to the harness ----------------------
//
// A card you can see but cannot act on only relocates the interruption. The
// click must raise the harness window, and it has to run inside the card's own
// click handler: only the foreground window may hand focus to another process,
// and the card becomes foreground the instant it is clicked. A host-side
// SetForegroundWindow would be a background call and would only flash the
// taskbar.

{
  const script = buildScript({ popup: true, popupMs: 1000, sound: false, balloon: false, box: false }, 't', 'b')

  check(
    'the card resolves the harness window by process name',
    /function FocusDsh\(\)/.test(script) && /Get-Process -Name 'DeepSeek Harness'/.test(script),
  )
  check(
    'a minimised harness is restored before focus is handed over',
    /IsIconic\(\$p\.MainWindowHandle\)\)\{ \[void\]\[AttentionDpi\]::ShowWindow\(\$p\.MainWindowHandle,9\)/.test(script),
  )
  check('focus is handed to the harness window', /SetForegroundWindow\(\$p\.MainWindowHandle\)/.test(script))
  check(
    'the click both focuses and closes',
    (script.match(/FocusDsh; \$f\.Close\(\)/g) ?? []).length === 1,
    String((script.match(/FocusDsh; \$f\.Close\(\)/g) ?? []).length),
  )
  check(
    'the focus target is configurable',
    /Get-Process -Name 'Other App'/.test(
      buildScript({ popup: true, sound: false, balloon: false, box: false, focusProcess: 'Other App' }, 't', 'b'),
    ),
  )
  // A quote in the name would otherwise break out of the PowerShell literal.
  check(
    'the focus target escapes single quotes',
    /Get-Process -Name 'a''b'/.test(
      buildScript({ popup: true, sound: false, balloon: false, box: false, focusProcess: "a'b" }, 't', 'b'),
    ),
  )
}

// ---- 18. the click names the session, not just the window ------------------
//
// Raising the window returns the page to whatever session it last showed. The
// card therefore also carries a one-shot token; its click POSTs the token to a
// host route and the page's client half opens the exact session that asked.
// These guards cover the host half of that contract: the card sends the jump,
// the route hands out the right session, a token works once, and the whole
// seam stays dormant when there is no HTTP carrier.

{
  // The card POSTs before it raises, and only when the plugin gave it a URL.
  const bare = buildScript({ popup: true, sound: false, balloon: false, box: false }, 't', 'b')
  check('a card with no jump url sends nothing', /function Send-Jump\{\}/.test(bare))
  check(
    'a card with a jump url posts to it',
    /function Send-Jump\(\)\{ try \{ \$r=\[System\.Net\.HttpWebRequest\]::Create\('http/.test(
      buildScript({ popup: true, sound: false, balloon: false, box: false, jumpUrl: 'http://x/click/t' }, 't', 'b'),
    ),
  )
  check(
    'the click sends the jump before raising the window',
    (bare.match(/Send-Jump; FocusDsh; \$f\.Close\(\)/g) ?? []).length === 1
      || (buildScript({ popup: true, sound: false, balloon: false, box: false, jumpUrl: 'http://x/click/t' }, 't', 'b')
        .match(/Send-Jump; FocusDsh; \$f\.Close\(\)/g) ?? []).length === 1,
  )

  // End-to-end through the fake carrier: a question fires, the click route
  // turns the token into a claimable session id, and the claim is drained once.
  const scripts = []
  const harness = createHarness({ agents: [{ id: 'root', root: true }] })
  apply(harness.ctx, {
    logFile: '',
    trace: false,
    spawn: (_f, args) => {
      scripts.push(scriptFromArgs(args))
      return { on() {}, unref() {} }
    },
  })
  harness.waterfall('user-questions/request', {
    questions: [{ id: 'q', question: '选哪个？' }],
    agent: { id: 'root' },
  })

  const m = /HttpWebRequest\]::Create\('([^']+)'\)/.exec(scripts[0] ?? '')
  check('the fired card carries a jump url', m !== null, String(scripts[0]?.length ?? 0))
  // The registered prefix must have NO trailing slash. The host matches
  // `pathname === prefix || pathname.startsWith(prefix + '/')`, so a trailing
  // slash would make the route unreachable (every request 404s) while the card
  // still rings and still advertises a jump URL — exactly the silent failure
  // this check exists to prevent.
  const registered = harness.routes.map((route) => route.path)
  check('the jump route is registered without a trailing slash',
    registered.includes('/dsh-attention') && !registered.some((path) => path.endsWith('/')),
    JSON.stringify(registered))
  if (m !== null) {
    const clickUrl = m[1]
    const token = clickUrl.split('/').pop()
    check('the jump url is on the host origin', clickUrl.startsWith('http://dsh.test:9999/dsh-attention/click/'))
    const empty = await harness.serve('GET', '/dsh-attention/pending')
    check('nothing is pending before the click', empty.status === 204, String(empty.status))
    const click = await harness.serve('POST', `/dsh-attention/click/${token}`)
    check('the click is accepted', click.status === 204, String(click.status))
    const got = await harness.serve('GET', '/dsh-attention/pending')
    check('the click queues its session', got.status === 200 && JSON.parse(got.body).sessionId === 'root', got.body)
    // BROADCAST, not hand-out: several windows poll the same route and the one
    // the user is looking at is not necessarily the one that asks first, so a
    // claim is answered to every asking page and the PAGE dedupes on `jumpId`.
    // A drained queue would leave the visible window without the jump.
    const again = await harness.serve('GET', '/dsh-attention/pending')
    check('the claim is broadcast, not drained',
      again.status === 200 && JSON.parse(again.body).jumpId === JSON.parse(got.body).jumpId,
      again.body)
    const replay = await harness.serve('POST', `/dsh-attention/click/${token}`)
    check('a token is one-shot', replay.status === 204)
    // The replay must not queue a SECOND claim: same jumpId, so every page
    // treats it as already applied instead of jumping twice.
    const after = await harness.serve('GET', '/dsh-attention/pending')
    check('a replayed token queues nothing',
      after.status === 200 && JSON.parse(after.body).jumpId === JSON.parse(got.body).jumpId,
      after.body)
  }

  // No carrier: the notifier still fires, just without a jump url.
  const noServer = createHarness({ agents: [{ id: 'root', root: true }], webServer: null })
  const quietScripts = []
  apply(noServer.ctx, {
    logFile: '',
    trace: false,
    spawn: (_f, args) => {
      quietScripts.push(scriptFromArgs(args))
      return { on() {}, unref() {} }
    },
  })
  noServer.waterfall('user-questions/request', {
    questions: [{ id: 'q', question: '选哪个？' }],
    agent: { id: 'root' },
  })
  check('a card still fires with no carrier', quietScripts.length === 1, `rings=${quietScripts.length}`)
  check('and it sends no jump', /function Send-Jump\{\}/.test(quietScripts[0] ?? ''))
}

// ---- 19. multiple cards stack instead of overlapping exactly ----------------
//
// The reported symptom: two cards at once land at the identical position, so the
// second completely hides the first and the user cannot tell there is more than
// one. The fix retreats later cards up and to the left.
//
// The whole mechanism rests on one fact: each card is a SEPARATE PowerShell
// child process with its own window, so a card cannot see its siblings and must
// not try to (enumerating windows to count them is slow and racy). The host sees
// every notification, so it owns the ordinal and hands it down. Everything below
// checks that seam end to end.

{
  const scripts = []
  const harness = createHarness({ agents: [{ id: 'root', root: true }] })
  apply(harness.ctx, {
    popupTimeoutMs: 10_000,
    // minIntervalMs collapses a burst into one ring by design (a tool that asks
    // three times in a row is one interruption, not three). Stacking is about
    // cards that are on screen TOGETHER, so the quiet window has to be off here
    // or the second and third cards are never generated at all.
    minIntervalMs: 0,
    logFile: '',
    trace: false,
    spawn: (_f, args) => {
      scripts.push(scriptFromArgs(args))
      return { on() {}, unref() {} }
    },
  })

  const ask = (text) => harness.waterfall('user-questions/request', {
    questions: [{ id: 'q', question: text }],
    agent: { id: 'root' },
  })
  const settle = () => harness.settleNext({ answers: [] })

  // Three cards in quick succession.
  ask('第一张')
  settle()
  ask('第二张')
  settle()
  ask('第三张')
  settle()

  check('a burst of three fires three cards', scripts.length === 3, `cards=${scripts.length}`)

  /** The right/bottom insets a script pins its card to. */
  function insets(script) {
    const m = /\[int\]\(\((\d+)\+22\*(\d+)\)\*\$k\)\),\(\$wa\.Bottom-\$h-\[int\]\(\((\d+)\+18\*(\d+)\)\*\$k\)\)/.exec(script ?? '')
    if (m === null) return null
    // The script holds `24+22*step`, so the real inset is the base plus the step
    // times the stride. Comparing the BASE alone would pass for every card, and
    // comparing the step alone would miss a wrong stride — so resolve both.
    return {
      baseRight: Number(m[1]),
      step: Number(m[2]),
      baseBottom: Number(m[3]),
      vstep: Number(m[4]),
      right: Number(m[1]) + 22 * Number(m[2]),
      bottom: Number(m[3]) + 18 * Number(m[4]),
    }
  }

  const [first, second, third] = scripts.map(insets)
  check('every card pins itself to the corner with a stack step', first !== null && second !== null && third !== null)
  if (first && second && third) {
    check('the first card is the front one (no retreat)', first.step === 0, `step=${first.step}`)
    check('the second card retreats one step', second.step === 1, `step=${second.step}`)
    check('the third card retreats two steps', third.step === 2, `step=${third.step}`)
    // The retreat must move the card UP and to the LEFT of the one in front. The
    // card is anchored to the working area's bottom-right, so a LARGER inset
    // means further from that corner — i.e. up and left. Resolved inset is the
    // base plus step times stride, so this also pins the stride itself: a wrong
    // stride would pass a step-only check and still stack wrong on screen.
    check('each retreat adds 22px horizontally',
      second.right === first.right + 22 && third.right === second.right + 22,
      `${first.right} -> ${second.right} -> ${third.right}`)
    check('each retreat adds 18px vertically',
      second.bottom === first.bottom + 18 && third.bottom === second.bottom + 18,
      `${first.bottom} -> ${second.bottom} -> ${third.bottom}`)
    // The un-retreated card keeps the original corner insets, so a lone card is
    // pixel-identical to what shipped before stacking existed.
    check('a lone card sits exactly where it always did', first.right === 24 && first.bottom === 36,
      `right=${first.right} bottom=${first.bottom}`)
  }

  // A retreated card must be visually behind: a darkening wash over its content.
  // The front card gets none, so there is always exactly one card at full
  // strength — otherwise a stack of dimmed cards leaves nothing to read.
  check('the front card draws no wash', !scripts[0].includes('$wash=New-Object'))
  check('a retreated card draws a wash', scripts[1].includes('$wash=New-Object') && scripts[2].includes('$wash=New-Object'))
  check('the wash is clipped to the rounded card, not the whole window',
    scripts[1].includes('$gr.FillPath($wash,$card)'))

  // And the z-order rule that makes the stack hold together: a retreated card
  // must NOT re-assert itself above its neighbour. Each repair re-inserts the
  // window at the top of the topmost band, so two cards that both repair trade
  // places once a second forever — the stack would visibly shuffle.
  check('a retreated card never re-asserts the topmost band', scripts[1].includes('function AssertTop($h){ }'))
  check('the front card still repairs, so an app cannot bury it',
    !scripts[0].includes('function AssertTop($h){ }') &&
      scripts[0].includes('function AssertTop($h){ if((([DateTime]::Now-$script:lastFix)'))
}

// ---- 20. the ordinal decays, or a long day pushes cards off screen ----------
//
// The ordinal is the host's count of cards on screen. If it only ever grew, the
// 100th card of a working day would be offset by 100 steps — far outside the
// screen. So it must reset once the previous cards have had time to expire.

{
  // The ordinal is read back out of the generated script, which is the same
  // number the host handed the card one layer down (ring() passes cfg straight
  // through to buildScript).
  const scripts = []
  const h2 = createHarness({ agents: [{ id: 'root', root: true }] })
  apply(h2.ctx, {
    popupTimeoutMs: 10_000,
    minIntervalMs: 0,
    logFile: '',
    trace: false,
    spawn: (_f, args) => {
      scripts.push(scriptFromArgs(args))
      return { on() {}, unref() {} }
    },
  })

  const stepOf = (script) => Number(/\+22\*(\d+)\)\*\$k/.exec(script ?? '')?.[1] ?? -1)

  const fire = () => {
    h2.waterfall('user-questions/request', { questions: [{ id: 'q', question: 'x' }], agent: { id: 'root' } })
    h2.settleNext({ answers: [] })
  }

  fire()
  fire()
  check('two cards in a burst get ordinals 0 and 1', stepOf(scripts[0]) === 0 && stepOf(scripts[1]) === 1,
    `${stepOf(scripts[0])},${stepOf(scripts[1])}`)

  // Now let the clock run past popupTimeoutMs: the first cards have expired, so
  // the stack is empty and the next card must be the front one again.
  clock += 30_000
  // The decay watchdog re-arms itself, so fire every live watchdog until one of
  // them observes the idle gap and resets the count.
  for (let i = 0; i < 12; i += 1) {
    const watchdog = h2.liveTimers().find((timer) => timer.label === 'stack-decay')
    if (watchdog === undefined) break
    watchdog.fired = true
    watchdog.callback()
  }
  const before = scripts.length
  fire()
  check('a card fired after the stack expired is the front one again',
    stepOf(scripts[before] ?? '') === 0, `step=${stepOf(scripts[before] ?? '')}`)
}

// ---- 21. a hand-edited or absurd ordinal cannot break the layout -------------
//
// The ordinal is host-computed, but buildScript is also called directly by tests
// and by anything embedding this module, so a nonsense value must degrade to
// "front card" rather than produce a negative offset or a NaN position.

{
  const base = { popup: true, sound: false, balloon: false, box: false }
  const stepOf = (cfg) => Number(/\+22\*(\d+)\)\*\$k/.exec(buildScript({ ...base, ...cfg }, 't', 'b') ?? '')?.[1] ?? -1)

  check('a missing ordinal means the front card', stepOf({}) === 0)
  check('a negative ordinal means the front card', stepOf({ stackIndex: -3 }) === 0)
  check('a nonsense ordinal means the front card', stepOf({ stackIndex: 'abc' }) === 0)
  check('a null ordinal means the front card', stepOf({ stackIndex: null }) === 0)
  // The cap: past STACK_MAX the offset is held, so a runaway count cannot push a
  // card off the screen. The host resets the count, so this is a backstop.
  check('a huge ordinal is capped, not obeyed', stepOf({ stackIndex: 99 }) === 3, `step=${stepOf({ stackIndex: 99 })}`)
  check('a fractional ordinal is floored', stepOf({ stackIndex: 2.7 }) === 2, `step=${stepOf({ stackIndex: 2.7 })}`)
  // And the capped card still draws its wash — being far back must not make it
  // invisible.
  check('a capped card still draws its wash',
    buildScript({ ...base, stackIndex: 99 }, 't', 'b').includes('$wash=New-Object'))
}

// ---- 22. stacking can be switched off, and off means off --------------------

{
  const scripts = []
  const h = createHarness({ agents: [{ id: 'root', root: true }] })
  apply(h.ctx, {
    stack: false,
    minIntervalMs: 0,
    logFile: '',
    trace: false,
    spawn: (_f, args) => {
      scripts.push(scriptFromArgs(args))
      return { on() {}, unref() {} }
    },
  })
  const fire = () => {
    h.waterfall('user-questions/request', { questions: [{ id: 'q', question: 'x' }], agent: { id: 'root' } })
    h.settleNext({ answers: [] })
  }
  fire()
  fire()

  check('stack:false fires both cards', scripts.length === 2, `cards=${scripts.length}`)
  // With stacking off the host hands no ordinal down, so every card builds with
  // step 0 — the same corner, overlapping exactly, which is what was asked for.
  // (The script always contains the literal `+22*<step>`, so the assertion is on
  // the STEP being zero, not on the text being absent.)
  const stepOf = (script) => Number(/\+22\*(\d+)\)\*\$k/.exec(script ?? '')?.[1] ?? -1)
  check('stack:false puts every card at the front position',
    stepOf(scripts[0]) === 0 && stepOf(scripts[1]) === 0,
    `${stepOf(scripts[0])},${stepOf(scripts[1])}`)
  check('stack:false draws no wash', !scripts[1].includes('$wash=New-Object'))

  // And it must not be reported as an unknown key: a knob that is silently
  // ignored is the worst failure for a hand-edited patch, because the user turns
  // it, nothing changes, and the plugin looks broken.
  check('stack is a known config key',
    !h.logs.warn.some((line) => line.includes('unknown config key') && line.includes('stack')))
}

// ---- 23. the body renders Markdown instead of showing literal asterisks ------
//
// A notification that displays "**已完成**" reads as broken, and the card is a
// glance — there is no time to mentally strip markup. So the host parses the body
// to styled spans and the painter draws them one by one, because GDI+ has no
// inline rich text.
//
// The assertions cover the seam, not the parser (markdown.mjs owns that): the
// payload travels, the spans are walked, styles select fonts, and the raw body is
// never drawn as-is when markup is present.

{
  const plain = buildScript({ popup: true, sound: false, balloon: false, box: false }, 't', 'no markup here')
  check('a body without markup still renders', plain.includes('$md='))
  check('the plain text for measuring is derived from the rendered spans',
    plain.includes('$bodyPlain=(($md.lines'))

  const styled = buildScript(
    { popup: true, sound: false, balloon: false, box: false },
    't',
    '**bold** and `code` and [link](http://x)',
  )
  // The payload is base64 JSON of [style, text] pairs — decode it and check the
  // host actually produced styled spans rather than passing the text through.
  const m = /FromBase64String\('([A-Za-z0-9+/=]+)'\)\) \| ConvertFrom-Json/.exec(styled)
  check('the markdown payload is handed to the child', m !== null)
  if (m !== null) {
    const payload = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))
    const styles = payload.lines.flat().map((span) => span[0])
    check('bold is marked', styles.includes(1), JSON.stringify(payload.lines))
    check('code is marked', styles.includes(4))
    check('a link is marked', styles.includes(16))
    check('the raw asterisks are gone from the rendered text',
      !JSON.stringify(payload).includes('**'))
  }

  // The painter must walk the spans and pick a font per style. GDI+ has no
  // struck font either, so strike is a drawn line.
  check('the painter walks the rendered lines', styled.includes('foreach($ln in $md.lines){'))
  check('each span picks its font by style bit', styled.includes('if(($st -band 4) -ne 0){ $fn=$bfc }'))
  check('code and links take the accent tint brush', styled.includes('$br=$script:codeBrush'))
  check('strike-through is drawn as a line, not a font',
    styled.includes('$gr.DrawLine(') && /if\(\(\$st -band 8\) -ne 0[^\n]*\)\{/.test(styled))
  check('the body is no longer drawn as one opaque string',
    !styled.includes('DrawString($body,$bf,$bb2'))

  // Block level.
  const list = buildScript({ popup: true, sound: false, balloon: false, box: false }, 't', '- one\n- two')
  const listPayload = JSON.parse(Buffer.from(/FromBase64String\('([A-Za-z0-9+/=]+)'\)\) \| ConvertFrom-Json/.exec(list)[1], 'base64').toString('utf8'))
  check('a list is recognised as a block', listPayload.blocks.includes('bullet'), JSON.stringify(listPayload.blocks))
  check('a list keeps its items', JSON.stringify(listPayload.lines).includes('one') && JSON.stringify(listPayload.lines).includes('two'))
  check('the bullet marker is a separate span so it keeps the body style',
    listPayload.lines[0][0][1].trim() === '•', JSON.stringify(listPayload.lines[0]))

  // The code brush must be disposed with everything else — a native handle leaked
  // once per card is fine, once per repaint is not.
  check('the code brush is created once, outside the paint loop',
    styled.includes('$script:codeBrush=New-Object System.Drawing.SolidBrush'))
}

// ---- 24. the quick-popup API fires a card without staging an event ---------
//
// Every other section here drives a real trigger and reads the card that fell
// out. This one covers the seam the user asked for: one call, one card, no
// question and no finished turn. It is the same delivery path (`ring`), so a
// regression in the painter still shows up in sections 1–23; what these
// assertions protect is the seam's own contract — that a preset resolves, that
// an explicit request wins over it, that nonsense degrades instead of throwing,
// and that the API never leaves a card that cannot be read.

{
  const { harness, rings } = setup({ tools: 'default' })

  check('the quick-popup tool is registered', harness.tool('attention_popup') !== undefined)
  check('the tool is the only tool registered', harness.tools.length === 1, `tools=${harness.tools.length}`)

  // Defaults: no arguments at all still produces a card, because a smoke test
  // whose first attempt needs arguments is not a smoke test.
  const plain = await harness.runTool('attention_popup', {})
  check('a bare call fires a card', rings.length === 1, `rings=${rings.length}`)
  check('a bare call reports success', plain.ok === true, JSON.stringify(plain))
  check('a bare call names a tone', plain.tone === 'ok', plain.tone)

  // A preset supplies title, body and tone together, so "check the painter"
  // costs one word rather than a paragraph of copy.
  const preset = await harness.runTool('attention_popup', { preset: 'ask' })
  check('a preset fires a card', rings.length === 2)
  check('a preset brings its own tone', preset.tone === 'ask', preset.tone)
  check('a preset brings its own body', decodeBody(rings[1].script).includes('覆盖'), decodeBody(rings[1].script))
  // The sample must carry markup: it exists to exercise the span walker, and a
  // plain-prose preset would let a painter regression ship unnoticed.
  check('the preset body carries markup', /\*\*|`|\[/.test(preset.body), preset.body)

  // An explicit field beats the preset, field by field, so a preset is a
  // starting point and not an override.
  const mixed = await harness.runTool('attention_popup', { preset: 'alert', title: '自定义标题', tone: 'ok' })
  check('an explicit title beats the preset title', mixed.title === '自定义标题', mixed.title)
  check('an explicit tone beats the preset tone', mixed.tone === 'ok', mixed.tone)
  check('an untouched field still comes from the preset',
    decodeBody(rings[2].script).includes('exit code 1'), decodeBody(rings[2].script))

  // Nonsense degrades. A throw here would take down the tool call, and a test
  // seam that fails on a typo is worse than no seam.
  const junk = await harness.runTool('attention_popup', { preset: 'nope', tone: 'purple', durationMs: 'soon' })
  check('an unknown preset does not throw', junk.ok === true, JSON.stringify(junk))
  check('an unknown tone falls back to ok', junk.tone === 'ok', junk.tone)
  check('a nonsense duration falls back to the configured timeout', junk.timeoutMs === 10_000, String(junk.timeoutMs))

  // The duration is the one knob the caller owns outright: the config's
  // popupMs is a FLOOR protecting hand-edited config, and applying it here would
  // silently turn a 3s request into a 9s card.
  const short = await harness.runTool('attention_popup', { durationMs: 3_000 })
  check('an explicit duration is honoured', short.timeoutMs === 3_000, String(short.timeoutMs))
  check('the floor does not stretch an explicit duration',
    /Interval=3000\b/.test(rings.at(-1).script), /Interval=(\d+)/.exec(rings.at(-1).script)?.[1])
  const forever = await harness.runTool('attention_popup', { durationMs: 0 })
  check('duration 0 means wait for the human', forever.timeoutMs === 0, String(forever.timeoutMs))
  check('a wait-forever card parks its timer instead of flashing',
    rings.at(-1).script.includes('$timer.Interval=[int]::MaxValue'))
  const absurd = await harness.runTool('attention_popup', { durationMs: 99_999_999 })
  check('an absurd duration is clamped, not obeyed', absurd.timeoutMs === 600_000, String(absurd.timeoutMs))
}

// ---- 25. the quick popup is a test seam, not a second trigger ---------------
//
// The API deliberately diverges from the config in four ways, and each one is
// load-bearing: get them wrong and either the smoke test silently does nothing
// or it interferes with the cards the user actually needs to see.

{
  const { harness, rings } = setup({
    tools: 'default',
    // A profile with the card channel switched off. The smoke test must still
    // paint, or "delivery is broken" and "you turned popups off" look identical.
    config: { popup: false, sound: false, balloon: false, box: false },
  })
  const result = await harness.runTool('attention_popup', { preset: 'ok' })
  check('the quick popup ignores the popup switch', result.ok === true, JSON.stringify(result))
  check('it paints even when every channel is off', rings.length === 1, `rings=${rings.length}`)

  const script = rings[0].script
  check('the card is the popup channel', script.includes('QuietCard'))
  check('no modal box is opened', !script.includes('MessageBox'))
  check('no balloon is attempted', !script.includes('ShowBalloonTip'))
  // Sound stays under the caller's control, because muting the test card is a
  // legitimate thing to want.
  check('sound follows the request, not the config',
    !script.includes('SoundPlayer') && result.sound === false, String(result.sound))

  // Stacking: the test card must not consume an ordinal, or firing a dozen
  // smoke cards would march the real cards up and to the left.
  const stepOf = (source) => Number(/\+22\*(\d+)\)\*\$k/.exec(source ?? '')?.[1] ?? -1)
  check('a test card does not take a stack ordinal', stepOf(script) === 0, `step=${stepOf(script)}`)

  // The ordinal is asserted through `popup()` and not through the tool, because
  // `stackIndex` is deliberately absent from the tool's parameter list: placing
  // cards is the host's business, not the model's. The harness passes arguments
  // straight to `execute` without validating them, so a tool-level assertion
  // would pass here and prove nothing about a real host that strips unknown
  // fields.
  const captured = []
  popup(
    {
      popup: true,
      sound: false,
      spawn: (_file, args) => {
        captured.push(args)
        return { on() {}, unref() {} }
      },
    },
    { preset: 'ok', stackIndex: 2 },
  )
  check('a direct call can still place the card',
    captured.length === 1 && stepOf(scriptFromArgs(captured[0])) === 2,
    `step=${stepOf(scriptFromArgs(captured[0] ?? []))}`)
}

{
  // The seam is optional in both directions: a profile with no tool registry
  // simply does not mount it, and the switch removes it without touching the
  // real triggers.
  const bare = setup({ tools: null })
  check('no tool registry means no tool', bare.harness.tools.length === 0)
  bare.harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  check('the real triggers still fire without a tool registry', bare.rings.length === 1, `rings=${bare.rings.length}`)

  const off = setup({ tools: 'default', config: { quickPopup: false } })
  check('quickPopup:false registers no tool', off.harness.tools.length === 0)
  off.harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  check('quickPopup:false leaves the real triggers alone', off.rings.length === 1, `rings=${off.rings.length}`)
  check('quickPopup is a known config key',
    !off.harness.logs.warn.some((line) => line.includes('unknown config key') && line.includes('quickPopup')))

  // A registry that rejects the definition must not take the notifier down with
  // it: the tool is a convenience, the triggers are the product.
  const hostile = createHarness({
    tools: {
      register() {
        throw new Error('duplicate tool name')
      },
    },
  })
  const hostileRings = []
  apply(hostile.ctx, {
    logFile: '',
    trace: false,
    spawn: () => {
      hostileRings.push(1)
      return { on() {}, unref() {} }
    },
  })
  check('a rejected registration is reported',
    hostile.logs.warn.some((line) => line.includes('quick-popup tool')), JSON.stringify(hostile.logs.warn))
  hostile.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
  check('a rejected registration does not break the triggers', hostileRings.length === 1, `rings=${hostileRings.length}`)
}

// ---- 26. the quick popup writes a trace line like any other card ------------
//
// The trace file is how "did it fire" is answered after the fact. A test card
// that leaves no trace is indistinguishable from a test card that never ran, so
// the seam reports itself the same way the triggers do.

{
  const traceFile = join(tmpdir(), `dsh-attention-popup-test-${process.pid}.log`)
  const { harness } = setup({ tools: 'default', config: { trace: true, traceFile } })
  const result = await harness.runTool('attention_popup', { preset: 'ok', body: 'trace-me' })
  check('the quick popup reports what it did',
    result.ok === true && result.body === 'trace-me', JSON.stringify(result))
  check('the tool result carries the resolved request',
    result.title !== undefined && result.tone === 'ok' && result.timeoutMs === 10_000, JSON.stringify(result))

  // The trace line is `<iso> <event> <json>`, not a JSON document, so the
  // payload starts at the first brace. Parsing the whole line would throw and
  // the failure would read as "no trace at all" rather than "wrong parse".
  const lines = []
  try {
    for (const line of readFileSync(traceFile, 'utf8').trim().split('\n')) {
      const at = line.indexOf('{')
      if (at === -1) continue
      lines.push({ event: line.slice(0, at).trim().split(' ').at(-1), ...JSON.parse(line.slice(at)) })
    }
  } catch {
    /* an unreadable trace file leaves `lines` short, and the check below says so */
  }
  const entry = lines.find((line) => line.event === 'popup')
  check('the quick popup leaves a trace line', entry !== undefined, `${lines.length} lines`)
  check('the trace line records the tone and the title',
    entry?.tone === 'ok' && entry?.title !== undefined, JSON.stringify(entry))
  check('the trace line marks the tool as the caller', entry?.tool === true, JSON.stringify(entry))
  try {
    rmSync(traceFile, { force: true })
  } catch {
    /* best effort */
  }
}
// ---- 27. resolvePopup is the seam's own contract, testable without spawning --
//
// The tool surface and the CLI both go through `resolvePopup`, and its rules are
// exactly the kind of thing that silently rots: which field a preset may fill,
// what a nonsense duration becomes, whether a missing body is empty or the
// configured title. Asserting them here means a delivery regression and a
// resolution regression cannot be mistaken for each other.

{
  // The presets exist to exercise the painter, so each one must actually carry
  // markup — a preset rewritten as plain prose would quietly stop covering the
  // span walker while still looking like a valid sample.
  for (const [name, preset] of Object.entries(POPUP_PRESETS)) {
    check(`the ${name} preset carries markup`, /\*\*|`|\[/.test(preset.body), preset.body)
    check(`the ${name} preset has a heading`, typeof preset.title === 'string' && preset.title !== '')
    check(`the ${name} preset names its own tone`, preset.tone === name, preset.tone)
  }

  const base = { title: 'Configured', popupTimeoutMs: 7_000, sound: false }
  const resolved = resolvePopup(base, { preset: 'alert' })
  check('a preset fills the title when none is given', resolved.title === POPUP_PRESETS.alert.title, resolved.title)
  check('a preset fills the body when none is given', resolved.body === POPUP_PRESETS.alert.body)
  check('a preset fills the tone when none is given', resolved.tone === 'alert', resolved.tone)
  check('the configured timeout is the fallback', resolved.timeoutMs === 7_000, String(resolved.timeoutMs))
  check('the configured sound switch is the fallback', resolved.sound === false, String(resolved.sound))

  const explicit = resolvePopup(base, {
    preset: 'alert', title: 'T', body: 'B', tone: 'ask', durationMs: 2_500, sound: true,
  })
  check('an explicit request wins field by field',
    explicit.title === 'T' && explicit.body === 'B' && explicit.tone === 'ask' &&
      explicit.timeoutMs === 2_500 && explicit.sound === true, JSON.stringify(explicit))

  check('an empty title falls through rather than showing a blank heading',
    resolvePopup(base, { preset: 'ok', title: '   ' }).title === POPUP_PRESETS.ok.title)
  check('a non-string title falls through too',
    resolvePopup(base, { preset: 'ok', title: {} }).title === POPUP_PRESETS.ok.title)
  check('a number body is accepted as text', resolvePopup(base, { body: 42 }).body === '42')
  check('a missing body is empty, not the configured title',
    resolvePopup(base, {}).body === '', JSON.stringify(resolvePopup(base, {}).body))
  check('an unknown tone falls back to ok', resolvePopup(base, { tone: 'chartreuse' }).tone === 'ok')
  check('a negative duration clamps to zero', resolvePopup(base, { durationMs: -5 }).timeoutMs === 0)
  check('a fractional duration is floored', resolvePopup(base, { durationMs: 1500.9 }).timeoutMs === 1_500)
  check('durationMs wins over timeoutMs',
    resolvePopup(base, { durationMs: 1_000, timeoutMs: 9_000 }).timeoutMs === 1_000)
  check('a missing config still resolves', resolvePopup(undefined, {}).timeoutMs === 10_000)
}

// ---- 28. the click stage reports itself ------------------------------------
//
// "Clicking the card does nothing" has three different causes and they need
// three different fixes: the card never reached the host, the page never polled
// the claim, or the navigation ran and the session did not move. Only the last
// two were observable before, and only from the page's own report — so the
// host now records the click and carries a running tally, and every line says
// where the seam stands.

{
  const traceFile = join(tmpdir(), `dsh-attention-click-test-${process.pid}.log`)
  const { harness, rings } = setup({ agents: [{ id: 'root', root: true }], config: { trace: true, traceFile } })
  harness.waterfall('user-questions/request', {
    questions: [{ id: 'q', question: '点我？' }],
    agent: { id: 'root' },
  })
  const m = /HttpWebRequest\]::Create\('([^']+)'\)/.exec(rings.at(-1)?.script ?? '')
  check('the card advertises a jump', m !== null, `rings=${rings.length}`)

  const lines = () => {
    try {
      const out = []
      for (const line of readFileSync(traceFile, 'utf8').trim().split('\n')) {
        const at = line.indexOf('{')
        if (at === -1) continue
        // The spread goes first: the page's own payload carries an `event` key
        // that would otherwise overwrite the authoritative one from the line
        // prefix, turning `client:step:landed` back into `step:landed`.
        out.push({ ...JSON.parse(line.slice(at)), event: line.slice(0, at).trim().split(' ').at(-1) })
      }
      return out
    } catch {
      return []
    }
  }

  check('no click is recorded before anyone clicks',
    lines().every((line) => line.event !== 'click'), JSON.stringify(lines().map((l) => l.event)))

  if (m !== null) {
    const token = m[1].split('/').pop()
    await harness.serve('POST', `/dsh-attention/click/${token}`)
    const clicked = lines().find((line) => line.event === 'click')
    check('the click is recorded', clicked !== undefined, JSON.stringify(lines().map((l) => l.event)))
    check('the click line names the session it wants', clicked?.sessionId === 'root', JSON.stringify(clicked))
    // Spread, not `stats.*`: trace() flattens nested objects to strings.
    check('the click line carries the running tally',
      clicked?.clicked === 1 && clicked?.offered >= 1, JSON.stringify(clicked))
    check('an unclicked card is not counted as polled',
      clicked?.polled === 0, JSON.stringify(clicked))

    await harness.serve('GET', '/dsh-attention/pending')
    const polled = lines().at(-1)
    check('a poll advances the tally', polled?.polled === 1, JSON.stringify(polled))

    // An unknown token is a replay, an expired card, or a forgery: it must be
    // visible rather than silently answered, because "someone is hammering this
    // route" is a different bug from "the card is stale".
    await harness.serve('POST', '/dsh-attention/click/not-a-token')
    const unknown = lines().find((line) => line.event === 'click:unknown')
    check('an unknown token is reported, not swallowed', unknown !== undefined, JSON.stringify(lines().map((l) => l.event)))
    check('an unknown token queues no claim',
      await harness.serve('GET', '/dsh-attention/pending').then((r) => JSON.parse(r.body).jumpId === token),
      'pending changed')

    // The page's verdict must survive the tally. Both carry a `landed` key: the
    // page's is a boolean fact, the host's is a running count. Written in the
    // wrong order the count overwrote the fact and a jump that landed read as
    // `"landed":2` — which is worse than no report, because it looks reported.
    for (const verdict of [true, false]) {
      await harness.serve('POST', '/dsh-attention/ping', {
        body: JSON.stringify({ event: 'step:landed', landed: verdict, wanted: 'root' }),
      })
      // The LAST matching line, not the first: both pings carry wanted:'root',
      // and `find` would keep re-reading the earlier verdict and pass forever.
      const line = lines().filter((l) => l.event === 'client:step:landed' && l.wanted === 'root').at(-1)
      check(`the page's verdict survives the tally (${verdict})`, line?.landed === verdict, JSON.stringify(line))
    }
    // One landed + one failed, carried alongside the page's own verdict rather
    // than on top of it: `landed` here is the count, so it reads 1 even though
    // the last line's `landed` fact is false. That collision is exactly why the
    // tally keys belong in the background — but they still have to be there.
    const tally = lines().at(-1)
    check('the tally still rides along', tally?.failed === 1 && tally?.landed === false, JSON.stringify(tally))
    const counted = lines().filter((l) => l.event === 'client:step:landed')
    check('both verdicts are counted', counted.length === 2, JSON.stringify(counted.map((l) => l.landed)))
  }

  try {
    rmSync(traceFile, { force: true })
  } catch {
    /* best effort */
  }
}

// ---- 29. a test card jumps back, exactly like a real one -------------------
//
// The API exists so "does the whole interruption work" is one call. That claim
// is only true if the card also carries the click-to-jump token: a smoke test
// that paints a card which cannot bring you back tests the painter and nothing
// else, and the one thing it cannot check is the thing most likely to be broken.

{
  const { harness, rings } = setup({ tools: 'default' })
  const jumpOf = (index) => /HttpWebRequest\]::Create\('([^']+)'\)/.exec(rings[index]?.script ?? '')?.[1]

  const viaAgent = await harness.runTool('attention_popup', { preset: 'ok' }, { agent: { id: 'sess-a' } })
  check('a card fired from a conversation can jump', viaAgent.jump === true, JSON.stringify(viaAgent))
  check('the card script really posts to a jump route',
    jumpOf(0)?.includes('/dsh-attention/click/') === true, String(jumpOf(0)))

  // The token is bound to the session that asked. Reading a global "current
  // session" would send the click to whichever conversation had focus, which is
  // exactly the bug that makes a jump land somewhere plausible and wrong.
  const token = jumpOf(0)?.split('/').pop()
  await harness.serve('POST', `/dsh-attention/click/${token}`)
  const claim = await harness.serve('GET', '/dsh-attention/pending')
  check('the click targets the session that fired it',
    JSON.parse(claim.body).sessionId === 'sess-a', claim.body)

  // `jump: false` is the "preview a card that cannot jump" switch, and it has to
  // be honest: no token minted, and the result says so.
  const noJump = await harness.runTool('attention_popup', { preset: 'ok', jump: false }, { agent: { id: 'sess-a' } })
  check('jump:false mints no token', noJump.jump === false, JSON.stringify(noJump))
  check('jump:false leaves the card without a jump route',
    !rings.at(-1).script.includes('HttpWebRequest'), 'still posts')
  check('jump:false still fires the card', noJump.ok === true, JSON.stringify(noJump))

  // No session id anywhere: still a card, just not a clickable one. Silence here
  // would be worse — the caller has to be able to tell "cannot jump" from
  // "jump is broken".
  const noSession = await harness.runTool('attention_popup', { preset: 'ok' })
  check('a call with no session still fires', noSession.ok === true, JSON.stringify(noSession))
  check('a call with no session reports that it cannot jump',
    noSession.jump === false, JSON.stringify(noSession))
}

{
  // The agent service is the fallback when `exec.agent` is missing (a scheduled
  // run, a nested call), because the plugin cannot mint a token from nothing.
  const { harness } = setup({ tools: 'default', initiator: { id: 'sess-b' } })
  const viaInitiator = await harness.runTool('attention_popup', { preset: 'ask' })
  check('the initiator is the fallback when the call carries no agent',
    viaInitiator.jump === true, JSON.stringify(viaInitiator))
}

{
  // The token has to outlive the card it is painted on. A flat one-minute TTL
  // was right for the ten-second default card and wrong for a card told to stay
  // until clicked: a click at minute five found an expired token, and the click
  // "did nothing" with every stage of the seam healthy.
  const traceFile = join(tmpdir(), `dsh-attention-ttl-test-${process.pid}.log`)
  const { harness, rings } = setup({ tools: 'default', config: { trace: true, traceFile } })
  const lines = () => {
    try {
      return readFileSync(traceFile, 'utf8').trim().split('\n').flatMap((line) => {
        const at = line.indexOf('{')
        return at === -1 ? [] : [{ ...JSON.parse(line.slice(at)), event: line.slice(0, at).trim().split(' ').at(-1) }]
      })
    } catch {
      return []
    }
  }

  // A wait-until-clicked card keeps its token for hours, so a click long after
  // the one-minute default still lands.
  const forever = await harness.runTool('attention_popup', { durationMs: 0 }, { agent: { id: 'sess-c' } })
  const foreverToken = /HttpWebRequest\]::Create\('([^']+)'\)/.exec(rings.at(-1).script)?.[1]?.split('/').pop()
  clock += 10 * 60_000
  await harness.serve('POST', `/dsh-attention/click/${foreverToken}`)
  const landed = lines().find((line) => line.event === 'click')
  check('a wait-until-clicked card can still be clicked ten minutes later',
    landed?.sessionId === 'sess-c', JSON.stringify(landed))
  check('a long-lived card advertises that it can jump', forever.jump === true, JSON.stringify(forever))

  // A short card does expire, and the expiry is reported as its own event: an
  // expired token and a forged one are different bugs, and "unknown" hides the
  // first behind the second.
  const brief = await harness.runTool('attention_popup', { durationMs: 2_000 }, { agent: { id: 'sess-d' } })
  const briefToken = /HttpWebRequest\]::Create\('([^']+)'\)/.exec(rings.at(-1).script)?.[1]?.split('/').pop()
  check('a short card still mints a token', brief.jump === true, JSON.stringify(brief))
  clock += 60 * 60_000
  await harness.serve('POST', `/dsh-attention/click/${briefToken}`)
  const expired = lines().find((line) => line.event === 'click:expired')
  check('a token clicked long after its card expired is reported as expired',
    expired?.sessionId === 'sess-d', JSON.stringify(lines().map((l) => l.event)))
  check('the expiry line names the lifetime it exceeded',
    typeof expired?.ttl === 'number' && expired.ttl > 0, JSON.stringify(expired))
  check('an expired token queues no claim',
    await harness.serve('GET', '/dsh-attention/pending').then((r) => r.status === 204), 'pending answered')
  try {
    rmSync(traceFile, { force: true })
  } catch {
    /* best effort */
  }
}

// ---- 30. the card names the conversation ----------------------------------
//
// The headline used to be the fixed product label "DeepSeek Harness", which is
// the same string on every card and therefore identifies nothing when several
// windows are open. It is now the conversation's own name — the text the
// workspace list shows — read off the session's newest `session/title` event.
// The product label moved up to the small eyebrow line, so a card says BOTH
// which app it came from and which conversation it is about.
{
  const titled = (title, extra = []) => [
    ...extra,
    { type: 'session/title', data: { title, messageSeqs: [], source: 'user' } },
  ]

  {
    const { harness, rings } = setup({
      config: { minIntervalMs: 0 },
      sessions: { s1: titled('修复通知卡片的标题重叠') },
    })
    harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
    check('the headline is the conversation name, not the product label',
      decodeTitle(rings[0]?.script ?? '') === '修复通知卡片的标题重叠',
      JSON.stringify(decodeTitle(rings[0]?.script ?? '')))
    // The eyebrow is a plain literal in the script (it is config, not a runtime
    // value), so it can be asserted directly.
    check('the eyebrow still carries the product label',
      (rings[0]?.script ?? '').includes("$brandName='DeepSeek Harness'"),
      (rings[0]?.script ?? '').match(/\$brandName='[^']*'/)?.[0] ?? 'missing')
    check('the product label is not printed twice',
      decodeTitle(rings[0]?.script ?? '') !== 'DeepSeek Harness',
      'headline would duplicate the eyebrow')
  }

  {
    // A rename appends a second `session/title` event rather than rewriting the
    // first, so the resolver has to take the LAST one — the name the user is
    // looking at right now, not the name the conversation was born with.
    const { harness, rings } = setup({
      config: { minIntervalMs: 0 },
      sessions: { s1: titled('新名字', titled('旧名字')) },
    })
    harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
    check('a renamed conversation shows its newest name',
      decodeTitle(rings[0]?.script ?? '') === '新名字',
      JSON.stringify(decodeTitle(rings[0]?.script ?? '')))
  }

  {
    // A brand-new session has no title yet. Falling back to the configured
    // label is the honest failure: a card headed "DeepSeek Harness" is still
    // readable, whereas an empty headline row is a hole in the layout.
    const { harness, rings } = setup({ config: { minIntervalMs: 0 }, sessions: {} })
    harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
    check('a session with no name yet falls back to the configured title',
      decodeTitle(rings[0]?.script ?? '') === 'DeepSeek Harness',
      JSON.stringify(decodeTitle(rings[0]?.script ?? '')))
  }

  {
    // No `sessions` service at all (a host that does not expose it, or a
    // stripped profile). The resolver must stay silent and the card must still
    // ring — a broken name lookup is not a reason to drop a notification.
    const { harness, rings } = setup({ config: { minIntervalMs: 0 } })
    harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
    check('a host without a session store still rings',
      rings.length === 1, `rings=${rings.length}`)
    check('...and falls back to the configured title',
      decodeTitle(rings[0]?.script ?? '') === 'DeepSeek Harness',
      JSON.stringify(decodeTitle(rings[0]?.script ?? '')))
  }

  {
    // A title event whose data is not a usable string must not produce a card
    // headed "undefined" or an empty row.
    const { harness, rings } = setup({
      config: { minIntervalMs: 0 },
      sessions: { s1: [{ type: 'session/title', data: { title: '   ' } }] },
    })
    harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
    check('a blank title is treated as no title',
      decodeTitle(rings[0]?.script ?? '') === 'DeepSeek Harness',
      JSON.stringify(decodeTitle(rings[0]?.script ?? '')))
  }

  {
    // `brand` is its own setting, so it can be changed without touching the
    // headline. Sharing one field is what left the eyebrow slot blank.
    const { harness, rings } = setup({
      config: { minIntervalMs: 0, brand: '桌面版' },
      sessions: { s1: titled('会话名') },
    })
    harness.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { reason: 'completed' } })
    check('brand is a setting of its own',
      (rings[0]?.script ?? '').includes("$brandName='桌面版'"),
      (rings[0]?.script ?? '').match(/\$brandName='[^']*'/)?.[0] ?? 'missing')
    check('changing brand leaves the headline alone',
      decodeTitle(rings[0]?.script ?? '') === '会话名',
      JSON.stringify(decodeTitle(rings[0]?.script ?? '')))
  }

  {
    // The quick-popup tool stands in for a real card, so it has to be headed
    // the same way — otherwise "does the card name the right conversation" is
    // the one question the test seam cannot answer.
    const { harness, rings } = setup({
      tools: 'default',
      sessions: { 'sess-a': titled('这个会话的名字') },
    })
    await harness.runTool('attention_popup', { preset: 'ok' }, { agent: { id: 'sess-a' } })
    check('the quick-popup tool is headed by the conversation name',
      decodeTitle(rings.at(-1)?.script ?? '') === '这个会话的名字',
      JSON.stringify(decodeTitle(rings.at(-1)?.script ?? '')))
    // An explicit title still wins: the tool has to stay usable for previewing
    // arbitrary text.
    await harness.runTool('attention_popup', { preset: 'ok', title: '自定义标题' }, { agent: { id: 'sess-a' } })
    check('an explicit title still overrides the conversation name',
      decodeTitle(rings.at(-1)?.script ?? '') === '自定义标题',
      JSON.stringify(decodeTitle(rings.at(-1)?.script ?? '')))
  }

  {
    // The popup request resolver is the one place a caller can see what the
    // eyebrow will say without rendering anything.
    const request = resolvePopup({ brand: 'DeepSeek Harness', title: 'fallback' }, {})
    check('resolvePopup exposes the brand for the eyebrow', request.brand === 'DeepSeek Harness', JSON.stringify(request.brand))
    check('...and keeps the title separate from it', request.title === 'fallback', JSON.stringify(request.title))
    check('a caller can override the brand per card',
      resolvePopup({ brand: 'DeepSeek Harness' }, { brand: '桌面版' }).brand === '桌面版', 'override')
    // A profile written before the split only knows `title`; the eyebrow must
    // still have something to print there instead of going blank.
    check('an old profile with only `title` still fills the eyebrow',
      resolvePopup({ title: 'DeepSeek Harness' }, {}).brand === 'DeepSeek Harness', 'legacy fallback')
  }
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`)
if (failed.length > 0) process.exitCode = 1
