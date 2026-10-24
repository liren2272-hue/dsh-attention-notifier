/**
 * A deliberately small Markdown renderer for the notification card.
 *
 * The card is a glance, not a document: 452px wide, three body lines, drawn by
 * hand in GDI+. So this is not a CommonMark implementation and must never become
 * one — it handles exactly the inline forms a notification actually carries, and
 * anything it does not understand is passed through as literal text rather than
 * guessed at. A notifier that mangles a message is worse than one that ignores
 * markup.
 *
 * Supported:
 *
 *   `code`            monospace, tinted chip behind it
 *   **bold**          heavier weight
 *   *italic* / _it_   slanted (skipped on CJK — see the note in spans())
 *   ~~strike~~        struck through
 *   [label](url)      label drawn, arrow glyph appended; the URL is carried in
 *                     the span so a future click-through has it, but a card
 *                     cannot navigate, so it is decoration only
 *   - item / * item   bulleted list, one per line
 *   1. item           numbered list
 *   > quote           indented, italic-ish, left rule
 *   # / ## / ###      heading: drawn as a bold line (there is no room for a
 *                     bigger type ramp in a three-line card)
 *
 * The output is a list of LINES, each a list of SPANS, each span carrying the
 * style flags that apply to it. That is the contract the painter needs: it can
 * measure and draw span by span, which is the only way mixed styles fit in a
 * fixed-width box.
 *
 * Everything runs on the host side (Node), not in the child PowerShell, because
 * the child has to stay pure ASCII and as small as possible — the script travels
 * through a file and is compiled on every ring.
 */

/** Styles a span can carry. */
const BOLD = 1
const ITALIC = 2
const CODE = 4
const STRIKE = 8
const LINK = 16

/**
 * Render Markdown to lines of styled spans.
 *
 * @param {string} text raw body text, possibly containing Markdown
 * @returns {{ lines: Array<Array<{text: string, style: number, href?: string}>>, blocks: string[] }}
 *   `lines` is the laid-out content; `blocks` names the block-level constructs
 *   found (bullet, quote, heading), which the painter uses to indent or prefix.
 */
export function renderMarkdown(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = []
  const blocks = []

  // Block-level prefixes are resolved first, per line, and stripped from the
  // text before inline parsing — otherwise `- **bold**` would be seen by the
  // inline parser as a list marker inside a bold span.
  const rawLines = source.split('\n')
  for (const raw of rawLines) {
    const trimmed = raw.trim()

    // Blank lines separate paragraphs. A blank line in a three-line card is
    // wasted space, so it is dropped rather than preserved.
    if (trimmed === '') continue

    let indent = 0
    let marker = ''
    let rest = trimmed

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed)
    const quote = /^>\s?(.*)$/.exec(trimmed)
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)

    if (bullet !== null) {
      rest = bullet[1]
      marker = '•'
      indent = 1
      blocks.push('bullet')
    } else if (ordered !== null) {
      rest = ordered[2]
      marker = `${ordered[1]}.`
      indent = 1
      blocks.push('bullet')
    } else if (quote !== null) {
      rest = quote[1]
      marker = '▌'
      indent = 2
      blocks.push('quote')
    } else if (heading !== null) {
      // A heading in a notification is a line the eye should land on first, so
      // it becomes bold. There is no room for a larger face.
      rest = heading[2]
      blocks.push('heading')
      lines.push(parseInline(rest).map((span) => ({ ...span, style: span.style | BOLD })))
      continue
    }

    const spans = parseInline(rest)
    if (marker !== '') {
      // The marker is drawn as its own span so it keeps the body style instead
      // of inheriting whatever the first inline span happens to be.
      spans.unshift({ text: `${marker} `, style: 0 })
    }
    lines.push(spans)
  }

  return { lines, blocks: [...new Set(blocks)] }
}

/**
 * Parse inline Markdown into styled spans.
 *
 * Ordering is load-bearing: `code` is matched before `bold`/`italic` so that a
 * backtick span containing asterisks is not re-interpreted as emphasis, and the
 * emphasis patterns are non-greedy so `*a* *b*` yields two spans rather than one
 * spanning the middle.
 *
 * @param {string} text one line of inline Markdown
 * @returns {Array<{text: string, style: number, href?: string}>}
 */
export function parseInline(text) {
  const spans = []
  let rest = String(text ?? '')
  // A guard against a pathological input making the loop spin: each iteration
  // must consume at least one character, and this bounds the total work.
  let guard = 0

  while (rest !== '' && guard < 500) {
    guard += 1
    const at = rest.slice(0, 1)

    // Inline code. Longest-first so ``` is not read as two empty `` spans.
    const code = /^(`{1,3})([\s\S]*?)\1/.exec(rest)
    if (code !== null) {
      spans.push({ text: code[2], style: CODE })
      rest = rest.slice(code[0].length)
      continue
    }

    // Link. The label is what gets drawn; the href is carried for a future
    // click-through. A card cannot navigate today, so the URL is decoration.
    //
    // The href may contain spaces — a URL with a CJK path or a query string does
    // — so the destination is read up to the closing paren rather than up to the
    // next whitespace. A quoted title is stripped if present, which is why the
    // href stops at ` "`: a greedy `[^)]*` would swallow the title into the URL
    // and the optional group would never match.
    const link = /^\[([^\]]*)\]\(([^)"]*)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link !== null) {
      spans.push({ text: link[1], style: LINK, href: link[2].trim() })
      rest = rest.slice(link[0].length)
      continue
    }

    // Bold. Matched before italic so `**x**` is bold, not italic-of-italic.
    const bold = /^\*\*([\s\S]+?)\*\*/.exec(rest)
    if (bold !== null) {
      spans.push({ text: bold[1], style: BOLD })
      rest = rest.slice(bold[0].length)
      continue
    }
    const boldU = /^__([\s\S]+?)__/.exec(rest)
    if (boldU !== null) {
      spans.push({ text: boldU[1], style: BOLD })
      rest = rest.slice(boldU[0].length)
      continue
    }

    // Strike.
    const strike = /^~~([\s\S]+?)~~/.exec(rest)
    if (strike !== null) {
      spans.push({ text: strike[1], style: STRIKE })
      rest = rest.slice(strike[0].length)
      continue
    }

    // Italic. A single leading marker only: `*x*` or `_x_`. An unmatched marker
    // is left in the text, because a notification saying "2 * 3" must not lose
    // its asterisk.
    const italic = /^\*([^*\n]+)\*/.exec(rest)
    if (italic !== null) {
      spans.push({ text: italic[1], style: ITALIC })
      rest = rest.slice(italic[0].length)
      continue
    }
    const italicU = /^_([^_\n]+)_/.exec(rest)
    if (italicU !== null) {
      spans.push({ text: italicU[1], style: ITALIC })
      rest = rest.slice(italicU[0].length)
      continue
    }

    // Plain text up to the next markup character. Accumulating it in one span is
    // what keeps a long unformatted sentence from becoming hundreds of spans.
    const plain = /^[^`*_~[\n]+/.exec(rest)
    if (plain !== null) {
      const last = spans[spans.length - 1]
      if (last !== undefined && last.style === 0) last.text += plain[0]
      else spans.push({ text: plain[0], style: 0 })
      rest = rest.slice(plain[0].length)
      continue
    }

    // A lone markup character with nothing to close it: emit it literally so the
    // message is never silently eaten.
    const last = spans[spans.length - 1]
    if (last !== undefined && last.style === 0) last.text += at
    else spans.push({ text: at, style: 0 })
    rest = rest.slice(1)
  }

  // An unclosed run at the guard limit is appended rather than dropped.
  if (rest !== '') {
    const last = spans[spans.length - 1]
    if (last !== undefined && last.style === 0) last.text += rest
    else spans.push({ text: rest, style: 0 })
  }
  return spans
}

/**
 * Flatten rendered lines back to plain text, for measuring and for the log.
 *
 * @param {{lines: Array<Array<{text: string}>>}} rendered
 * @returns {string}
 */
export function toPlainText(rendered) {
  return rendered.lines.map((spans) => spans.map((span) => span.text).join('')).join('\n')
}
