/**
 * Attention notifier: ring the human when the agent blocks on a decision and
 * when a task ends.
 *
 * Two failure modes cost the user the same thing the step watchdog was built to
 * save — wall-clock time spent waiting on something nobody is watching:
 *
 *   1. A task ends while the user is looking elsewhere, so the result sits
 *      unseen until they happen to check back.
 *   2. The agent asks a question or requests an approval, then waits. An
 *      unanswered prompt strands the turn indefinitely.
 *
 * Windows toasts need a packaged identity this host process does not have
 * (HRESULT 0x80073D54), so delivery is a short-lived detached PowerShell
 * process that plays a system sound and shows a tray balloon tip.
 */
import { ring } from './notify.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const inject = ['timer']

export const DEFAULT_TRACE = join(tmpdir(), 'dsh-attention', 'trace.log')

/** How long a card click may sit unclaimed before its jump target is dropped. */
const JUMP_TTL_MS = 60_000

/**
 * Channel choice is empirical, not aesthetic. On this machine the tray balloon
 * returns success and paints nothing (Focus Assist), while a self-drawn topmost
 * window always paints; so the popup is the default and the balloon is opt-in.
 */
const DEFAULTS = {
  sound: true,
  popup: true,
  // A FLOOR on how long the card stays visible, in ms. `popupTimeoutMs` is the
  // value that decides when the card actually leaves; this one only stops a
  // hand-edited tiny timeout from flashing the card past the human before it
  // can be read. Bounded below by the 1000ms hard floor in notify.js.
  popupMs: 9_000,
  // How long the card stays on screen, in ms. 10s is long enough to notice a
  // card that appeared while you were looking at another window, and short
  // enough that a finished-turn card does not sit in the corner claiming to be
  // current. 0 = stay until clicked (Esc also closes it). Bounded to 600s so a
  // hand-edited value cannot strand a card on screen for a working day.
  popupTimeoutMs: 10_000,
  balloon: false,
  box: false,
  notifyOnQuestion: true,
  notifyOnApproval: true,
  notifyOnTurnEnd: true,
  includeSummary: true,
  askGuidance: true,
  minIntervalMs: 4_000,
  remindEveryMs: 120_000,
  maxReminders: 3,
  soundFile: 'C:\\Windows\\Media\\notify.wav',
  title: 'DeepSeek Harness',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  // Process name whose window is raised when the card is clicked. Matched
  // against `Get-Process -Name`, so it is the friendly process name, not the
  // window title (both happen to be "DeepSeek Harness" here).
  focusProcess: 'DeepSeek Harness',
  // Also name the session: the click POSTs a one-shot token to the host's
  // jump route and the page's client half opens exactly the session that
  // interrupted you. False keeps raise-the-window-only behaviour.
  jump: true,
  // STACKING: when several cards are on screen at once, later ones retreat up
  // and to the left of the ones in front (22px right / 18px bottom inset per
  // step, capped at 3 steps) and draw a darkening wash, so the corner reads as a
  // stack instead of one card hiding another. Set false to disable it — every
  // card then sits at the same corner and the newest one hides the rest.
  stack: true,
  trace: true,
  traceFile: DEFAULT_TRACE,
}

/** Timing keys, with the range each is clamped to. */
const BOUNDS = {
  popupMs: [1_000, 600_000],
  popupTimeoutMs: [0, 600_000],
  minIntervalMs: [0, 600_000],
  remindEveryMs: [30_000, 3_600_000],
  maxReminders: [0, 10],
}

/**
 * Merge the patch's config over the defaults without trusting it.
 *
 * This plugin cannot declare a cordis `Config` schema the way the shipped
 * packages do: `@deepseek-ai/schemastery` is not resolvable from a workspace
 * package (verified: MODULE_NOT_FOUND), so the Loader would fail to import us.
 * A patch row is plain YAML instead, which means a typo or an absurd value is
 * accepted silently and then just does nothing. That is the worst possible
 * failure for a notifier: the user turns a knob, nothing changes, and the
 * plugin looks broken. So we validate by hand — unknown keys are named in the
 * log (catching `popupMS` and friends), and numbers are clamped into range
 * rather than allowed to produce a popup that never closes or a reminder that
 * fires every tick.
 */
function resolveConfig(ctx, rawConfig) {
  const raw = rawConfig ?? {}
  const cfg = { ...DEFAULTS }
  const known = new Set(Object.keys(DEFAULTS))
  const unknown = []
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) unknown.push(key)
    cfg[key] = raw[key]
  }
  const clamped = []
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const value = Number(cfg[key])
    if (!Number.isFinite(value)) {
      cfg[key] = DEFAULTS[key]
      clamped.push(`${key}=${String(raw[key] ?? cfg[key])} (not a number)`)
      continue
    }
    const bounded = Math.min(max, Math.max(min, value))
    if (bounded !== value) clamped.push(`${key}=${value} -> ${bounded}`)
    cfg[key] = bounded
  }
  if (unknown.length > 0) {
    ctx.logger?.warn?.(`attention: ignoring unknown config key(s): ${unknown.join(', ')}`)
  }
  if (clamped.length > 0) {
    ctx.logger?.warn?.(`attention: clamped out-of-range config: ${clamped.join(', ')}`)
  }
  return cfg
}

/**
 * Prompt guidance that makes "ask the human" a behaviour rather than a
 * possibility. The tool exists either way; without a rule about when it is
 * owed, the model guesses and the guess is usually "decide for them".
 */
const GUIDANCE = [
  '有些决定属于用户，不属于你。遇到下面这些情况，停下来用 ask_user_question 让用户选择，而不是替用户猜：',
  '- 不可逆或破坏性的操作（删除、覆盖、推送、发布、花费）。',
  '- 需求存在实质性歧义，不同理解会导致完全不同的结果。',
  '- 只有用户能提供的信息：凭据、账号、外部系统的选择、业务口径。',
  '提问要短：把选择摆成具体的选项，每个选项一句话说明后果，推荐项放第一个并在标签后加「（推荐）」。',
  '不要为琐事提问——能从代码库、上下文或合理的默认值推断出来的，自己决定并说明假设。',
  '一次只问真正阻塞当前工作的问题；用户回答后立刻继续，不要复述答案。',
].join('\n')

/**
 * Diagnostic breadcrumb. The notifier's whole value is "it fired when it
 * should have", and that is invisible from the outside: a missed ring looks
 * exactly like a correct quiet. So every listener entry, every gate that
 * suppresses, and every attempted delivery appends one line here. Whether the
 * host ever calls into this plugin is then a fact on disk, not an inference.
 */
export function trace(event, detail, file = DEFAULT_TRACE) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const safe = { ...detail }
    for (const key of Object.keys(safe)) {
      const value = safe[key]
      if (value !== null && typeof value === 'object') {
        try {
          safe[key] = JSON.stringify(value).slice(0, 400)
        } catch {
          safe[key] = '[unserializable]'
        }
      } else if (typeof value === 'string' && value.length > 400) {
        safe[key] = `${value.slice(0, 400)}…`
      }
    }
    appendFileSync(file, `${new Date().toISOString()} ${event} ${JSON.stringify(safe)}\n`, 'utf8')
  } catch {
    /* tracing must never break the notifier */
  }
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const part of message.content) {
    if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim()
}

function clip(text, limit = 220) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1)}…`
}

function describeReason(reason) {
  if (reason == null) return '完成'
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object') {
    if (typeof reason.kind === 'string') {
      const inner = reason.reason
      const extra = typeof inner === 'string'
        ? `：${inner}`
        : typeof inner?.kind === 'string'
          ? `：${inner.kind}`
          : ''
      return `${reason.kind}${extra}`
    }
  }
  return String(reason)
}

/**
 * Some turns end without the user needing to be told: they pressed stop
 * themselves, or the step watchdog interrupted the turn only to re-drive it
 * (that re-drive opens a fresh turn, which rings on its own when it finishes).
 * Ringing on those is noise that trains the user to ignore the ring, which is
 * the one thing a notification cannot afford. Every other ending — including a
 * hook abort from some other extension — is worth a word.
 */
function worthRinging(reason) {
  const kind = typeof reason === 'string' ? reason : reason?.kind
  if (kind !== 'aborted') return true
  const cause = reason?.reason
  const causeKind = typeof cause === 'string' ? cause : cause?.kind
  if (causeKind === 'user') return false
  if (causeKind === 'hook') {
    const note = typeof cause === 'string' ? cause : cause?.reason
    return !(typeof note === 'string' && note.startsWith('no observable progress'))
  }
  return true
}

/**
 * Which accent a finished turn earns.
 *
 * Only a clean completion is blue. A turn that errored, was aborted, or ended
 * in any other way did not deliver what was asked, and colouring that like a
 * success would make the success colour meaningless — the one thing a signal
 * you read from the corner of your eye cannot afford. So the test is positive:
 * a known-good ending is blue, everything else is red.
 */
function toneOfEnding(reason) {
  if (reason == null) return 'ok'
  const kind = typeof reason === 'string' ? reason : reason?.kind
  return kind === 'completed' ? 'ok' : 'alert'
}

export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(ctx, rawConfig)
  const now = () => Date.now()
  const lastAssistant = new Map()
  const lastNotified = new Map()
  const pending = new Map()
  // STACKING ORDINAL. How many cards are on screen right now, handed to each new
  // card so it can retreat up and to the left of the ones in front of it.
  //
  // This is the ONLY place the ordinal can live. Each card is a separate
  // PowerShell child process with its own window (see notify.js), so a card
  // cannot count its siblings — it would have to enumerate windows, which is
  // slow, fragile, and racy. The host sees every notification, so it knows the
  // count exactly.
  //
  // The count MUST decay, or the 100th card of a long day would be pushed off
  // the screen. Decay is by time, not by tracking closes: a card lives
  // popupTimeoutMs, so if the last card was fired longer ago than that, the ones
  // before it have expired and the stack is empty again. That is a good enough
  // approximation of "how many are on screen" without needing the children to
  // report back, and it errs toward fewer retreats (a shorter stack) rather than
  // more, which is the safe direction.
  //
  // The decay timer is armed LAZILY — only once a card has actually been shown,
  // and only while the stack is non-empty. A quiet session therefore has no
  // background timer at all, which matters for more than tidiness: the notifier
  // is loaded for the whole life of the host, and a permanently self-rearming
  // timer would be a wakeup every few seconds forever to do nothing.
  let stackCount = 0
  let lastCardAt = 0
  let stackDecayTimer = null

  ctx.logger?.info?.('attention: notifier active')

  const traced = new Set()

  /**
   * The trace is diagnostics and must be switchable off: it writes on every
   * listener entry of a long session, and a notifier should not be the thing
   * filling the temp directory. Off is a supported steady state, not a debug
   * afterthought — the log exists to answer "did it fire", and once that is
   * answered it has no further use.
   */
  function write(event, detail) {
    if (cfg.trace) trace(event, detail, cfg.traceFile)
  }

  /** First-occurrence-only breadcrumb, so a busy session cannot flood the log. */
  function once(key, event, detail) {
    if (traced.has(key)) return
    traced.add(key)
    write(event, detail)
  }

  /**
   * Records that a listener was reached, once per distinct shape, so "the host
   * never called us" is distinguishable from "we were called and chose to stay
   * quiet". A missed ring and a correct silence look identical from outside.
   */
  function reached(name, payload) {
    once(`saw:${name}`, `saw:${name}`, {
      keys: payload && typeof payload === 'object' ? Object.keys(payload) : typeof payload,
    })
  }

  /** Delegated work and background jobs should not ring the human. */
  function isRootAgent(id) {
    const agents = ctx.get?.('agents')
    if (!agents || typeof agents.get !== 'function') {
      once('gate:no-agents-service', 'gate:no-agents-service', { id })
      return true
    }
    try {
      const agent = agents.get(id)
      if (agent === undefined) {
        once(`gate:agent-missing:${id}`, 'gate:agent-missing', { id })
        return true
      }
      const roots = agents.roots?.()
      if (!Array.isArray(roots)) {
        once('gate:no-roots', 'gate:no-roots', { id, rootsType: typeof roots })
        return true
      }
      const isRoot = roots.includes(agent)
      once(`gate:isRoot:${id}:${isRoot}`, 'gate:isRoot', { id, isRoot, rootCount: roots.length })
      return isRoot
    } catch (error) {
      once(`gate:isRoot-threw:${id}`, 'gate:isRoot-threw', { id, error: String(error) })
      return true
    }
  }

  function shouldNotify(key) {
    const stamp = now()
    const previous = lastNotified.get(key)
    if (previous !== undefined && stamp - previous < cfg.minIntervalMs) {
      write('suppressed:min-interval', { key, elapsed: stamp - previous, minIntervalMs: cfg.minIntervalMs })
      return false
    }
    lastNotified.set(key, stamp)
    return true
  }

  function notify(title, body, tone = 'ok', sessionId = undefined) {
    let jumpUrl
    if (sessionId !== undefined && cfg.jump !== false) {
      jumpUrl = offerJump(sessionId)
    }
    // Claim the next ordinal in the stack. `stackCount` is how many cards are
    // already on screen, so the new one takes that value (0 = the front card,
    // 1 = the first retreat, ...) and the count then grows by one.
    //
    // The decay below is what keeps this bounded: once popupTimeoutMs has passed
    // since the last card, the stack is considered empty and the count restarts
    // at 0, so a card fired after a quiet spell is always the front one.
    const stackIndex = stackCount
    stackCount += 1
    lastCardAt = now()
    armStackDecay()
    // `stack: false` turns the retreat off entirely: every card then sits at the
    // same corner and the newest one hides the rest. That is a supported steady
    // state, not a broken one — some users would rather see one card than a
    // stack. The ordinal is still counted and still decays, so re-enabling
    // stacking later resumes from a live count instead of a stale one.
    const handOff = cfg.stack === false ? undefined : stackIndex
    write('notify', { title, body, tone, jump: jumpUrl !== undefined, stackIndex: handOff })
    return ring(jumpUrl === undefined ? cfg : { ...cfg, jumpUrl, stackIndex: handOff }, title, body, ctx.logger, tone)
  }

  /**
   * Arm the stack decay, once, for as long as there is a stack to decay.
   *
   * The ordinal must come back down or the 100th card of a long day would be
   * pushed off the screen: a card lives popupTimeoutMs, so once that long has
   * passed since the last card was fired the stack is empty again and the next
   * card is the front one.
   *
   * Lazy, on purpose. A quiet session has no stack and needs no timer — the
   * notifier is loaded for the whole life of the host, and a permanently
   * self-rearming timer would be a wakeup every few seconds forever to do
   * nothing. It also re-arms only while the stack is non-empty, so it stops by
   * itself once the corner is clear.
   *
   * Re-arming uses timeout() rather than an interval, because ctx.timer's
   * interval takes no callback — timeout(fn, delay) is the only schedulable
   * primitive here, the same one the nudge reminders use.
   */
  function armStackDecay() {
    if (typeof ctx.timer?.timeout !== 'function') return
    if (stackDecayTimer !== null) return
    const decay = () => {
      stackDecayTimer = null
      if (stackCount > 0 && now() - lastCardAt > cfg.popupTimeoutMs) {
        stackCount = 0
        write('stack:reset', { idleFor: now() - lastCardAt, popupTimeoutMs: cfg.popupTimeoutMs })
        return
      }
      // Still cards on screen (or a card fired since this timer was armed):
      // keep watching.
      armStackDecay()
    }
    const interval = Math.max(1000, Math.min(5000, Math.floor(cfg.popupTimeoutMs / 4)))
    stackDecayTimer = ctx.timer.timeout(decay, interval, 'stack-decay')
  }

  // ---- the click-to-jump seam --------------------------------------------
  //
  // Raising the DSH window lands on whatever session the page was last
  // showing. The card must also say *which* session interrupted you, and only
  // the browser page can switch its own view. So a firing records a one-shot
  // token bound to the session, the card's click POSTs that token to a route
  // registered here, and the plugin's client half (client.js) polls the queue
  // and calls uiWorkspace.openSession. The token is what keeps an unrelated
  // page or process from claiming jumps it never saw.

  const jumps = new Map()
  const claimed = []
  // Captured from the injected webServer context. Reading `ctx.webServer`
  // outside this plugin's inject list throws at the proxy, not undefined —
  // and getOrigin() itself throws until the port is bound, so the origin is
  // read lazily at offer time, not at inject time.
  let server = null

  function offerJump(sessionId) {
    const stamp = now()
    for (const [key, entry] of jumps) {
      if (stamp - entry.at > JUMP_TTL_MS) jumps.delete(key)
    }
    const token = randomUUID()
    jumps.set(token, { sessionId, at: stamp })
    try {
      const origin = server?.getOrigin()
      return typeof origin === 'string'
        ? `${origin.replace(/\/+$/, '')}/dsh-attention/click/${token}`
        : undefined
    } catch {
      return undefined // not bound yet, or no URL form (CLI deployments)
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sctx) => {
      server = sctx.webServer
      try {
        sctx.effect(() => sctx.webServer.register({
          kind: 'prefix',
          // NO trailing slash. The host matches a prefix with
          // `pathname === prefix || pathname.startsWith(prefix + '/')`, so a
          // trailing slash here would test `startsWith('/dsh-attention//')`,
          // which no real URL satisfies: the route registers, getOrigin() still
          // returns a URL, every click lands on 404, and the jump silently does
          // nothing. `/dsh-attention` matches `/dsh-attention/pending` and
          // `/dsh-attention/click/<token>` exactly as intended.
          path: '/dsh-attention',
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://dsh.local')
            const parts = url.pathname.split('/').filter(Boolean)

            // POST /click/<token> — the card's own report. Deliberately NOT
            // fenced: the caller is a detached PowerShell with no browser
            // identity, and the random token is itself the capability. The
            // response carries no data (204), so a forged request can only
            // consume a token the forger already saw on screen.
            if (parts[1] === 'click' && req.method === 'POST' && parts[2] !== undefined) {
              const entry = jumps.get(parts[2])
              if (entry !== undefined) {
                jumps.delete(parts[2])
                if (claimed.length < 16) claimed.push(entry.sessionId)
              }
              res.writeHead(204)
              res.end()
              return
            }

            // GET /pending — hands out session ids, so it answers only the
            // authenticated page. Where no connection service exists there is no
            // fence to consult and the request is served (a deployment with no
            // remote-access layer has no unauthenticated page to hide from).
            if (parts[1] === 'pending' && req.method === 'GET') {
              const connection = ctx.get?.('connection')
              if (connection !== null && connection !== undefined && typeof connection.requestRejection === 'function' && connection.requestRejection(req) !== undefined) {
                res.writeHead(403)
                res.end()
                return
              }
              const sessionId = claimed.shift()
              res.writeHead(sessionId === undefined ? 204 : 200, { 'content-type': 'application/json' })
              res.end(sessionId === undefined ? '' : JSON.stringify({ sessionId }))
              return
            }

            res.writeHead(404)
            res.end()
          },
        }), 'attention: click-jump routes')
      } catch (error) {
        // A composition-level route collision throws here. Say so loudly: the
        // failure is otherwise invisible (the card still rings and still
        // carries a jump URL), and the user only sees "clicking does nothing".
        ctx.logger?.warn?.(`attention: could not register click-jump routes: ${String(error)}`)
      }
    })
  }

  /**
   * A question or approval nobody answers is a task that never resumes. Nudge
   * on a slow cadence until it settles, so an unattended prompt cannot
   * silently strand the turn.
   */
  function trackPending(key, body, tone, sessionId) {
    cancelPending(key)
    let remaining = Math.max(0, Math.floor(cfg.maxReminders))
    if (remaining === 0 || !(cfg.remindEveryMs > 0)) return
    const state = { timers: [] }
    const schedule = () => {
      if (remaining <= 0) return
      remaining -= 1
      const timer = ctx.timer.timeout(() => {
        if (!pending.has(key)) return
        // A nudge is still the same kind of interruption — a question is still
        // a question — so it keeps the tone of the request it repeats.
        notify(cfg.title, `仍在等待你的回应：${body}`, tone, sessionId)
        schedule()
      }, cfg.remindEveryMs)
      state.timers.push(timer)
    }
    pending.set(key, state)
    schedule()
  }

  function cancelPending(key) {
    const state = pending.get(key)
    if (state === undefined) return
    for (const timer of state.timers) {
      try {
        timer()
      } catch {
        /* the timer already fired */
      }
    }
    pending.delete(key)
  }

  once('applied', 'apply:start', {
    keys: Object.keys(cfg),
    hasTimer: Boolean(ctx.timer),
    hasEffect: typeof ctx.effect === 'function',
    hooksQuestion: countHooks('user-questions/request'),
    hooksApproval: countHooks('approval/request'),
  })
  if (cfg.trace) {
    ctx.logger?.info?.(`attention: writing diagnostics to ${cfg.traceFile}`)
  }

  if (cfg.askGuidance) {
    try {
      ctx.get?.('systemPrompt')?.section?.({ name: 'attention:human-choice', order: 9500, text: GUIDANCE })
    } catch (error) {
      ctx.logger?.warn?.(`attention: could not register prompt guidance: ${String(error)}`)
    }
  }

  /**
   * How many listeners the host has already registered for a waterfall event.
   *
   * Ordering is what decides whether we are ever called. cordis runs waterfall
   * listeners outermost-first (`cbs.shift()`), and a listener that answers
   * without calling `next()` vetoes everything inside it. We register last — the
   * bundle sits at the end of the profile's list — so any built-in answerer
   * already parked on the event hides the request from us completely. Counting
   * the incumbents is the only way to observe that from inside the plugin.
   */
  function countHooks(name) {
    try {
      const hooks = ctx.events?._hooks?.[name]
      return Array.isArray(hooks) ? hooks.length : -1
    } catch {
      return -1
    }
  }

  // ---- the human-choice seam -------------------------------------------

  ctx.on('user-questions/request', (request, next) => {
    reached('user-questions/request', request)
    const questions = Array.isArray(request?.questions) ? request.questions : []
    const agentId = request?.agent?.id
    if (cfg.notifyOnQuestion && questions.length > 0 && (agentId === undefined || isRootAgent(agentId))) {
      const heading = questions.length === 1
        ? (questions[0].header ?? questions[0].question ?? '需要你选择')
        : `${questions.length} 个问题需要你选择`
      const detail = questions
        .map((question) => clip(question?.question ?? '', 120))
        .filter(Boolean)
        .join(' / ')
      const body = clip(detail || heading)
      const key = `question:${agentId ?? 'any'}`
      if (shouldNotify(key)) notify(cfg.title, `需要你选择：${body}`, 'ask', agentId)
      trackPending(key, body, 'ask', agentId)
      request?.signal?.addEventListener?.('abort', () => cancelPending(key), { once: true })
    }
    return next().finally(() => {
      if (agentId !== undefined) cancelPending(`question:${agentId}`)
    })
    // prepend: see the block comment on countHooks above.
  }, { prepend: true })

  ctx.on('approval/request', (request, next) => {
    reached('approval/request', request)
    const agentId = request?.agent?.id
    if (cfg.notifyOnApproval && (agentId === undefined || isRootAgent(agentId))) {
      const display = request?.displayReason
      const localized = display && typeof display === 'object'
        ? (display.zh ?? display.en ?? Object.values(display).find((value) => typeof value === 'string'))
        : undefined
      const reason = clip(localized ?? request?.reason ?? request?.toolName ?? '需要你批准', 160)
      const key = `approval:${agentId ?? 'any'}`
      if (shouldNotify(key)) notify(cfg.title, `需要你批准：${reason}`, 'ask', agentId)
      trackPending(key, reason, 'ask', agentId)
      request?.signal?.addEventListener?.('abort', () => cancelPending(key), { once: true })
    }
    return next().finally(() => {
      if (agentId !== undefined) cancelPending(`approval:${agentId}`)
    })
    // prepend: see the block comment on countHooks above.
  }, { prepend: true })

  // ---- the completion seam ---------------------------------------------

  ctx.on('session/event', (session, event) => {
    reached('session/event', event)
    once(`type:${event?.type}`, 'saw-event-type', { type: event?.type })
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'assistant/message') {
      const text = textOf(data.message)
      if (text !== '') lastAssistant.set(session.id, text)
      return
    }
    if (type !== 'turn/end') return

    const summary = lastAssistant.get(session.id) ?? ''
    if (cfg.notifyOnTurnEnd && isRootAgent(session.id) && worthRinging(data.reason)) {
      const reason = describeReason(data.reason)
      const key = `turn:${session.id}`
      if (shouldNotify(key)) {
        const detail = cfg.includeSummary && summary !== '' ? clip(summary, 180) : ''
        notify(
          cfg.title,
          detail === '' ? `任务结束：${reason}` : `任务结束（${reason}）：${detail}`,
          toneOfEnding(data.reason),
          session.id,
        )
      }
    }
    lastAssistant.delete(session.id)
    cancelPending(`question:${session.id}`)
    cancelPending(`approval:${session.id}`)
  })

  ctx.on('agent/disposed', (payload) => {
    reached('agent/disposed', payload)
    const agent = payload?.agent
    if (!agent) return
    lastAssistant.delete(agent.id)
    cancelPending(`question:${agent.id}`)
    cancelPending(`approval:${agent.id}`)
  })

  ctx.effect(() => () => {
    for (const key of [...pending.keys()]) cancelPending(key)
  })
}
