/**
 * Minimal Cordis context stand-in: just enough of the contract that
 * `apply(ctx, config)` touches, so behaviour can be tested without a host.
 *
 * Waterfall listeners get a `next()` whose promise is settled by the test, so a
 * pending human answer can be modelled: the real answerer only resolves once the
 * human replies, and the notifier must keep nudging until then.
 */
export function createHarness({ agents = [], webServer = 'default', connection = null } = {}) {
  const listeners = new Map()
  const timers = []
  const logs = { info: [], warn: [] }
  const sections = []
  const pendingNext = []
  const routes = []

  // A default fake carrier so the jump seam is exercised without a real HTTP
  // server; pass webServer: null to model a profile that has no carrier at all
  // (the plugin must stay dormant there).
  if (webServer === 'default') {
    webServer = {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
      getOrigin() {
        return 'http://dsh.test:9999'
      },
    }
  }

  const ctx = {
    on(name, fn) {
      const bucket = listeners.get(name) ?? []
      bucket.push(fn)
      listeners.set(name, bucket)
      return () => {
        const current = listeners.get(name) ?? []
        const at = current.indexOf(fn)
        if (at >= 0) current.splice(at, 1)
      }
    },
    effect(fn) {
      const disposer = fn()
      return () => disposer?.()
    },
    // Optional-service injection: the plugin uses this for webServer so it
    // stays dormant in profiles without an HTTP carrier. Like cordis, the
    // callback runs only when every requested service is available; absent
    // services mean the plugin simply never mounts that seam.
    inject(names, callback) {
      if (typeof names === 'string') names = [names]
      const available = names.every((name) => name === 'webServer' ? webServer !== null : false)
      if (!available) return () => {}
      const child = {
        effect: ctx.effect,
        get: ctx.get,
        on: ctx.on,
        inject: ctx.inject,
        timer: ctx.timer,
        logger: ctx.logger,
        webServer,
      }
      return callback(child)
    },
    timer: {
      // `label` is an optional tag so tests can tell two kinds of timer apart.
      // The plugin schedules both a per-question nudge and a stack-decay
      // watchdog through this one primitive, and they must be fireable
      // independently: firing "the first timer" is meaningless once two
      // different mechanisms share the pool. Filtering by delay was tried and
      // does not work — the two delays are both configurable and can cross.
      timeout(callback, delay, label) {
        if (typeof callback !== 'function') {
          return Promise.resolve()
        }
        const record = { callback, delay, label, cancelled: false, fired: false }
        timers.push(record)
        return () => {
          record.cancelled = true
        }
      },
      interval() {
        return () => {}
      },
    },
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    get(name) {
      if (name === 'agents') {
        return {
          get: (id) => agents.find((agent) => agent.id === id),
          roots: () => agents.filter((agent) => agent.root !== false),
        }
      }
      if (name === 'systemPrompt') {
        return { section: (entry) => sections.push(entry) }
      }
      if (name === 'connection') return connection
      return undefined
    },
  }

  return {
    ctx,
    logs,
    sections,
    timers,
    pendingNext,
    routes,
    /**
     * Drive the registered prefix route as the HTTP carrier would: match the
     * path, collect the response the handler writes, return {status, body}.
     *
     * The match rule is copied from @deepseek-ai/dsh-host-webserver:
     *
     *     pathname === prefix || pathname.startsWith(`${prefix}/`)
     *
     * and the longest prefix wins. An earlier version of this harness accepted
     * anything for which `pathname.startsWith(prefix)` held, which is laxer than
     * the host: it happily matched a route registered as "/dsh-attention/" —
     * with a trailing slash — that the real host could never reach, hiding a bug
     * that made every click land on 404. Do not loosen this back to startsWith.
     */
    async serve(method, path) {
      const pathname = new URL(path, 'http://dsh.test').pathname
      let route
      for (const candidate of routes) {
        const prefix = candidate.path
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
        if (route === undefined || prefix.length > route.path.length) route = candidate
      }
      if (route === undefined) return { status: 404, body: '' }
      let status = 0
      let body = ''
      const headers = {}
      const res = {
        writeHead(code, hs) {
          status = code
          Object.assign(headers, hs ?? {})
          return res
        },
        end(chunk) {
          if (typeof chunk === 'string') body += chunk
          return res
        },
      }
      const req = { url: path, method }
      await route.handler(req, res)
      return { status, body, headers }
    },
    emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args)
    },
    waterfall(name, ...args) {
      const fns = listeners.get(name) ?? []
      if (fns.length === 0) return Promise.resolve('delegated')
      let settle
      const downstream = new Promise((resolve, reject) => {
        settle = { resolve, reject }
      })
      pendingNext.push(settle)
      return fns[0](...args, () => downstream)
    },
    settleNext(value = 'delegated') {
      const settle = pendingNext.shift()
      settle?.resolve(value)
    },
    count(name) {
      return (listeners.get(name) ?? []).length
    },
    liveTimers() {
      return timers.filter((timer) => !timer.cancelled && !timer.fired)
    },
    /**
     * The live timers that are NOT the stack-decay watchdog.
     *
     * The stack decay (index.js armStackDecay) is a maintenance timer that
     * re-arms itself for as long as any card is on screen. It is armed by the
     * same notify() that fires a card, so it lands in the timer pool alongside
     * the per-question nudge timers — and a test that fires "the first timer"
     * would fire the watchdog instead of the nudge. Filtering by label is what
     * separates them; filtering by delay does not, because both delays are
     * configurable and can cross.
     *
     * Tests that assert "no timer survives the cap" use this too, because the
     * watchdog legitimately outlives a settled question — it is watching the
     * corner, not the question.
     */
    businessTimers() {
      return this.liveTimers().filter((timer) => timer.label !== 'stack-decay')
    },
    async fireTimer(index = 0) {
      const timer = this.businessTimers()[index]
      if (timer === undefined) throw new Error(`no live timer at ${index}`)
      timer.fired = true
      timer.callback()
      await Promise.resolve()
    },
  }
}

export function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
