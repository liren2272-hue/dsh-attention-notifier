window.__ModuleLoader__.load({
  id: '@local/dsh-attention',
  factory(require) {
    'use strict';
    // No React: this half renders nothing. It exists so a desktop card click
    // can land the page on the session that interrupted you, and raising a
    // window is only half of that — the window comes back showing whatever
    // session was last open.
    //
    // Landing on the session is not the same as landing on the CONVERSATION
    // either. Three different things can be in front of it:
    //
    //   1. a plugin page owning the main column  (layout.selectPanel)
    //   2. an expanded right pane covering it    (sidebarRight)
    //   3. another VIEW TAB inside the very same conversation shell
    //
    // Case 3 is the one that cost the most attempts, because it defeats every
    // visibility test: 上下文 is registered on the `conversation.view` slot, so
    // it replaces the chat view *inside the resident scrollport* — the
    // `[data-conversation-scroll]` node keeps its size and stays on screen
    // while showing someone else's panel. Only the tab strip tells the truth,
    // which is why the cure is to press the chat tab, not to hide anything.
    //
    // NONE of that may be assumed to exist. A profile with no extra plugins
    // registers a single view (`chat`), and the shell renders the strip only
    // when `tabs.length > 1` — so the everyday, plugin-free install has no
    // `[data-conversation-tabs]` node at all. Everything here therefore has to
    // read "no strip" as "there is nothing to switch away from", not as
    // "the conversation is missing", and it has to survive a shell that names
    // the chat view in a language this file has never seen.

    // Must match package.json. This string is the only way to tell WHICH build
    // a page is running: the trace's `v` field is the answer to "did my change
    // reach the browser", and a stale number here turns that answer into a lie
    // (the page reloads, the field still reads the old version, and the honest
    // conclusion — "the shell is serving a cached bundle" — never gets reached).
    const VERSION = '1.6.1';

    /**
     * Resolve one host route against the page's own directory.
     *
     * A leading slash would pin the request to the origin root and escape a
     * reverse-proxy prefix; the desktop shell forwards same-origin page paths
     * (dsh-app://app/...) to the Host, so relative resolution is the one form
     * that works in both the browser and the Electron window.
     */
    function routeUrl(path) {
      const base = typeof document !== 'undefined' ? document.baseURI : '';
      try {
        const url = new URL(base || 'http://dsh.internal/');
        url.search = '';
        url.hash = '';
        if (!url.pathname.endsWith('/')) url.pathname += '/';
        return new URL(path.replace(/^\/+/, ''), url.href).href;
      } catch {
        return null;
      }
    }

    /** DOM anchor the conversation view owns; a panel page replaces it. */
    const CONVERSATION_SELECTOR = '[data-conversation-scroll]';
    /** The view tab strip the conversation shell renders above that scrollport. */
    const TABSTRIP_SELECTOR = '[data-conversation-tabs]';
    /**
     * The right column's own container. A subagent panel embeds a SECOND
     * conversation (`variant: "embedded"`), which brings its own scrollport and
     * could bring its own tab strip — neither of which is the conversation the
     * user is trying to get back to. Anything inside this container is not it.
     */
    const SIDE_COLUMN_SELECTOR = '[data-sidebar-right-panel]';
    /**
     * Labels of the built-in chat view (`conversation.view` id `chat`, order 0).
     *
     * The id is not in the DOM — the shell renders only the resolved label — so
     * the text is the only handle a label match has. Both shipped locales are
     * listed; the structural fallback below is what covers the rest.
     */
    const CHAT_LABELS = ['对话', '對話', 'Chat'];

    /** Is this node somewhere inside the right column? */
    function inSideColumn(node) {
      try {
        return node.closest?.(SIDE_COLUMN_SELECTOR) != null;
      } catch {
        return false;
      }
    }

    /**
     * The MAIN conversation scrollport — not one embedded in a side panel.
     *
     * A subagent panel renders its own `[data-conversation-scroll]` inside the
     * right column, and it can be on screen at the same time as the real one.
     * `querySelector` would return whichever came first in document order, so
     * the visibility test could end up measuring a pane instead of the page.
     * The main column is simply the largest such node; excluding the right
     * column first keeps that true even when a pane is stretched full-screen.
     */
    function conversationNode() {
      try {
        const all = [...document.querySelectorAll(CONVERSATION_SELECTOR)];
        if (all.length === 0) return null;
        const main = all.filter((node) => !inSideColumn(node));
        const pool = main.length > 0 ? main : all;
        if (pool.length === 1) return pool[0];
        let best = null;
        let bestArea = -1;
        for (const node of pool) {
          const rect = node.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area > bestArea) {
            bestArea = area;
            best = node;
          }
        }
        return best;
      } catch {
        return null;
      }
    }

    /** Every view tab the shell currently offers, in DOM order. */
    function viewTabs() {
      try {
        const strips = [...document.querySelectorAll(TABSTRIP_SELECTOR)].filter((strip) => !inSideColumn(strip));
        const strip = strips[0];
        if (strip === undefined) return [];
        return [...strip.querySelectorAll('[role="tab"]')];
      } catch {
        return [];
      }
    }

    /**
     * The tab that means "the conversation itself".
     *
     * A label match is the precise answer, but it only exists in a language
     * this file knows. The structural answer needs no language at all: the chat
     * view is registered with `order: 0` and every shipped view is 10 or
     * higher, while the shell sorts the strip by `order ?? 0` — so chat is the
     * FIRST tab, in every locale, always. The fallback therefore costs nothing
     * and cannot fire when a label already matched.
     */
    function chatTab(tabs) {
      const byLabel = tabs.find((tab) => CHAT_LABELS.includes((tab.textContent ?? '').trim()));
      if (byLabel !== undefined) return byLabel;
      return tabs[0];
    }

    /**
     * Which view is showing: `chat`, some other plugin view's label, or null
     * when nothing can be said.
     *
     * A single registered view means no strip (`showTabs = tabs.length > 1`), and
     * that IS the conversation — a plugin-free profile registers only `chat`,
     * so nothing can be selected away from it. Reporting `chat` there rather
     * than "unknown" is what makes the plugin work on a bare install: the jump
     * simply has no view to switch, and says so instead of thrashing.
     */
    function activeView() {
      const tabs = viewTabs();
      if (tabs.length === 0) return conversationVisible() ? 'chat' : null;
      const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
      if (selected === undefined) return null;
      if (selected === chatTab(tabs)) return 'chat';
      const text = (selected.textContent ?? '').trim();
      return text === '' ? null : text;
    }

    /**
     * Is a conversation painted at all — before asking WHICH view it shows.
     *
     * A right-column pane in this shell is an overlay layer (`position: fixed;
     * inset: 0; z-index: 25`) rather than a replacement, so the conversation
     * node keeps a non-zero rect while being completely covered. Hit-testing the
     * centre point is therefore the only honest answer to "is it in front".
     */
    function conversationVisible() {
      try {
        const node = conversationNode();
        if (node === null) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      } catch {
        return false;
      }
    }

    /**
     * Who is painted at the middle of the conversation, or null when it is.
     *
     * The `[side-column]` / `[main]` marker is what the caller acts on, and it
     * is the only distinction that changes the cure: a right-column pane is
     * collapsed, anything in the main column is a `selectPanel(null)`.
     */
    function occluder() {
      try {
        const node = conversationNode();
        if (node === null) return 'no-conversation';
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return 'zero-size';
        const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (at === null) return 'offscreen';
        if (node.contains(at)) return null;
        const tag = (at.tagName ?? '?').toLowerCase();
        const marker = at.closest?.(SIDE_COLUMN_SELECTOR) != null ? 'side-column' : 'main';
        const cls = typeof at.className === 'string' && at.className !== '' ? `.${at.className.split(/\s+/)[0]}` : '';
        return `${tag}${cls}[${marker}]`;
      } catch {
        return 'threw';
      }
    }

    /**
     * Everything one probe can say about why the conversation is not in front.
     *
     * Field names follow the host's own vocabulary (`activePanelId`, `view`) so
     * a log line can be read against the shell source without translation.
     */
    function probe(ctx) {
      const layout = ctx.get?.('layout');
      const tabs = viewTabs();
      const facts = {
        v: VERSION,
        view: activeView(),
        // `tabs: []` is not an error: the strip renders only when more than one
        // view is registered, so an empty list is what a clean install looks
        // like. Logged as `strip: false` to make that readable at a glance.
        strip: tabs.length > 0,
        tabs: tabs.map((tab) => (tab.textContent ?? '').trim()),
        conversation: conversationVisible(),
        occluder: occluder(),
        // Reported because the claim is broadcast: "this page was in the
        // background when the click landed" is now a fact worth logging.
        visible: (() => {
          try {
            return document.visibilityState;
          } catch {
            return 'unknown';
          }
        })(),
        activePanelId: null,
      };
      try {
        const active = layout?.panelInfo?.getSnapshot?.().activePanelId;
        facts.activePanelId = typeof active === 'string' ? active : null;
      } catch {
        facts.activePanelId = 'threw';
      }
      // The right column. `expanded` is what actually costs the user the
      // conversation: a docked column still shows it, an expanded one owns the
      // screen. `tab` names the pane that is showing.
      try {
        const right = ctx.get?.('sidebarRight');
        if (right === undefined || right === null) {
          facts.right = String(right);
        } else {
          facts.right = 'object';
          if (typeof right.isExpanded === 'function') facts.rightExpanded = right.isExpanded() === true;
          if (typeof right.active === 'function') {
            const tab = right.active();
            facts.rightTab = typeof tab?.id === 'string' ? tab.id : null;
          }
        }
      } catch (error) {
        facts.right = String(error).slice(0, 60);
      }
      return facts;
    }

    /**
     * Which session the main view is showing, or null when that cannot be read.
     *
     * The host's own plugins answer this the same way (`session-archive`,
     * `task-board`): ownership counts ride the session list snapshot, so the
     * row with `retainedBy.mainView > 0` IS what the main column shows. It is
     * read defensively — an older shell may not carry `retainedBy` at all, and
     * "cannot say" must never be mistaken for "the wrong session".
     */
    function mainViewSession(ctx) {
      try {
        const byId = ctx?.get?.('sessions')?.list?.getSnapshot?.()?.byId;
        if (byId === undefined || byId === null) return null;
        for (const row of Object.values(byId)) {
          if (row !== undefined && row !== null && (row.retainedBy?.mainView ?? 0) > 0) return row.id ?? null;
        }
        return null;
      } catch {
        return null;
      }
    }

    /**
     * Press the chat view tab.
     *
     * The strip is the shell's own control, so a click is the same code path the
     * user takes and needs no service at all. It is skipped when no strip is
     * rendered — a single-view profile (`tabs.length > 1` gates the strip) has
     * nothing to switch away from, and that is a NORMAL install, not a failure:
     * the caller reports `no-strip` and stops.
     */
    function selectChatView() {
      const tabs = viewTabs();
      if (tabs.length === 0) return 'no-strip';
      const chat = chatTab(tabs);
      if (chat === undefined) return 'no-chat-tab';
      if (chat.getAttribute('aria-selected') === 'true') return 'already';
      try {
        chat.click();
        return 'clicked';
      } catch (error) {
        return `threw:${String(error).slice(0, 60)}`;
      }
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    return {
      inject: ['uiWorkspace'],
      // The layout is looked up with ctx.get(), never declared in inject: not
      // every shell that has uiWorkspace also has a panel-capable layout (the
      // mobile shell, for one), and a missing service in `inject` would hold
      // this whole half — jump included — until the loader gave up.
      apply(ctx) {
        const workspace = ctx.uiWorkspace ?? ctx.get?.('uiWorkspace');
        if (workspace === undefined || typeof workspace.openSession !== 'function') return;

        const pendingUrl = routeUrl('dsh-attention/pending');
        if (pendingUrl === null) return;
        const pingUrl = routeUrl('dsh-attention/ping');

        /**
         * Diagnostics, on the same channel as the jump itself.
         *
         * A notifier's failure is invisible: a card click that lands nowhere
         * looks exactly like a click that was never processed. So the client
         * reports what it saw and what it did, and the host appends those lines
         * to the trace file next to the ring that started it.
         */
        function report(event, detail) {
          if (pingUrl === null) return;
          // Spreading a bare string into an object explodes it into one key per
          // character (`{"0":"a","1":"l",...}`), which is how a step that
          // reported "already" once landed in the trace as gibberish. Wrap
          // anything that is not a plain object under a single key instead.
          const plain = detail !== null && typeof detail === 'object' && !Array.isArray(detail);
          try {
            fetch(pingUrl, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(plain ? { event, ...detail } : { event, detail }),
            }).catch(() => {});
          } catch {
            /* never break the jump for a log line */
          }
        }

        /** One-shot: prove which build of this half the page actually loaded. */
        report('hello', { v: VERSION });

        /**
         * Land on `sessionId` with the chat view in front.
         *
         * Order matters: clear the big obstructions first, then switch session,
         * then switch view — the view is per-session state, so selecting it
         * before the session changes would be undone by the restore.
         */
        async function jump(sessionId) {
          const layout = ctx.get?.('layout');
          const right = ctx.get?.('sidebarRight');
          const steps = { before: probe(ctx) };
          // Read before touching anything: the target may already be the one on
          // screen, and "already there" is a success, not a failure.
          const sessionBefore = mainViewSession(ctx);

          if (steps.before.activePanelId !== null && typeof layout?.selectPanel === 'function') {
            try {
              layout.selectPanel(null);
              steps.clearPanel = 'ok';
            } catch (error) {
              steps.clearPanel = String(error).slice(0, 120);
            }
            await sleep(120);
          }

          // Only when something is MEASURED in front, and only when it is the
          // right column: that is the one thing a jump may collapse on its own.
          // A main-column occluder is the panel case handled above — collapsing
          // the right column would not move it, and a blind collapse would
          // close a pane the user opened on purpose. An unmeasurable answer
          // ("no conversation mounted", "offscreen") is not evidence of an
          // obstruction either, so it is left alone.
          if (String(steps.before.occluder ?? '').includes('[side-column]')) {
            if (typeof right?.isExpanded === 'function' && typeof right?.toggleExpanded === 'function' && right.isExpanded() === true) {
              try {
                right.toggleExpanded();
                steps.collapseRight = 'ok';
              } catch (error) {
                steps.collapseRight = String(error).slice(0, 120);
              }
            } else if (typeof layout?.closeRightbar === 'function') {
              try {
                layout.closeRightbar();
                steps.closeRightbar = 'ok';
              } catch (error) {
                steps.closeRightbar = String(error).slice(0, 120);
              }
            }
          }

          try {
            workspace.openSession(sessionId);
            steps.openSession = 'ok';
          } catch (error) {
            steps.openSession = String(error).slice(0, 120);
          }
          await sleep(200);

          // The view tab, after the session settles: this is the 上下文 case.
          steps.selectView = selectChatView();
          await sleep(200);
          steps.after = probe(ctx);

          // A tab that is still not chat after one click means the click landed
          // before the strip re-rendered for the new session; one retry covers
          // that without looping.
          if (steps.after.view !== 'chat' && steps.after.view !== null) {
            steps.selectViewRetry = selectChatView();
            await sleep(220);
            steps.afterRetry = probe(ctx);
          }

          // Did the session actually change? Every step above can report "ok"
          // while the main column still shows the conversation you were reading
          // — openSession resolves, the tab click lands, and nothing moved.
          // Reading the session list is the only statement that can be trusted,
          // and it is the one number worth reporting: a jump that lands is the
          // whole point of this seam.
          let landed = null;
          let seen = null;
          for (let attempt = 0; attempt < 12 && landed !== true; attempt += 1) {
            seen = mainViewSession(ctx);
            if (seen === sessionId) {
              landed = true;
              break;
            }
            await sleep(120);
          }
          steps.landed = {
            landed: landed === true,
            wanted: sessionId,
            seen,
            was: sessionBefore,
            // null means "the shell does not expose this", which must not be
            // read as a failure: the jump may well have worked.
            readable: seen !== null || sessionBefore !== null,
            attempts: landed === true ? 'settled' : 'timeout',
          };

          for (const [name, detail] of Object.entries(steps)) {
            report(`step:${name}`, detail);
          }
        }

        let stopped = false;
        let timer = 0;
        let busy = false;
        // The last jump this PAGE applied. The host broadcasts a claim to every
        // open page, because the page that wins the race is not necessarily the
        // one the user is looking at — so each page has to recognise "seen it"
        // instead of assuming it is the only client.
        let appliedJump = null;

        async function poll() {
          if (stopped) return;
          // A hidden page must not race the visible one for the claim: it would
          // navigate a window nobody is watching and leave the foreground page
          // exactly where it was. Hidden pages pick the claim up on the next
          // visible tick instead.
          try {
            if (document.visibilityState !== 'visible') return;
          } catch {
            /* no visibility API: behave as before */
          }
          try {
            const response = await fetch(pendingUrl, { credentials: 'same-origin' });
            if (response.status !== 200) return;
            const body = await response.json();
            if (typeof body?.sessionId !== 'string' || body.sessionId === '') return;
            const jumpId = typeof body.jumpId === 'string' && body.jumpId !== '' ? body.jumpId : body.sessionId;
            if (busy) return;
            if (appliedJump === jumpId) return;
            appliedJump = jumpId;
            busy = true;
            try {
              await jump(body.sessionId);
            } finally {
              busy = false;
            }
          } catch {
            // The route is missing on an older host, or the page is offline:
            // a notifier's jump is a convenience, never a console error.
          }
        }

        const start = () => {
          if (!stopped) poll();
          timer = setTimeout(start, 1000);
        };
        timer = setTimeout(start, 1000);

        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      },
    };
  },
});
