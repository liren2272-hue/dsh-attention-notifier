/**
 * Regression: a cookie-less card cannot POST /click through the host's
 * route-level auth. It instead drops a marker file; the authenticated /pending
 * handler consumes it and hands the session to the page. This drives that seam.
 *
 *   card click -> marker file -> GET /pending -> uiWorkspace.openSession
 *
 * Usage: node test/jump-marker-e2e.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHarness } from './harness.mjs'
import { apply as applyHost, DEFAULT_CLICK_MARKERS } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { console.log('ok    -', name); return }
  failed += 1; console.log('FAIL  -', name, detail === '' ? '' : `(${detail})`)
}

// clean any stale markers
try { if (existsSync(DEFAULT_CLICK_MARKERS)) for (const f of readdirSync(DEFAULT_CLICK_MARKERS)) unlinkSync(join(DEFAULT_CLICK_MARKERS, f)) } catch {}

// ---- 1. fire a question, which mints a jump token ---------------------------
const fired = []
const host = createHarness({ agents: [{ id: 'root', root: true }] })
applyHost(host.ctx, {
  spawn: (_file, args) => {
    const at = args.indexOf('-File')
    const scriptFile = at === -1 ? undefined : args[at + 1]
    if (scriptFile !== undefined) {
      try { fired.push(readFileSync(scriptFile, 'utf8').replace(/^\ufeff/, '')) } catch { fired.push('') }
    }
    return { on() {}, unref() {} }
  },
})
host.waterfall('user-questions/request', {
  questions: [{ id: 'q', question: '选哪个？' }],
  agent: { id: 'root' },
})

const urlMatch = /HttpWebRequest\]::Create\('([^']+)'\)/.exec(fired[0] ?? '')
check('fire card carries a jump url', urlMatch !== null)
if (urlMatch === null) { console.log(`\n${failed} failed`); process.exit(1) }
const clickUrl = new URL(urlMatch[1])
const token = clickUrl.pathname.split('/').pop()
check('the card also writes a marker file on click', (fired[0] ?? '').includes('.marker'))

// ---- 2. simulate the click: the PowerShell writes a marker ------------------
mkdirSync(DEFAULT_CLICK_MARKERS, { recursive: true })
const markerPath = join(DEFAULT_CLICK_MARKERS, `${token}.marker`)
writeFileSync(markerPath, token, 'utf8')
check('marker file exists before pending', existsSync(markerPath))

// ---- 3. page polls /pending (authenticated) --------------------------------
const pending = await host.serve('GET', '/dsh-attention/pending')
check('pending returns the claim', pending.status === 200, String(pending.status))
const body = JSON.parse(pending.body || '{}')
check('pending names the interrupted session', body.sessionId === 'root', JSON.stringify(body))
check('pending names the click token', body.jumpId === token, JSON.stringify(body))
check('marker was consumed (deleted)', !existsSync(markerPath))

// The claim is broadcast to every asking page within its TTL; the client half
// dedupes on jumpId (covered by jump-e2e.mjs). Here we assert the same jumpId
// keeps being served, which is the documented hand-out contract.
const pending2 = await host.serve('GET', '/dsh-attention/pending')
check('the claim is broadcast within its TTL', pending2.status === 200 && JSON.parse(pending2.body||'{}').jumpId === token)

// ---- 4. replayed marker with unknown token is consumed without a new claim --
writeFileSync(join(DEFAULT_CLICK_MARKERS, 'not-a-token.marker'), 'not-a-token', 'utf8')
const bogusPath = join(DEFAULT_CLICK_MARKERS, 'not-a-token.marker')
const pending3 = await host.serve('GET', '/dsh-attention/pending')
check('a bogus marker is cleaned up', !existsSync(bogusPath))
check('a bogus marker does not change the claim', JSON.parse(pending3.body||'{}').jumpId === token)

console.log('')
if (failed > 0) { console.log(`${failed} check(s) failed`); process.exit(1) }
console.log('all marker-jump checks passed')