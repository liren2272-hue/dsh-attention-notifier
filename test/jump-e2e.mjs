/**
 * End-to-end test for "click the popup -> return to the conversation".
 *
 * The host half and the page half are each covered elsewhere, but the SEAM
 * between them was not: nothing loaded the real client.js, so a wrong route
 * path could ship while every unit test still passed (it did — the route was
 * registered as "/dsh-attention/" with a trailing slash, which the real host
 * matcher can never reach, so every click 404'd).
 *
 * This drives the whole chain through the real modules:
 *
 *   card click -> POST /click/<token> -> GET /pending -> uiWorkspace.openSession
 *
 * Usage: node test/jump-e2e.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHarness } from './harness.mjs'
import { apply as applyHost } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

let failed = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log('ok    -', name)
    return
  }
  failed += 1
  console.log('FAIL  -', name, detail === '' ? '' : `(${detail})`)
}

// ---- 1. host half: fire a question, which mints a jump token ----------------
const fired = []
const host = createHarness({ agents: [{ id: 'root', root: true }] })
applyHost(host.ctx, {
  spawn: (_file, args) => {
    fired.push(Buffer.from(args.at(-1), 'base64').toString('utf16le'))
    return { on() {}, unref() {} }
  },
})
host.waterfall('user-questions/request', {
  questions: [{ id: 'q', question: '选哪个？' }],
  agent: { id: 'root' },
})

const urlMatch = /HttpWebRequest\]::Create\('([^']+)'\)/.exec(fired[0] ?? '')
check('the fired card carries a clickable jump url', urlMatch !== null)
if (urlMatch === null) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}

const clickUrl = new URL(urlMatch[1])
const token = clickUrl.pathname.split('/').pop()
check('the jump url is the host click route', /^\/dsh-attention\/click\/[0-9a-f-]{36}$/.test(clickUrl.pathname), clickUrl.pathname)

// ---- 2. the click arrives (what the card's PowerShell POSTs) ---------------
const click = await host.serve('POST', clickUrl.pathname)
check('the host accepts the click', click.status === 204, String(click.status))

// ---- 3. the page half: load the REAL client.js -----------------------------
let module
globalThis.window = { __ModuleLoader__: { load: (m) => { module = m } } }
globalThis.document = { baseURI: 'http://127.0.0.1:24227/' }
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname
  const result = await host.serve('GET', path)
  return {
    status: result.status,
    ok: result.status >= 200 && result.status < 300,
    json: async () => JSON.parse(result.body),
  }
}
// Deterministic single-step timers: capture the scheduled poll instead of waiting.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let pending = null
globalThis.setTimeout = (fn) => { pending = fn; return 1 }
globalThis.clearTimeout = () => {}

const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
new Function(source)()
check('client.js registers its module', module !== undefined)
check('the module id matches the package', module?.id === '@liren2272/dsh-attention', String(module?.id))

const client = module.factory(() => { throw new Error('client.js must not require anything') })
check('the client half injects uiWorkspace', JSON.stringify(client.inject) === JSON.stringify(['uiWorkspace']), JSON.stringify(client.inject))

const opened = []
const dispose = client.apply({ uiWorkspace: { openSession: (id) => opened.push(id) } })

const pump = async (times) => {
  for (let i = 0; i < times && pending !== null; i += 1) {
    const next = pending
    pending = null
    await next()
  }
}
await pump(6)
check('the page opens the session the click named', JSON.stringify(opened) === JSON.stringify(['root']), JSON.stringify(opened))

await pump(3)
check('the jump is one-shot and does not repeat', JSON.stringify(opened) === JSON.stringify(['root']), JSON.stringify(opened))

// A click for a token that was already spent must not navigate again.
const replay = await host.serve('POST', clickUrl.pathname)
check('a replayed token is accepted but harmless', replay.status === 204)
await pump(3)
check('a replayed token queues no jump', JSON.stringify(opened) === JSON.stringify(['root']), JSON.stringify(opened))

dispose?.()
globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout

console.log('')
if (failed > 0) {
  console.log(`${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('END-TO-END: clicking the popup returns to the named conversation')
}
