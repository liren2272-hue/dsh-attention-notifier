/**
 * The quick-popup API: one call, one card.
 *
 * Every real trigger of this plugin is an event — a question, an approval, a
 * finished turn — so exercising delivery means staging one of those and then
 * waiting for the host to reach the listener. That loop is slow, it needs a
 * live session, and it only ever covers whichever path happens to be reachable
 * from the chat you are sitting in. So this module fires a single card on
 * demand, through the SAME delivery code (`ring` in notify.js) that the real
 * triggers use: if the card paints here, the channel works; if it does not, the
 * trigger was never the problem.
 *
 * Two callers, both load-bearing:
 *   - the `attention_popup` tool registered in index.js, so the model can fire
 *     one mid-conversation while working on the plugin;
 *   - `import { popup } from './popup.js'` from a plain script, which needs no
 *     host at all — that is what test/popup-live.mjs does.
 */
import { ACCENTS, ring } from './notify.js'

/** Tones a caller may name. Anything else falls back to 'ok' rather than throwing. */
export const POPUP_TONES = Object.keys(ACCENTS)

/** Same lifetime bounds as index.js BOUNDS.popupTimeoutMs. */
const TIMEOUT_BOUNDS = [0, 600_000]

/**
 * Canned samples, so "does it still look right" costs one word instead of a
 * paragraph of test copy.
 *
 * Each preset deliberately carries Markdown — bold, inline code, a link, a
 * bullet list — because every one of those is its own branch in the painter
 * (notify.js). A preset written as plain prose would let a markup regression
 * ship unnoticed, which is exactly the class of bug a smoke test exists for.
 */
export const POPUP_PRESETS = {
  ok: {
    title: '弹窗测试 · 完成',
    body: '**任务结束**：报告已生成，共 `12` 页。\n- 目录已更新\n- 图表已重绘\n详情见 [报告](http://127.0.0.1/) 。',
    tone: 'ok',
  },
  ask: {
    title: '弹窗测试 · 待你决定',
    body: '需要你选择：**覆盖** 现有配置，还是 **另存为** 一份新配置？',
    tone: 'ask',
  },
  alert: {
    title: '弹窗测试 · 出错',
    body: '命令以 `exit code 1` 结束：**磁盘空间不足**，写入已中止。',
    tone: 'alert',
  },
}

function normalizeTone(value) {
  return typeof value === 'string' && POPUP_TONES.includes(value) ? value : 'ok'
}

/** Coerce a caller's field to non-empty text, or fall through to `fallback`. */
function asText(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function clampTimeout(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(TIMEOUT_BOUNDS[1], Math.max(TIMEOUT_BOUNDS[0], Math.floor(number)))
}

/**
 * Merge one request over the plugin config into the exact values a card is
 * built from. Exported on its own because the resolution rules — which field a
 * preset may fill, what a nonsense duration becomes — are worth asserting
 * without spawning anything.
 */
export function resolvePopup(cfg = {}, options = {}) {
  const preset = typeof options.preset === 'string' ? POPUP_PRESETS[options.preset] : undefined
  return {
    title: asText(options.title, preset?.title ?? asText(cfg.title, 'DeepSeek Harness')),
    body: asText(options.body, preset?.body ?? ''),
    tone: normalizeTone(options.tone ?? preset?.tone),
    timeoutMs: clampTimeout(options.durationMs ?? options.timeoutMs, clampTimeout(cfg.popupTimeoutMs, 10_000)),
    sound: options.sound === undefined ? cfg.sound !== false : Boolean(options.sound),
    // Reported, not decided: whether this card can jump is the caller's fact
    // (it owns the session id), and the result has to say so or a card that
    // cannot jump is indistinguishable from one whose jump is broken.
    jump: typeof options.jumpUrl === 'string' && options.jumpUrl !== '',
  }
}

/**
 * Turn a session id into the URL a card's click posts to.
 *
 * `mint` is injected rather than imported because the token table lives in
 * index.js beside the route that consumes it — and because a plain script
 * (test/popup-live.mjs) has no host at all and therefore nothing to mint
 * against. Returns undefined when there is nothing to mint with, which the
 * caller reports as "this card cannot jump" instead of silently dropping it.
 *
 * The lifetime argument is the card's own: a token has to outlive the card that
 * carries it, or a click near the end of a long-lived card finds an expired
 * token and the jump looks broken when it was only late.
 */
function mintJumpUrl(cfg, options, timeoutMs) {
  const direct = typeof options.jumpUrl === 'string' && options.jumpUrl !== ''
  if (direct) return options.jumpUrl
  if (options.jump === false) return undefined
  const sessionId = options.sessionId
  if (sessionId === undefined || sessionId === null || sessionId === '') return undefined
  if (typeof cfg.mintJump !== 'function') return undefined
  try {
    const url = cfg.mintJump(sessionId, timeoutMs)
    return typeof url === 'string' && url !== '' ? url : undefined
  } catch {
    // A token table that refuses is the host's problem to report, not a reason
    // to lose the card: delivery is the point, the jump is the courtesy.
    return undefined
  }
}

/**
 * Fire one card now and report what was actually attempted.
 *
 * Deliberate deviations from the config, each because this is a *test* seam:
 *
 *   - `popup` is forced on. The point of the call is a card; a profile that
 *     turned popups off would otherwise make the API silently do nothing, which
 *     is indistinguishable from a broken channel.
 *   - `popupMs` is zeroed. In the real triggers it is a FLOOR that protects a
 *     hand-edited tiny timeout from flashing the card past the human — but here
 *     the caller named a duration explicitly, and honouring 9000 when 3000 was
 *     asked for makes the one knob this API exists to expose a lie. (notify.js
 *     still applies its own 1000ms hard floor.)
 *   - `balloon` and `box` are forced off. The balloon paints nothing under Focus
 *     Assist (so it would "succeed" without showing anything) and the box is a
 *     modal dialog that would strand the session it was fired from.
 *   - no stack ordinal is taken from the host counter unless the caller passes
 *     one. Testing must not push the real cards on screen up and to the left.
 *   - the min-interval gate is not consulted: a burst of test cards is the
 *     caller's business, and a suppressed card looks like a failure.
 */
export function popup(cfg = {}, options = {}, logger) {
  const request = resolvePopup(cfg, options)
  const jumpUrl = mintJumpUrl(cfg, options, request.timeoutMs)
  const effective = {
    ...cfg,
    popup: true,
    popupMs: 0,
    balloon: false,
    box: false,
    sound: request.sound,
    popupTimeoutMs: request.timeoutMs,
    stackIndex: options.stackIndex,
    jumpUrl,
  }
  try {
    return {
      ...request,
      jump: jumpUrl !== undefined,
      ok: ring(effective, request.title, request.body, logger, request.tone),
    }
  } catch (error) {
    // Delivery already contains its own failures, so reaching this is a bug in
    // the seam itself. Report it as data, not as a throw: the tool surface and
    // the CLI both want a result they can print.
    logger?.warn?.(`attention: quick popup failed: ${String(error)}`)
    return { ...request, jump: jumpUrl !== undefined, ok: false, error: String(error) }
  }
}
