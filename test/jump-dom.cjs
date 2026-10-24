/**
 * Verification harness for dsh-attention/client.js.
 *
 * The plugin's hard cases are all DOM-shape questions that cannot be answered
 * by reading the source: does a strip-less profile still resolve to `chat`, is
 * a fullscreen right pane mistaken for the conversation, does an embedded
 * subagent conversation win the `querySelector` race. So this builds a fake DOM
 * with exactly the nodes the shell renders, loads the real client.js in a vm,
 * runs `apply()`, feeds it a pending jump, and asserts on the steps it reports.
 *
 * No dependency on the live app, and nothing here ships with the plugin.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

// ---------------------------------------------------------------- fake DOM

function el(tagName, attrs = {}, opts = {}) {
  const node = {
    tagName: tagName.toUpperCase(),
    attrs: { ...attrs },
    children: [],
    parent: null,
    className: opts.className ?? '',
    textContent: opts.text ?? '',
    clickCount: 0,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    append(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    getBoundingClientRect() {
      const r = this.rect ?? { width: 0, height: 0, left: 0, top: 0 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height };
    },
    contains(other) {
      let cursor = other;
      while (cursor !== null && cursor !== undefined) {
        if (cursor === this) return true;
        cursor = cursor.parent;
      }
      return false;
    },
    closest(selector) {
      let cursor = this;
      while (cursor !== null && cursor !== undefined) {
        if (matches(cursor, selector)) return cursor;
        cursor = cursor.parent;
      }
      return null;
    },
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (matches(child, selector)) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    },
    querySelector(selector) {
      const all = this.querySelectorAll(selector);
      return all.length > 0 ? all[0] : null;
    },
    click() {
      this.clickCount += 1;
      if (this.getAttribute('role') === 'tab' && this.parent !== null) {
        for (const sibling of this.parent.children) {
          if (sibling.getAttribute('role') === 'tab') sibling.setAttribute('aria-selected', 'false');
        }
        this.setAttribute('aria-selected', 'true');
      }
    },
  };
  if (opts.rect !== undefined) node.rect = opts.rect;
  return node;
}

/** Selector support: `[a]`, `[a="v"]`, and bare tag names. Enough for this file. */
function matches(node, selector) {
  const attr = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(selector);
  if (attr !== null) {
    const [, name, value] = attr;
    if (!Object.prototype.hasOwnProperty.call(node.attrs, name)) return false;
    if (value === undefined) return true;
    return node.attrs[name] === value;
  }
  return node.tagName === selector.toUpperCase();
}

function rect(width, height, left = 0, top = 0) {
  return { width, height, left, top };
}

// ---------------------------------------------------------------- scenarios

function buildDom(kind) {
  const root = el('body');
  const frame = root.append(el('div', { 'data-frame': '' }, { className: 'frame' }));
  const centerCol = frame.append(el('div', {}, { className: 'centerCol' }));

  let pointTarget = null;
  let panelHost = null;

  if (kind !== 'blind') {
    // The main conversation always exists unless we are testing "not mounted".
    const scroll = centerCol.append(
      el('div', { 'data-conversation-scroll': '' }, { className: 'scroll', rect: rect(800, 600) }),
    );
    pointTarget = scroll;
    panelHost = scroll;
  }

  // A plugin page owning the main column sits ON TOP of the conversation.
  if (kind === 'clean-panel') {
    const panel = centerCol.append(el('div', { 'data-cordis-panel': '' }, { className: 'panelHost', rect: rect(800, 600) }));
    pointTarget = panel;
  }

  // Right column with an embedded conversation. It is deliberately LARGER than
  // the main one and FIRST in document order, so only the side-column exclusion
  // can keep it from being picked.
  if (kind === 'embedded-pane') {
    const right = frame.append(el('div', { 'data-sidebar-right-panel': 'fullscreen' }, { className: 'panel' }));
    right.append(el('div', { 'data-sidebar-right-open': '' }, { className: 'panelBody' }));
    const embedded = right.append(
      el('div', { 'data-conversation-scroll': '' }, { className: 'scroll', rect: rect(1200, 900) }),
    );
    pointTarget = embedded;
    // Move the right column ahead of the center column, as a fullscreen overlay
    // would be painted last but appear wherever the frame orders it.
    frame.children = [right, centerCol];
  }

  // View tab strip, only when a second view is registered.
  if (kind === 'tabs-context') {
    const strip = centerCol.append(el('div', { 'data-conversation-tabs': '' }, { className: 'tabs' }));
    strip.attrs.role = 'tablist';
    strip.append(el('button', { role: 'tab', 'aria-selected': 'false' }, { text: '对话' }));
    strip.append(el('button', { role: 'tab', 'aria-selected': 'true' }, { text: '上下文' }));
  }
  if (kind === 'tabs-chat-active') {
    const strip = centerCol.append(el('div', { 'data-conversation-tabs': '' }, { className: 'tabs' }));
    strip.attrs.role = 'tablist';
    strip.append(el('button', { role: 'tab', 'aria-selected': 'true' }, { text: '对话' }));
    strip.append(el('button', { role: 'tab', 'aria-selected': 'false' }, { text: '上下文' }));
  }

  if (kind === 'tabs-unknown-locale') {
    const strip = centerCol.append(el('div', { 'data-conversation-tabs': '' }, { className: 'tabs' }));
    strip.attrs.role = 'tablist';
    // chat is `order: 0` and every other view is 10+, so it sorts first — the
    // labels here are deliberately ones this file has never heard of.
    strip.append(el('button', { role: 'tab', 'aria-selected': 'false' }, { text: 'Unterhaltung' }));
    strip.append(el('button', { role: 'tab', 'aria-selected': 'true' }, { text: 'Kontext' }));
  }

  const document = {
    baseURI: 'http://dsh.test/app/',
    visibilityState: 'visible',
    body: root,
    querySelectorAll(selector) {
      return root.querySelectorAll(selector);
    },
    querySelector(selector) {
      return root.querySelector(selector);
    },
    elementFromPoint() {
      return pointTarget;
    },
  };

  return { document, root, pointTarget };
}

/** Run one scenario end to end and return the reported steps. */
async function run(kind, extraCtx = {}) {
  return runWith(kind, extraCtx, {});
}

/**
 * Same as run(), with a controllable session list so the `landed` verdict can
 * be tested for real: whether openSession actually moves the main view, and
 * whether an unmoving shell is reported as a failure instead of a success.
 */
async function runWith(kind, extraCtx = {}, sessionOpts = {}) {
  const { document } = buildDom(kind);
  const reports = [];
  const calls = [];
  let served = 0;

  const sandbox = {
    document,
    window: {},
    console,
    URL,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    fetch: async (url, opts) => {
      const target = String(url);
      if (target.includes('dsh-attention/ping')) {
        reports.push(JSON.parse(opts.body));
        return { status: 200, json: async () => ({}) };
      }
      served += 1;
      if (served === 1) return { status: 200, json: async () => ({ sessionId: 'sess-1', jumpId: 'jump-1' }) };
      return { status: 204, json: async () => ({}) };
    },
    // Time-scaled timers keep the ordering identical while making the suite fast.
    setTimeout: (fn, ms = 0) => setTimeout(fn, Math.max(0, Math.round(ms / 20))),
    clearTimeout: (id) => clearTimeout(id),
  };

  let module = null;
  sandbox.window.__ModuleLoader__ = {
    load(spec) {
      module = spec.factory(() => ({}));
    },
  };

  vm.runInNewContext(SRC, sandbox, { filename: 'client.js' });
  if (module === null) throw new Error('client.js did not register a module');

  // The session catalog, as the shell exposes it: `retainedBy.mainView > 0`
  // marks the row the main column is showing. `move` decides whether
  // openSession actually changes it — the difference between a jump that lands
  // and one that reports "ok" while the user's screen never moves.
  const start = sessionOpts.mainView ?? 'sess-0';
  let mainView = start;
  const rows = () => {
    const byId = {};
    for (const id of sessionOpts.known ?? [start, 'sess-1']) {
      byId[id] = { id, retainedBy: { mainView: id === mainView ? 1 : 0 } };
    }
    return byId;
  };

  const ctx = {
    uiWorkspace: {
      openSession(id) {
        calls.push(['openSession', id]);
        if (sessionOpts.move !== false) mainView = id;
      },
    },
    get(name) {
      if (name === 'sessions') {
        if (sessionOpts.noSessions === true) return undefined;
        return { list: { getSnapshot: () => ({ byId: rows() }) } };
      }
      if (name === 'layout') {
        return {
          panelInfo: { getSnapshot: () => ({ activePanelId: extraCtx.activePanelId ?? null }) },
          selectPanel(id) {
            calls.push(['selectPanel', id]);
          },
          closeRightbar() {
            calls.push(['closeRightbar']);
          },
        };
      }
      if (name === 'sidebarRight') {
        return {
          isExpanded: () => extraCtx.rightExpanded === true,
          toggleExpanded() {
            calls.push(['toggleExpanded']);
          },
          active: () => ({ id: 'subagent' }),
        };
      }
      return undefined;
    },
  };

  const dispose = module.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (typeof dispose === 'function') dispose();

  const steps = {};
  for (const report of reports) {
    const { event, ...rest } = report;
    steps[event] = rest;
  }
  return { steps, calls, reports };
}

// ---------------------------------------------------------------- assertions

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} — ${detail}`);
    console.log(`  FAIL  ${name}  (${detail})`);
  }
}

(async () => {
  // 1. A profile with no other plugins: no tab strip at all.
  console.log('\n[1] clean install (no view strip)');
  {
    const { steps, calls } = await run('clean');
    check('openSession ran', calls.some((c) => c[0] === 'openSession' && c[1] === 'sess-1'), JSON.stringify(calls));
    check('no strip is not an error', steps['step:selectView']?.detail === 'no-strip', JSON.stringify(steps['step:selectView']));
    check('final view is chat', steps['step:after']?.view === 'chat', JSON.stringify(steps['step:after']));
    check('strip reported false', steps['step:after']?.strip === false, JSON.stringify(steps['step:after']));
    check('nothing collapsed', !calls.some((c) => c[0] === 'toggleExpanded' || c[0] === 'closeRightbar'), JSON.stringify(calls));
  }

  // 2. Clean install, but a plugin page owns the main column.
  console.log('\n[2] clean install with a plugin page on the main column');
  {
    const { steps, calls } = await run('clean-panel', { activePanelId: 'plugin-page' });
    check('panel cleared', steps['step:clearPanel']?.detail === 'ok', JSON.stringify(steps['step:clearPanel']));
    check('selectPanel(null) called', calls.some((c) => c[0] === 'selectPanel' && c[1] === null), JSON.stringify(calls));
    check('still lands on chat', steps['step:after']?.view === 'chat', JSON.stringify(steps['step:after']));
  }

  // 3. The 上下文 tab case this whole feature exists for.
  console.log('\n[3] 上下文 selected in the view strip');
  {
    const { steps, calls } = await run('tabs-context');
    check('before view is 上下文', steps['step:before']?.view === '上下文', JSON.stringify(steps['step:before']));
    check('chat tab clicked', steps['step:selectView']?.detail === 'clicked', JSON.stringify(steps['step:selectView']));
    check('after view is chat', steps['step:after']?.view === 'chat', JSON.stringify(steps['step:after']));
    check('no retry needed', steps['step:selectViewRetry'] === undefined, JSON.stringify(steps['step:selectViewRetry']));
  }

  // 4. Chat already active: the click must be skipped, not repeated.
  console.log('\n[4] chat already active');
  {
    const { steps } = await run('tabs-chat-active');
    check('reported already', steps['step:selectView']?.detail === 'already', JSON.stringify(steps['step:selectView']));
    check('view stays chat', steps['step:after']?.view === 'chat', JSON.stringify(steps['step:after']));
  }

  // 5. Fullscreen right pane with an embedded conversation larger than the main
  //    one and earlier in document order — the querySelector race.
  console.log('\n[5] fullscreen right pane embedding a bigger conversation');
  {
    const { steps, calls } = await run('embedded-pane', { rightExpanded: true });
    check('picked the main conversation', steps['step:before']?.conversation === true, JSON.stringify(steps['step:before']));
    check('occluder names the side column', String(steps['step:before']?.occluder).includes('side-column'), JSON.stringify(steps['step:before']?.occluder));
    check('pane collapsed', calls.some((c) => c[0] === 'toggleExpanded'), JSON.stringify(calls));
  }

  // 6. Nothing measurable in front: must NOT collapse a pane the user opened.
  console.log('\n[6] no conversation mounted (unmeasurable)');
  {
    const { steps, calls } = await run('blind', { rightExpanded: true });
    check('occluder is a sentinel', steps['step:before']?.occluder === 'no-conversation', JSON.stringify(steps['step:before']?.occluder));
    check('pane left alone', !calls.some((c) => c[0] === 'toggleExpanded' || c[0] === 'closeRightbar'), JSON.stringify(calls));
    check('jump still ran', calls.some((c) => c[0] === 'openSession'), JSON.stringify(calls));
  }

  // 6b. A main-column plugin page must be closed by selectPanel, and must NOT
  //     drag the right column down with it.
  console.log('\n[6b] main-column page in front while a right pane is open');
  {
    const { steps, calls } = await run('clean-panel', { activePanelId: 'plugin-page', rightExpanded: true });
    check('occluder marked main', String(steps['step:before']?.occluder).includes('[main]'), JSON.stringify(steps['step:before']?.occluder));
    check('panel cleared', steps['step:clearPanel']?.detail === 'ok', JSON.stringify(steps['step:clearPanel']));
    check('right pane untouched', !calls.some((c) => c[0] === 'toggleExpanded' || c[0] === 'closeRightbar'), JSON.stringify(calls));
  }

  // 7. An unshipped locale: the label match cannot fire, so the structural
  //    fallback (chat is order 0, hence first) has to carry the jump.
  console.log('\n[7] unknown locale (label match impossible)');
  {
    const { steps } = await run('tabs-unknown-locale');
    check('before view is the foreign label', steps['step:before']?.view === 'Kontext', JSON.stringify(steps['step:before']));
    check('first tab clicked by structure', steps['step:selectView']?.detail === 'clicked', JSON.stringify(steps['step:selectView']));
    check('lands on chat by structure', steps['step:after']?.view === 'chat', JSON.stringify(steps['step:after']));
  }

  // 8. The verdict that was missing: openSession reporting "ok" proved only
  //    that the call did not throw. The session list is the only witness that
  //    the main column actually moved.
  console.log('\n[8] the jump actually lands');
  {
    const { steps } = await runWith('clean', {}, { move: true });
    check('reports landed', steps['step:landed']?.landed === true, JSON.stringify(steps['step:landed']));
    check('names the wanted session', steps['step:landed']?.wanted === 'sess-1', JSON.stringify(steps['step:landed']));
    check('names what it saw', steps['step:landed']?.seen === 'sess-1', JSON.stringify(steps['step:landed']));
    check('records where it came from', steps['step:landed']?.was === 'sess-0', JSON.stringify(steps['step:landed']));
  }

  // 9. The failure this exists to catch: every step says ok, the screen does
  //    not move. Reporting success there would hide the bug forever.
  console.log('\n[9] openSession runs but the session does not change');
  {
    const { steps, calls } = await runWith('clean', {}, { move: false });
    check('openSession still ran', calls.some((c) => c[0] === 'openSession'), JSON.stringify(calls));
    check('does NOT claim success', steps['step:landed']?.landed === false, JSON.stringify(steps['step:landed']));
    check('shows what is actually there', steps['step:landed']?.seen === 'sess-0', JSON.stringify(steps['step:landed']));
    check('still names the target', steps['step:landed']?.wanted === 'sess-1', JSON.stringify(steps['step:landed']));
  }

  // 10. Already on the target: a jump to where you are is a success, and must
  //     not be reported as a failure just because nothing changed.
  console.log('\n[10] already on the target session');
  {
    const { steps } = await runWith('clean', {}, { mainView: 'sess-1' });
    check('counts as landed', steps['step:landed']?.landed === true, JSON.stringify(steps['step:landed']));
    check('was and seen agree', steps['step:landed']?.was === steps['step:landed']?.seen, JSON.stringify(steps['step:landed']));
  }

  // 11. A shell with no readable session list. "Cannot say" must never be
  //     reported as "the jump failed" — the navigation may well have worked.
  console.log('\n[11] session list unreadable');
  {
    const { steps, calls } = await runWith('clean', {}, { noSessions: true });
    check('jump still attempted', calls.some((c) => c[0] === 'openSession'), JSON.stringify(calls));
    check('verdict is not a false failure', steps['step:landed']?.landed === false, JSON.stringify(steps['step:landed']));
    check('marked as unreadable', steps['step:landed']?.readable === false, JSON.stringify(steps['step:landed']));
  }

  console.log(`\n${failures.length === 0 ? 'ALL SCENARIOS PASS' : `${failures.length} FAILURE(S)`}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
})().catch((error) => {
  console.error('HARNESS ERROR', error);
  process.exitCode = 1;
});
