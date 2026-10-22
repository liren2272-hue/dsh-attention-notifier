window.__ModuleLoader__.load({
  id: '@liren2272/dsh-attention',
  factory(require) {
    'use strict';
    // No React: this half renders nothing. It exists so a desktop card click
    // can land the page on the session that interrupted you, and raising a
    // window is only half of that — the window comes back showing whatever
    // session was last open.

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

    return {
      inject: ['uiWorkspace'],
      apply(ctx) {
        const workspace = ctx.uiWorkspace ?? ctx.get?.('uiWorkspace');
        if (workspace === undefined || typeof workspace.openSession !== 'function') return;

        const url = routeUrl('dsh-attention/pending');
        if (url === null) return;

        let stopped = false;
        let timer = 0;

        async function poll() {
          if (stopped) return;
          try {
            const response = await fetch(url, { credentials: 'same-origin' });
            if (response.status === 204) return;
            if (!response.ok) return;
            const body = await response.json();
            if (typeof body?.sessionId === 'string' && body.sessionId !== '') {
              workspace.openSession(body.sessionId);
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
