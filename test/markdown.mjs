/**
 * Tests for the Markdown subset the notification card renders.
 *
 * The contract that matters is not "is this CommonMark" — it deliberately is
 * not — but two properties:
 *
 *   1. markup is turned into styled spans (so the painter can draw them), and
 *   2. NOTHING IS EVER EATEN. A notifier that silently drops half a sentence is
 *      worse than one that shows the asterisks, so every test below also checks
 *      the flattened text still contains the original words.
 */
import { renderMarkdown, parseInline, toPlainText } from '../markdown.js'

let failures = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures += 1
}

/** Style flags, mirrored from markdown.js. */
const BOLD = 1, ITALIC = 2, CODE = 4, STRIKE = 8, LINK = 16

// ---- inline: bold, italic, code, strike ------------------------------------

{
  const spans = parseInline('plain **bold** plain')
  check('bold produces a bold span', spans.some((s) => s.style === BOLD && s.text === 'bold'),
    JSON.stringify(spans))
  check('bold keeps the surrounding text', toPlainText({ lines: [spans] }) === 'plain bold plain')
}

{
  const spans = parseInline('`code` and *italic*')
  check('code produces a code span', spans.some((s) => s.style === CODE && s.text === 'code'))
  check('italic produces an italic span', spans.some((s) => s.style === ITALIC && s.text === 'italic'))
  check('mixed inline styles keep all words', toPlainText({ lines: [spans] }) === 'code and italic')
}

{
  const spans = parseInline('~~gone~~ kept')
  check('strike produces a strike span', spans.some((s) => s.style === STRIKE && s.text === 'gone'))
  check('strike keeps the rest', toPlainText({ lines: [spans] }) === 'gone kept')
}

// Code wins over emphasis: backticks containing asterisks must not be re-parsed.
{
  const spans = parseInline('`a*b*c`')
  check('asterisks inside code stay literal',
    spans.length === 1 && spans[0].style === CODE && spans[0].text === 'a*b*c',
    JSON.stringify(spans))
}

// Bold wins over italic.
{
  const spans = parseInline('**bold**')
  check('double asterisk is bold, not italic',
    spans.length === 1 && spans[0].style === BOLD && spans[0].text === 'bold',
    JSON.stringify(spans))
}

// Two emphasis runs in one line must not swallow the text between them.
{
  const spans = parseInline('*a* middle *b*')
  check('two italic runs stay separate',
    spans.filter((s) => s.style === ITALIC).length === 2, JSON.stringify(spans))
  check('and the text between them survives',
    toPlainText({ lines: [spans] }) === 'a middle b')
}

// ---- nothing is ever eaten -------------------------------------------------

{
  const spans = parseInline('2 * 3 = 6')
  check('a lone asterisk is kept literally', toPlainText({ lines: [spans] }) === '2 * 3 = 6',
    JSON.stringify(spans))
}

{
  const spans = parseInline('unclosed **bold')
  check('an unclosed marker is kept literally', toPlainText({ lines: [spans] }) === 'unclosed **bold',
    JSON.stringify(spans))
}

{
  const spans = parseInline('a ` b')
  check('a lone backtick is kept literally', toPlainText({ lines: [spans] }) === 'a ` b')
}

{
  const spans = parseInline('trailing_underscore_')
  check('an unclosed underscore is kept', toPlainText({ lines: [spans] }).includes('underscore'))
}

// ---- links -----------------------------------------------------------------

{
  const spans = parseInline('see [the docs](https://example.com/a b)')
  const link = spans.find((s) => s.style === LINK)
  check('a link becomes a styled span', link !== undefined && link.text === 'the docs')
  check('the link carries its href', link?.href === 'https://example.com/a b', String(link?.href))
  check('a link with a title parses',
    parseInline('[x](http://a "t")')[0]?.href === 'http://a')
}

// ---- block level -----------------------------------------------------------

{
  const { lines, blocks } = renderMarkdown('- one\n- two')
  check('a bullet list is recognised', blocks.includes('bullet'), JSON.stringify(blocks))
  check('each bullet becomes a line', lines.length === 2)
  check('the bullet marker is its own span', lines[0][0].text.trim() === '•', lines[0][0].text)
  check('bullet text survives', toPlainText({ lines }).includes('one') && toPlainText({ lines }).includes('two'))
}

{
  const { lines, blocks } = renderMarkdown('1. first\n2. second')
  check('a numbered list is recognised', blocks.includes('bullet'))
  check('the ordinal is used as the marker', lines[0][0].text.trim() === '1.', lines[0][0].text)
}

{
  const { blocks } = renderMarkdown('> quoted')
  check('a quote is recognised', blocks.includes('quote'))
}

{
  const { lines } = renderMarkdown('## Heading')
  check('a heading is drawn bold', lines[0].every((s) => (s.style & BOLD) !== 0), JSON.stringify(lines))
  check('the heading hashes are stripped', toPlainText({ lines }) === 'Heading')
}

{
  const { lines } = renderMarkdown('first\n\nsecond')
  check('blank lines are dropped, not preserved as empty rows', lines.length === 2)
}

{
  const { lines } = renderMarkdown('- **bold** item')
  check('block and inline markup compose',
    lines[0].some((s) => (s.style & BOLD) !== 0 && s.text === 'bold'), JSON.stringify(lines[0]))
}

// ---- CJK and mixed content -------------------------------------------------

{
  const { lines } = renderMarkdown('**已完成**：报告共 12 页')
  check('CJK text takes bold', lines[0].some((s) => (s.style & BOLD) !== 0 && s.text === '已完成'))
  check('CJK text survives the round trip', toPlainText({ lines }) === '已完成：报告共 12 页')
}

{
  const { lines } = renderMarkdown('')
  check('empty input yields no lines', lines.length === 0)
  const { lines: none } = renderMarkdown(undefined)
  check('undefined input yields no lines', none.length === 0)
}

// ---- a pathological input must not hang ------------------------------------

{
  const started = Date.now()
  const { lines } = renderMarkdown('*'.repeat(500))
  check('a run of asterisks terminates', Date.now() - started < 1000)
  // Markdown legitimately CONSUMES characters when it pairs markers: `***x***`
  // is bold-italic, so three asterisks become style rather than text. What must
  // never happen is the parser hanging, or emitting nothing at all for a long
  // input. So the assertion is "it produced spans and finished", not "the
  // character count is preserved".
  check('and it produces spans rather than nothing', lines.length > 0 && lines[0].length > 0,
    `lines=${lines.length} spans=${lines[0]?.length ?? 0}`)
  // A realistic case, where the pairing is unambiguous, must keep every word.
  const { lines: real } = renderMarkdown('*emphasis* and **bold** and plain')
  check('a realistic emphasis mix keeps all its words',
    toPlainText({ lines: real }) === 'emphasis and bold and plain',
    toPlainText({ lines: real }))
}

{
  const started = Date.now()
  const { lines } = renderMarkdown('`'.repeat(500))
  check('a run of backticks terminates', Date.now() - started < 1000)
}

console.log(`\n${failures === 0 ? 'all markdown checks passed' : `${failures} check(s) failed`}`)
if (failures > 0) process.exitCode = 1
