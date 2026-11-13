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
import { ring, DEFAULT_RAISE_LOG } from './notify.js'
import { POPUP_PRESETS, POPUP_TONES, popup } from './popup.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const inject = ['timer']

export const DEFAULT_TRACE = join(tmpdir(), 'dsh-attention', 'trace.log')

/** How long a card click may sit unclaimed before its jump target is dropped. */
const JUMP_TTL_MS = 60_000
/** Ceiling for that lifetime: a card that stays until clicked still cannot park a token forever. */
const JUMP_TTL_MAX_MS = 12 * 60 * 60_000

/**
 * How long a jump token must outlive the card that carries it.
 *
 * One flat minute was right for the default card (it lives popupTimeoutMs, ten
 * seconds) and wrong for every other one. A card told to stay until clicked can
 * sit on screen for hours, and a click at minute five then found an expired
 * token: every stage of the seam was healthy and the click still "did nothing",
 * which is the one failure mode this seam exists to make visible. The token now
 * lives at least as long as its card, plus a margin for a slow click.
 */
function jumpTtlFor(timeoutMs) {
  const lived = Number(timeoutMs)
  // `0` is not a missing value here, it means "stay until clicked".
  if (!Number.isFinite(lived) || lived <= 0) return JUMP_TTL_MAX_MS
  return Math.min(JUMP_TTL_MAX_MS, Math.max(JUMP_TTL_MS, Math.floor(lived) + 30_000))
}
/**
 * How long a delivered jump keeps being readable.
 *
 * Long enough for several open pages to poll it at least once (the polling
 * cadence is one second) and short enough that a user who navigated away is not
 * dragged back. Each page applies a given jump id exactly once.
 *
 * The bound is set by the slowest honest reader, not the fastest one: a card
 * clicked while the harness sits in the tray queues its claim against a
 * renderer whose timers Chromium has throttled to background speed. The page
 * wakes on the raise, but it does not necessarily run a poll inside the first
 * second — the recorded click-to-handout gaps on this machine top out past
 * twelve seconds, and every claim older than this constant answered "nothing
 * pending". A page that came back late used to find the jump gone: the window
 * returned, the conversation did not. Sixty seconds covers the wake and the
 * unfreeze while staying short enough to be tied to the click that asked.
 */
const CLAIM_TTL_MS = 60_000

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
  // A turn that was STARTED by something other than the human — another agent
  // message, a schedule, a webhook, a goal resume, a subagent landing, a team
  // message, a background job or a plugin runner — has no human watching it
  // begin, so its "task finished" card is noise that trains the reader to
  // ignore the ring. Exempt those turns entirely. Only confirmed execution
  // triggers are exempted: when no `user/message` source is on record (the
  // event never arrived, or the host does not send one) the plugin keeps its
  // old behaviour and rings.
  exemptExecutionTurns: true,
  includeSummary: true,
  askGuidance: true,
  // Register the `attention_popup` tool: one call fires one card, so delivery
  // can be checked without staging a question or finishing a turn. On by
  // default because a notifier you cannot test is a notifier you cannot trust;
  // off removes the tool without touching the real triggers.
  quickPopup: true,
  minIntervalMs: 4_000,
  remindEveryMs: 120_000,
  maxReminders: 3,
  soundFile: 'C:\\Windows\\Media\\notify.wav',
  // Fallback headline: used only when the conversation has no name yet (a
  // brand-new session before its first `session/title` event). The headline
  // normally names the conversation.
  title: 'DeepSeek Harness',
  // The small muted product line ABOVE the headline. Separate from `title`
  // because the headline is now the conversation's name, so the product label
  // needs a setting of its own — with the two sharing one field there was
  // nothing left to print in the eyebrow slot and it rendered blank.
  brand: 'DeepSeek Harness',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  // Process name whose window is raised when the card is clicked. Matched
  // against the friendly process name (`DeepSeek Harness`, not the exe file and
  // not a window title). The raiser enumerates that process's top-level windows
  // itself rather than trusting MainWindowHandle, which is 0 for a window the
  // app hid when its close button was sent to the tray; a window that is hidden
  // is woken through the app's own single-instance path, so the renderer really
  // comes back rather than showing a frozen last frame.
  focusProcess: 'DeepSeek Harness',
  // Where the raiser logs which window it picked and how it woke it. Raising
  // fails silently — the card closes either way — so this file is the only way
  // to tell "nothing found" from "already where you left it". Empty string
  // disables it.
  raiseLog: DEFAULT_RAISE_LOG,
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
  // A max-token cutoff is the machine deciding to keep working: the turn was
  // truncated by the output budget and auto-continue opens a fresh turn to
  // finish the very same answer. That truncation's ENDING has no reader — the
  // human is waiting for the completed answer, not for a card announcing it ran
  // out of room mid-sentence. Silencing it here (regardless of who started the
  // turn) keeps the chain's real end from being preceded by a pointless chime.
  if (kind === 'max-tokens') return false
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

/**
 * The source kinds that mean a TURN STARTED WITHOUT THE HUMAN.
 *
 * These are the ones the client itself labels as a trigger rather than a
 * message: a goal resume, another agent's message, a team message, a subagent
 * landing, a webhook delivery, a scheduled run, a background job settling, or
 * the cordis host runner. Every one of them is a machine deciding to work; a
 * card about how that work ended is addressed to nobody.
 *
 * `dsh-continue-on-truncate` is in here too, even though the human is watching:
 * that plugin opens a FRESH turn to finish an answer that hit the output token
 * limit, so its `user/message` carries a non-'user' source kind. The turn it
 * starts is a continuation of work the machine already began, so its ending is
 * not the event the reader is waiting for — the chain's own end is.
 *
 * This set is now the SINGLE SOURCE OF TRUTH for `isExecutionTrigger`. Add a
 * kind here only when the client really labels it a machine trigger — never
 * "because it looks like a machine". An unknown or human-side kind (the real
 * host sends skill-catalog, time-context, dsh-mnemon, …) MUST keep ringing,
 * because silence is the failure mode this plugin exists to prevent.
 */
const EXECUTION_TRIGGER_KINDS = new Set([
  'goal',
  'agent-message',
  'team-message',
  // NOTE: 'subagent-settled' is intentionally NOT an execution trigger. When a
  // subagent's result is handed back, the host re-posts a user/message on the
  // ROOT session (source.kind === 'subagent-settled') and the root resumes to
  // produce the final answer. That turn IS being read by the human -- it is
  // the main agent finishing the delegated task in front of them. Gating it
  // as an "execution" turn wrongly silenced the completion the user waited
  // for. A subagent's OWN session ending is still silenced by the
  // isRootAgent/excludeDelegated gate (its bare-uuid id gives it away), so
  // removing the kind here does not start ringing for delegated work itself.
  'webhook',
  'schedule',
  'tool-jobs',
  'cordis-host-runner',
  'dsh-continue-on-truncate',
])

/**
 * Did something other than the human start this turn?
 *
 * Only the kinds in EXECUTION_TRIGGER_KINDS (the ones the client itself labels
 * as machine triggers) exempt a finished turn. Every other kind — including
 * kinds this plugin has never heard of — RINGS. That default-open behaviour is
 * deliberate: a turn whose `user/message` carried no source is indistinguishable
 * from a turn the plugin was simply never told about, and an unrecognised kind
 * is not evidence of a machine. The real host sends human-side kinds
 * (skill-catalog, time-context, dsh-mnemon, …) that are absent from any
 * human allow-list, so inverting against such a list silences exactly those
 * turns — that inversion is the regression this fixes.
 */
function isExecutionTrigger(kind) {
  if (typeof kind !== 'string' || kind === '') return false
  return EXECUTION_TRIGGER_KINDS.has(kind)
}

/**
 * Is this session id the shape of a DELEGATED subagent / background job?
 *
 * The host registers a human main conversation under a `session-<uuid>` id.
 * Delegated work does not: a subagent runs under a bare uuid (`27dd9e09-…`) and
 * a provider run under a provider-prefixed id (`mnemon-run-v1-…`). Measured over
 * the plugin's own captured `turn/end` survey, every human conversation that ever
 * rang carried a `session-` id and every subagent / background job did not --
 * 43/43 machine turns were bare-uuid / other-prefixed, 0 were `session-`.
 *
 * This is the roots-INDEPENDENT half of the gate. `agents.roots()` intermittently
 * returns undefined in the real host, and a still-registered subagent (one whose
 * record has not been disposed by the time its turn ends) is a member of `roots()`
 * anyway, so `roots().includes(agent)` cannot tell it from the human. The id shape
 * can.
 *
 * This is deliberately a BLACKLIST of the delegated shape, not a whitelist of
 * `session-`: an id this plugin has never seen (a synthetic id, a future host
 * shape) fails this test and so still RINGS, routed through the roots gate as
 * before. Silence stays the delegated-work failure mode, never the
 * missing-a-real-chime one.
 */
const DELEGATED_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9-]*-run-[a-z0-9-]*)$/i

function isDelegatedSessionId(id) {
  return typeof id === 'string' && DELEGATED_ID_RE.test(id)
}

export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(ctx, rawConfig)
  const now = () => Date.now()
  const lastAssistant = new Map()
  // The source kind of the message that started each session's current turn.
  // Read off `user/message` so a turn that a machine began can be told apart
  // from one the human began.
  const triggerKinds = new Map()
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

  /**
   * Delegated work and background jobs should not ring the human.
   *
   * `strict` is for low-value, end-of-turn chimes (turn/end). There the safe
   * default when we cannot positively confirm the agent is the root is to stay
   * silent: a subagent's / background job's `turn/end` often arrives after the
   * agent has been disposed, so `agents.get(id)` is `undefined` and guessing
   * "root" would ring the human for delegated work — the exact noise this gate
   * exists to suppress.
   *
   * Callers that announce something the human must act on (a question, an
   * approval) keep the non-strict default: there, guessing "root" on an
   * unresolvable agent errs toward not losing a real prompt.
   */
  function isRootAgent(id, { strict = false, excludeDelegated = false } = {}) {
    // The roots-independent half of the gate (see isDelegatedSessionId): a
    // still-registered subagent slips past the record checks below because it is
    // a member of roots(), but its bare-uuid id gives it away.
    if (excludeDelegated && isDelegatedSessionId(id)) {
      once(`gate:delegated-id:${id}`, 'gate:delegated-id', { id, strict })
      return false
    }
    const agents = ctx.get?.('agents')
    if (!agents || typeof agents.get !== 'function') {
      once('gate:no-agents-service', 'gate:no-agents-service', { id, strict })
      return !strict
    }
    try {
      const agent = agents.get(id)
      if (agent === undefined) {
        once(`gate:agent-missing:${id}`, 'gate:agent-missing', { id, strict })
        // A settled subagent / background job whose agent record is already
        // gone. Never a reason to ring on its own; only a strict caller treats
        // this as "not root". Non-strict callers (question/approval) still ring.
        return !strict
      }
      const roots = agents.roots?.()
      if (!Array.isArray(roots)) {
        once('gate:no-roots', 'gate:no-roots', { id, rootsType: typeof roots, strict })
        // The agent record is STILL REGISTERED here (we got past the
        // `agent === undefined` branch above) -- only the roots enumeration is
        // unavailable. In the real host `roots()` intermittently returns
        // undefined even for a live human conversation, so treating "no roots"
        // as "not root" would silence the very chime a human is waiting on.
        // Fall through to ring, exactly as the pre-strict gate did: the noise
        // we actually care about (a settled subagent / background job) is
        // caught by the `agent-missing` branch, not this one.
        return true
      }
      const isRoot = roots.includes(agent)
      once(`gate:isRoot:${id}:${isRoot}`, 'gate:isRoot', { id, isRoot, rootCount: roots.length, strict })
      return isRoot
    } catch (error) {
      once(`gate:isRoot-threw:${id}`, 'gate:isRoot-threw', { id, error: String(error), strict })
      return !strict
    }
  }

  /**
   * Resolve the conversation's NAME for a card from the live session.
   *
   * The card's headline used to print the fixed product label "DeepSeek
   * Harness", which told the user nothing when three conversations were open.
   * The host keeps each conversation's name as a `session/title` log event on
   * the session (written by the session-title providers, and by the user's own
   * rename), so we read the latest one off `ctx.sessions.get(id).log`.
   *
   * Returns '' when there is nothing to show, and the caller falls back to the
   * configured label. That is the honest failure: a card headed "DeepSeek
   * Harness" is still readable, whereas an empty headline row is a hole in the
   * layout.
   *
   * Defensive by design: every access is optional-chained and wrapped in
   * try/catch, because a notification is the wrong place to throw — a broken
   * resolver must never silence the card.
   *
   * @param {string|undefined} sessionId
   * @returns {string} the conversation name, or '' to let the caller fall back.
   */
  function resolveSessionName(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return ''
    try {
      const sessions = ctx.get?.('sessions')
      const session = sessions?.get?.(sessionId)
      const log = session?.log
      if (Array.isArray(log)) {
        // Last-wins: a conversation can be renamed, and the newest
        // `session/title` event is the name the user currently sees in the
        // workspace list. Scanning backwards stops at the first hit.
        for (let i = log.length - 1; i >= 0; i -= 1) {
          const event = log[i]
          if (event?.type === 'session/title') {
            const value = event?.data?.title ?? event?.data?.name ?? event?.data?.text
            if (typeof value === 'string' && value.trim() !== '') return value.trim()
          }
        }
      }
    } catch (error) {
      once('resolveSessionName-threw', 'resolveSessionName-threw', { sessionId, error: String(error) })
    }
    return ''
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
      // The card lives `popupTimeoutMs` (notify.js treats popupMs as a floor
      // under it), so that is the lifetime the token has to cover.
      jumpUrl = offerJump(sessionId, jumpTtlFor(Math.max(cfg.popupTimeoutMs, cfg.popupMs)))
    }
    // THE HEADLINE NAMES THE CONVERSATION, not the product.
    //
    // Every call site below passes `cfg.title` — the fixed product label — as
    // `title`, because that label is the right answer when nothing better is
    // known. But when the host has a name for this conversation, that name is
    // strictly more useful: the user with four windows open needs to know
    // WHICH one finished, and "DeepSeek Harness" appears on all four. So the
    // session's own name wins and the configured label is only the fallback.
    //
    // The product label is not lost: it moves to the small eyebrow line above
    // the headline (`brand` below), which is where it belongs on a card that
    // has both.
    const sessionName = resolveSessionName(sessionId)
    const headline = sessionName !== '' ? sessionName : title
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
    write('notify', { title: headline, brand: cfg.brand, body, tone, jump: jumpUrl !== undefined, stackIndex: handOff })
    const settings = { ...cfg, brand: cfg.brand, ...(jumpUrl === undefined ? {} : { jumpUrl, stackIndex: handOff }) }
    return ring(settings, headline, body, ctx.logger, tone)
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
  /**
   * Why a jump never turned into a navigation, counted by stage.
   *
   * Every stage of this seam fails silently and identically from the outside:
   * the card rings, the click looks processed, and the window stays where it
   * was. Counting each stage separately is the only way to tell "the card
   * never reached us" from "the page never polled" from "openSession ran but
   * the session did not change" — three failures that need three different
   * fixes and all present as "clicking the card does nothing".
   */
  const jumpStats = { offered: 0, offeredUrl: 0, clicked: 0, polled: 0, landed: 0, failed: 0 }
  /**
   * Delivered jumps, kept as a short-lived BROADCAST rather than a queue.
   *
   * A single-consumer queue was the wrong shape twice over: the browser page and
   * every extra window the user has open all poll the same route, so whichever
   * one happened to ask first consumed the jump — and if that was a background
   * tab sitting on some other conversation, the visible window never heard about
   * it and the click looked dead. So the entry stays readable for a short window
   * and each page recognises the jump id it already applied.
   */
  const claimed = []
  // The jumpId last announced on `pending:handed-out`, so a visible page polling
  // every second does not produce a log line per poll.
  let lastHandedOut = null
  // Captured from the injected webServer context. Reading `ctx.webServer`
  // outside this plugin's inject list throws at the proxy, not undefined —
  // and getOrigin() itself throws until the port is bound, so the origin is
  // read lazily at offer time, not at inject time.
  let server = null

  function offerJump(sessionId, ttlMs = JUMP_TTL_MS) {
    const stamp = now()
    for (const [key, entry] of jumps) {
      if (stamp - entry.at > entry.ttl) jumps.delete(key)
    }
    const token = randomUUID()
    // The TTL is per entry, not global: a real card lives popupTimeoutMs and the
    // one-minute default is generous for it, but a quick-popup card can be told
    // to stay until clicked (`durationMs: 0`) and then sits on screen as long as
    // the user ignores it. A token that expired underneath such a card would
    // make its click do nothing — the exact failure this seam exists to expose.
    jumps.set(token, { sessionId, at: stamp, ttl: ttlMs })
    jumpStats.offered += 1
    try {
      const origin = server?.getOrigin()
      const url = typeof origin === 'string'
        ? `${origin.replace(/\/+$/, '')}/dsh-attention/click/${token}`
        : undefined
      if (url !== undefined) jumpStats.offeredUrl += 1
      return url
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
              // Expiry is checked HERE as well as at offer time. Pruning only on
              // offer meant a token outlived its stated lifetime whenever no new
              // card happened to be fired: a card clicked an hour late still
              // navigated, which is not a courtesy — it drags the user back to a
              // conversation they left on purpose.
              const fresh = entry !== undefined && now() - entry.at <= entry.ttl
              if (fresh) {
                jumps.delete(parts[2])
                claimed.push({ jumpId: parts[2], sessionId: entry.sessionId, at: now() })
                while (claimed.length > 8) claimed.shift()
                // The one fact that splits "clicking does nothing" in two: an
                // absent line means the card never reached us (a dead URL, a
                // blocked request, a card dismissed before the paint), a
                // present one means the click landed and everything after it is
                // the browser page's problem.
                jumpStats.clicked += 1
                // Spread, not nested: `trace` flattens any nested object to a
                // JSON string, which would turn the tally into a quoted blob
                // nobody can grep. One key per stage keeps it readable.
                write('click', { jumpId: parts[2], sessionId: entry.sessionId, age: now() - entry.at, ...jumpStats })
              } else {
                // Two different stories, kept apart on purpose: a token that
                // expired (the card outlived its own lifetime — a real card
                // dismissed late, or a quick card whose duration was short) is
                // normal, while an id we never minted is a forgery or a replay.
                // Collapsing them would hide a token-lifetime bug behind the
                // word "unknown".
                if (entry !== undefined) {
                  jumps.delete(parts[2])
                  write('click:expired', {
                    jumpId: parts[2],
                    sessionId: entry.sessionId,
                    age: now() - entry.at,
                    ttl: entry.ttl,
                  })
                } else {
                  write('click:unknown', { jumpId: parts[2], known: jumps.size })
                }
              }
              res.writeHead(204)
              res.end()
              return
            }

            // POST /ping — the page's own report about a jump. Same fence as
            // /pending: only the authenticated page may write here, because
            // these lines land in the diagnostics file and an unfenced writer
            // could forge "the jump worked".
            if (parts[1] === 'ping' && req.method === 'POST') {
              const connection = ctx.get?.('connection')
              if (connection !== null && connection !== undefined && typeof connection.requestRejection === 'function' && connection.requestRejection(req) !== undefined) {
                res.writeHead(403)
                res.end()
                return
              }
              let raw = ''
              req.on('data', (chunk) => {
                if (raw.length < 8_000) raw += chunk
              })
              req.on('end', () => {
                let detail = {}
                try {
                  detail = JSON.parse(raw === '' ? '{}' : raw)
                } catch {
                  detail = { unparsable: true }
                }
                const event = typeof detail?.event === 'string' ? detail.event : 'event'
                // The page's own verdict on the navigation is the last stage
                // that can fail, and the only one that can say the session
                // actually changed. Counted here rather than parsed later, so
                // the totals survive a trace switched off.
                if (event === 'step:landed') {
                  if (detail?.landed === true) jumpStats.landed += 1
                  else jumpStats.failed += 1
                }
                // `detail` last: the page's own verdict must not be overwritten
                // by a tally key of the same name. `landed` is a fact here, not
                // a counter, and losing it to `landed: 2` made a successful
                // jump read like a confused one.
                write(`client:${event}`, { ...jumpStats, ...detail })
                res.writeHead(204)
                res.end()
              })
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
              // Broadcast, not hand-out: the newest fresh claim is answered to
              // every asking page, and the page dedupes on `jumpId`. Expiry is
              // short (CLAIM_TTL_MS) so a claim cannot keep following the user
              // around the app after it has been acted on.
              const stamp = now()
              while (claimed.length > 0 && stamp - claimed[0].at > CLAIM_TTL_MS) claimed.shift()
              const newest = claimed.at(-1)
              if (newest !== undefined) {
                jumpStats.polled += 1
                // One line per claim, not per poll: a visible page asks every
                // second, and a line a second would bury the interesting rows.
                // The first hand-out is the fact worth keeping — the page has
                // the claim; anything after that is the page's problem.
                if (newest.jumpId !== lastHandedOut) {
                  lastHandedOut = newest.jumpId
                  write('pending:handed-out', { jumpId: newest.jumpId, sessionId: newest.sessionId, ...jumpStats })
                }
              }
              res.writeHead(newest === undefined ? 204 : 200, { 'content-type': 'application/json' })
              res.end(newest === undefined ? '' : JSON.stringify({ sessionId: newest.sessionId, jumpId: newest.jumpId }))
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

  // ---- the quick-popup seam --------------------------------------------
  //
  // Every real trigger below is an EVENT: exercising delivery means staging a
  // question or finishing a turn, then waiting for the host to route it. That
  // loop is slow, it needs a live session, and it only ever covers the path
  // reachable from the chat you happen to be sitting in. `attention_popup`
  // fires one card on demand through the same `ring` those triggers use, so
  // "is the channel working" is one tool call instead of one staged session.
  //
  // Registered through `inject` rather than a hard dependency: the tool
  // registry is what makes the seam reachable from a conversation, and a
  // profile without it (or with the seam switched off) simply does not get the
  // tool — the notifier itself keeps working either way.
  if (cfg.quickPopup && typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (sctx) => {
      try {
        return sctx.effect(() => sctx.tools.register({
          name: 'attention_popup',
          description: 'Fire one attention card immediately, to check that delivery works. Bypasses the real triggers (question, approval, turn end), the min-interval gate and the popup switch, so one call always attempts a card. Use a preset to check the painter end to end, or pass title/body to preview exact text. Returns what was attempted and whether a delivery process was started; a card still has to be looked at on screen.',
          // `parameters` must be a JSON Schema *object*: the top level needs its
          // own `type: "object"` before `properties`. Without it the WorkBuddy
          // gateway rejects the whole request for deepseek models with
          // "invalid function call parameters", while lenient gateways
          // (minimax/hy/step) silently accept the bare property map.
          parameters: {
            type: 'object',
            properties: {
              preset: {
                type: 'string',
                enum: Object.keys(POPUP_PRESETS),
                description: 'Canned sample to show, with markup chosen to exercise every branch of the painter. Its title, body and tone are used for any field not passed explicitly.',
              },
              title: { type: 'string', description: 'Card heading. Defaults to the preset heading, else this conversation\'s name.' },
              body: { type: 'string', description: 'Card text, Markdown-capable (bold, inline code, links, bullet lists). Defaults to the preset body.' },
              tone: {
                type: 'string',
                enum: POPUP_TONES,
                description: 'Accent and status chip: ok = finished, ask = waiting on you, alert = something failed. Defaults to the preset tone, else ok.',
              },
              durationMs: { type: 'number', description: 'How long the card stays up, in ms; 0 means stay until clicked. Clamped to 0–600000. Defaults to the configured popupTimeoutMs.' },
              sound: { type: 'boolean', description: 'Play the notification sound too. Defaults to the configured sound switch.' },
              jump: { type: 'boolean', description: 'Clicking the card returns to this conversation. On by default, so a test card behaves exactly like a real one; pass false to preview a card that cannot jump.' },
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          execute(args, exec) {
            const options = { ...(args ?? {}) }
            // A test card has to be clickable for the same reason a real one
            // is: the seam being tested is "the interruption brings me back".
            // The session id comes from the CALL, not from config — the tool can
            // run while several sessions are live, and a global "current" would
            // send the click to whichever conversation happened to be focused.
            // `exec.agent` is absent for scheduled runs, so the initiator is the
            // fallback rather than the other way round.
            const sessionId = options.jump === false || cfg.jump === false
              ? undefined
              : exec?.agent?.id ?? ctx.get?.('agents')?.currentInitiator?.()?.id
            delete options.jump
            // A test card should look like the card it is standing in for, and
            // the real cards are headed by the conversation's name. So when the
            // caller did not name a heading, borrow the session's — otherwise
            // the seam would preview a headline no real card ever shows, and
            // "does the card name the right conversation" would be the one
            // thing the tool could not answer.
            //
            // The session name beats the PRESET heading on purpose. A preset is
            // a canned sample for the painter's markup, and its heading
            // ("弹窗测试 · 完成") is a label for the sample, not a heading any
            // real card would ever print. Keeping it would make the one card
            // you fire to check delivery the one card that does not name its
            // conversation. An explicit `title` still wins, which keeps the
            // tool usable for previewing arbitrary text.
            //
            // The session is resolved independently of `jump`: a preview with
            // `jump: false` still belongs to this conversation, it just cannot
            // be clicked.
            if (options.title === undefined) {
              const named = resolveSessionName(exec?.agent?.id ?? ctx.get?.('agents')?.currentInitiator?.()?.id)
              if (named !== '') options.title = named
            }
            // The token table lives beside the route that consumes it, so it is
            // handed to popup() as a minter instead of imported there: that keeps
            // popup.js host-free and directly testable, and keeps the expiry rule
            // (`jumpTtlFor`) next to the code that prunes.
            const result = popup({
              ...cfg,
              mintJump: (wanted, timeoutMs) => offerJump(wanted, jumpTtlFor(timeoutMs)),
            }, sessionId === undefined ? options : { ...options, sessionId }, ctx.logger)
            write('popup', { ...result, tool: true })
            return JSON.stringify(result)
          },
          presentCall: (args) => ({
            card: 'generic',
            title: 'Fire an attention card',
            kind: 'other',
            rawInput: args,
          }),
        }), 'attention: quick-popup tool')
      } catch (error) {
        // A duplicate name in this profile, or a registry that rejects the
        // shape. Worth saying out loud: the seam silently missing is the same
        // symptom as the seam failing.
        ctx.logger?.warn?.(`attention: could not register the quick-popup tool: ${String(error)}`)
        return undefined
      }
    })
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
    if (type === 'user/message') {
      // Record the trigger so the turn's own ending can decide whether a card
      // is addressed to anybody. The source is what the client reads too.
      //
      // FIRST message of the turn wins. The plugin asks "who STARTED this
      // turn", and that is the message that opened it -- a human reply that
      // arrives mid-turn is a reader of the answer, not the starter. Letting
      // the last message overwrite the trigger announced a machine-started
      // turn whenever the human steered one in: the auto-continue case, where
      // the human is waiting for their own answer and is not watching a
      // machine finish.
      const kind = data?.source?.kind
      if (typeof kind === 'string' && kind !== '' && !triggerKinds.has(session.id)) {
        triggerKinds.set(session.id, kind)
      }
      return
    }
    if (type !== 'turn/end') return

    const summary = lastAssistant.get(session.id) ?? ''
    const trigger = triggerKinds.get(session.id)
    // strict: a turn/end chime is low-value. If the agent record is gone
    // (settled subagent / background job) or otherwise unresolvable, stay
    // silent rather than guess "root" and ring the human for delegated work.
    // excludeDelegated adds the roots-independent half: a subagent whose record
    // is STILL registered (not yet disposed) is a member of roots() and would
    // slip past the record checks, but its bare-uuid id gives it away.
    if (cfg.notifyOnTurnEnd && isRootAgent(session.id, { strict: true, excludeDelegated: true }) && worthRinging(data.reason)) {
      if (cfg.exemptExecutionTurns && isExecutionTrigger(trigger)) {
        // A machine started this turn, so a card about how it ended has no
        // reader. Counted once per session-trigger pair: the exemption is
        // supposed to be silent, but "it stayed quiet because a schedule
        // started it" and "it stayed quiet because it never fired" must stay
        // distinguishable in the trace.
        once(`exempt:execution-trigger:${session.id}:${trigger}`, 'suppressed:execution-trigger', {
          sessionId: session.id,
          trigger,
        })
      } else {
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
    }
    lastAssistant.delete(session.id)
    triggerKinds.delete(session.id)
    cancelPending(`question:${session.id}`)
    cancelPending(`approval:${session.id}`)
  })

  ctx.on('agent/disposed', (payload) => {
    reached('agent/disposed', payload)
    const agent = payload?.agent
    if (!agent) return
    lastAssistant.delete(agent.id)
    triggerKinds.delete(agent.id)
    cancelPending(`question:${agent.id}`)
    cancelPending(`approval:${agent.id}`)
  })

  ctx.effect(() => () => {
    for (const key of [...pending.keys()]) cancelPending(key)
  })
}
