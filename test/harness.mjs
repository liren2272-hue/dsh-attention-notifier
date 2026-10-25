/**
 * Minimal Cordis context stand-in: just enough of the contract that
 * `apply(ctx, config)` touches, so behaviour can be tested without a host.
 *
 * Waterfall listeners get a `next()` whose promise is settled by the test, so a
 * pending human answer can be modelled: the real answerer only resolves once the
 * human replies, and the notifier must keep nudging until then.
 */
export function createHarness({ agents = [], webServer = 'default', connection = null, tools = null, initiator = undefined, sessions = null } = {}) {
  const listeners = new Map()
  const timers = []
  const logs = { info: [], warn: [] }
  const sections = []
  const pendingNext = []
  const routes = []
  const registeredTools = []

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

  // Same shape for the tool registry: `register` must hand back a disposer that
  // actually unregisters, because the plugin registers inside `effect` and a
  // no-op disposer would hide a leak (a reload would double-register and the
  // real registry would reject the duplicate name).
  if (tools === 'default') {
    tools = {
      register(definition) {
        registeredTools.push(definition)
        return () => {
          const at = registeredTools.indexOf(definition)
          if (at >= 0) registeredTools.splice(at, 1)
        }
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
    // stays dormant in profiles without an HTTP carrier, and for tools so the
    // quick-popup seam is absent where there is no registry. Like cordis, the
    // callback runs only when every requested service is available; absent
    // services mean the plugin simply never mounts that seam.
    inject(names, callback) {
      if (typeof names === 'string') names = [names]
      const available = names.every((name) => {
        if (name === 'webServer') return webServer !== null
        if (name === 'tools') return tools !== null
        return false
      })
      if (!available) return () => {}
      const child = {
        effect: ctx.effect,
        get: ctx.get,
        on: ctx.on,
        inject: ctx.inject,
        timer: ctx.timer,
        logger: ctx.logger,
        webServer,
        tools,
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
          // The second source of "which conversation is this": the agent that
          // started the current turn. Modelled here because the plugin reads it
          // as a fallback when a tool runs without `exec.agent` on it.
          currentInitiator: () => initiator,
        }
      }
      if (name === 'systemPrompt') {
        return { section: (entry) => sections.push(entry) }
      }
      if (name === 'connection') return connection
      // The session store: the card reads each conversation's NAME off its
      // `session/title` log event. `sessions` is either a map of id -> event log
      // (the shape tests want to write) or an object with a `get` already (the
      // shape the host exposes), so both read the same way to the plugin.
      if (name === 'sessions') {
        if (sessions === null) return undefined
        if (typeof sessions.get === 'function') return sessions
        return { get: (id) => (Object.hasOwn(sessions, id) ? { id, log: sessions[id] } : undefined) }
      }
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
     * Tool definitions the plugin registered through the fake `tools` service.
     * Exposed as a live array so a test can assert both what is registered and
     * that the effect disposer takes it back out.
     */
    tools: registeredTools,
    /** Look up a registered tool by name; undefined when it was never mounted. */
    tool(name) {
      return registeredTools.find((definition) => definition.name === name)
    },
    /**
     * Run a registered tool and parse its JSON string result.
     *
     * `exec` defaults to a bare `{}` — the plugin must survive a call with no
     * agent on it (a scheduled run, a test harness), and that path is worth
     * being the default rather than the special case. Pass `{ agent: { id } }`
     * to exercise the branch that knows which conversation asked.
     */
    async runTool(name, args = {}, exec = {}) {
      const definition = registeredTools.find((entry) => entry.name === name)
      if (definition === undefined) throw new Error(`tool not registered: ${name}`)
      return JSON.parse(await definition.execute(args, exec))
    },
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
    async serve(method, path, options = {}) {
      const { body: requestBody = null } = options
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
      // A body pushes 'data' then 'end', matching what node's http gives the
      // route. The host reads the body on 'end', so a request that never emits
      // is not "an empty report" — it is a request that never arrives.
      const req = { url: path, method }
      if (requestBody !== null) {
        const chunks = [requestBody]
        req.on = (name, fn) => {
          if (name === 'data') setImmediate(() => { for (const chunk of chunks) fn(chunk) })
          if (name === 'end') setImmediate(() => { chunks.length = 0; fn() })
          return req
        }
      }
      await route.handler(req, res)
      if (requestBody !== null) await new Promise((resolve) => setImmediate(resolve))
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
