import { readFileSync } from 'node:fs'
import { apply } from '../index.js'
import { buildScript } from '../notify.js'
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

function setup({ config = {}, agents = [] } = {}) {
  const { rings, spawn } = makeRings()
  const harness = createHarness({ agents })
  apply(harness.ctx, { spawn, ...config })
  return { harness, rings }
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
  apply(harness.ctx, { popupMS: 5000, notifyOnQuestion: true })
  check(
    'an unknown config key is named, not swallowed',
    harness.logs.warn.some((line) => line.includes('unknown config key') && line.includes('popupMS')),
    JSON.stringify(harness.logs.warn),
  )

  // ...but injection points must still pass through: the harness ships `spawn`
  // through the same object, and dropping it would break every test above.
  const { rings, spawn } = makeRings()
  const injected = createHarness()
  apply(injected.ctx, { spawn })
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
  apply(harness.ctx, { trace: false })
  check(
    'diagnostics can be switched off',
    !harness.logs.info.some((line) => line.includes('writing diagnostics')),
    JSON.stringify(harness.logs.info),
  )
  const on = createHarness()
  apply(on.ctx, { trace: true, traceFile: 'C:\\nonexistent-dir\\deep\\trace.log' })
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
    script.includes('$headH=[int]$hf.GetHeight($gfx)'),
  )
  check(
    'the body line box is derived from its font',
    script.includes('$lineH=[int]$bf.GetHeight($gfx)'),
  )
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
  // A long title must ellipsise rather than run into the edge.
  check('a long title is trimmed to the text column',
    script.includes('$gr.DrawString($title,$hf,$tb2,(New-Object System.Drawing.RectangleF($tx,$headY,$lw,$headH)),$tfmt)') &&
      !script.includes('$gr.DrawString($title,$hf,$tb2,$tx,$headY)'))
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
  apply(clampedHost.ctx, { popupTimeoutMs: 0 })
  check(
    'popupTimeoutMs=0 is not reported as an unknown key',
    !clampedHost.logs.warn.some((line) => line.includes('popupTimeoutMs')),
    JSON.stringify(clampedHost.logs.warn),
  )
  const tooLong = createHarness()
  apply(tooLong.ctx, { popupTimeoutMs: 9_999_999 })
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
    const drained = await harness.serve('GET', '/dsh-attention/pending')
    check('the queue drains after one claim', drained.status === 204, String(drained.status))
    const replay = await harness.serve('POST', `/dsh-attention/click/${token}`)
    check('a token is one-shot', replay.status === 204)
    const after = await harness.serve('GET', '/dsh-attention/pending')
    check('a replayed token queues nothing', after.status === 204, String(after.status))
  }

  // No carrier: the notifier still fires, just without a jump url.
  const noServer = createHarness({ agents: [{ id: 'root', root: true }], webServer: null })
  const quietScripts = []
  apply(noServer.ctx, {
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

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`)
if (failed.length > 0) process.exitCode = 1
