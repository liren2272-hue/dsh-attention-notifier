/**
 * Regression: a host upgrade changed `request.agent.id` from the navigable
 * conversation id (`session-<uuid>`) to the ROLE key `root`. The ask/approval
 * cards fed that role key to `workspace.openSession(id)`, so a click focused
 * the DSH window but never switched conversation ("只跳回了DSH").
 *
 * The authoritative conversation id now lives on `agent.session.id`. This test
 * fires a real question card through the host with agent.id='root' and
 * agent.session.id='session-abc', then drives the click -> /claim seam and
 * asserts the page is handed the NAVIGABLE id, not the role key.
 *
 * Usage: node test/jump-session-id.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createHarness } from './harness.mjs'
import { apply as applyHost } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { console.log('ok    -', name); return }
  failed += 1
  console.log('FAIL  -', name, detail === '' ? '' : `(${detail})`)
}

const fired = []
const host = createHarness({ agents: [{ id: 'root', root: true, session: { id: 'session-abc' } }] })
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

// The real upgraded shape: no `signal`, agent.id is the role key, with the
// conversation id one level down on agent.session.id.
host.waterfall('user-questions/request', {
  questions: [{ id: 'q', question: '选哪个？' }],
  agent: { id: 'root', session: { id: 'session-abc' } },
})

const urlMatch = /HttpWebRequest\]::Create\('([^']+)'\)/.exec(fired[0] ?? '')
check('card carries a jump url', urlMatch !== null)
if (urlMatch === null) { console.log(`\n${failed} failed`); process.exit(1) }
const token = new URL(urlMatch[1]).pathname.split('/').pop()

// Drive the click and the page's pending poll; the claim must name the
// navigable session, not the role key.
await host.serve('POST', `/dsh-attention/click/${token}`)
const pending = await host.serve('GET', '/dsh-attention/pending')
check('pending returns a claim', pending.status === 200, String(pending.status))
let body = {}
try { body = JSON.parse(pending.body) } catch {}
check('the claim names the navigable session id, not the role key',
  body.sessionId === 'session-abc', JSON.stringify(body))

console.log('')
if (failed > 0) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('REGRESSION: ask card jumps to agent.session.id, not the role key')
