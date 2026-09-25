import { defineConfig, type IndexHtmlTransformContext, type IndexHtmlTransformResult, type ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'path'
import react from '@vitejs/plugin-react'
// @ts-ignore
import { servePackageTgz } from './scripts/pkgutil.mjs'
// Writes the chunk graph the asset-size budget reads (npm run assets:budget).
// Build-only, and it writes outside dist/ — see scripts/asset-budget.mjs.
import { chunkGraphPlugin } from './scripts/asset-budget.mjs'
import { createInitTracker, injectedInitSrc } from './scripts/devInitScript.ts'

// App version from package.json, injected as a build-time constant so the UI
// always shows the version being tested/shipped (stays in sync with packaging).
const APP_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string }).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// ---------------------------------------------------------------------------
// DEV-ONLY Cribl Search proxy.
// When running `npm run dev`, the app has no platform fetch-proxy, so requests
// to `/capi/*` are proxied to the real Cribl API and an OAuth token (fetched
// from the gitignored .dev/cribl.json client credentials) is injected. In the
// installed app this proxy does not exist — the app uses window.CRIBL_API_URL
// and the platform injects auth. See src/cribl/config.ts.
// ---------------------------------------------------------------------------
type DevCreds = { apiBase: string; tokenUrl: string; audience: string; clientId: string; clientSecret: string }
let devCreds: DevCreds | null = null
let devTarget = ''
let devToken = ''
try {
  const p = join(process.cwd(), '.dev', 'cribl.json')
  if (existsSync(p)) {
    devCreds = JSON.parse(readFileSync(p, 'utf-8'))
    devTarget = devCreds!.apiBase.replace(/\/api\/v1\/?$/, '')
  }
} catch { /* no dev creds — proxy stays inert */ }

async function refreshDevToken() {
  if (!devCreds) return
  try {
    const res = await fetch(devCreds.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: devCreds.clientId,
        client_secret: devCreds.clientSecret,
        audience: devCreds.audience,
      }),
    })
    const data = await res.json() as { access_token?: string }
    if (data.access_token) {
      devToken = data.access_token
      // eslint-disable-next-line no-console
      console.log('[cribl-dev-proxy] token refreshed →', devTarget)
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[cribl-dev-proxy] token fetch failed:', (e as Error).message)
  }
}
// NOTE: this module is loaded by BOTH `vite dev` and `vite build`. The refresh
// timer must never keep the Node event loop alive, or `vite build` won't exit
// and `npm run package` (build && package) would hang. `.unref()` fixes that,
// and we only arm it when actually serving (see configureServer below).
let devTokenTimer: ReturnType<typeof setInterval> | null = null
function startDevTokenRefresh() {
  if (!devCreds || devTokenTimer) return
  void refreshDevToken()
  devTokenTimer = setInterval(() => void refreshDevToken(), 50 * 60 * 1000)
  devTokenTimer.unref?.()
}

const packageEndpointPlugin = () => ({
  name: 'vite-plugin-package-endpoint',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/package.tgz', (req: IncomingMessage, res: ServerResponse) => {
      void servePackageTgz(req, res, server.config.root)
    })
  },
})

const WATCHED_CONFIG_FILES = ['package.json', 'config/proxies.yml', 'config/policies.yml'];
const CONFIG_CHANGED_HMR_EVENT = 'cribl:config-changed';

const CONFIG_CHANGED_BRIDGE = `
import { createHotContext } from '/@vite/client';
const hot = createHotContext('cribl:config-watcher');
hot.on('${CONFIG_CHANGED_HMR_EVENT}', (data) => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'CRIBL_APP_CONFIG_CHANGED', file: data && data.file }, '*');
  }
  window.location.reload();
});
`;

// The dev-only page trace, relayed (src/cribl/devTrace.ts `startRelay`). Cribl's Live Preview loads
// this server in a sandboxed cross-origin frame that gets only ?init=, so ?trace and the console are
// out of reach. While .dev/trace-on exists, every page served here is marked for tracing and posts
// its trace to /__trace, appended as one JSON line to .dev/trace.ndjson (.dev/ is gitignored).
// Delete the flag to stop. Dev server only: `vite build` never runs configureServer or serves HTML.
const TRACE_FLAG = join('.dev', 'trace-on');
const TRACE_OUT = join('.dev', 'trace.ndjson');
const traceRelayPlugin = () => ({
  name: 'trace-relay',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/__trace', (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; if (body.length > 4_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const trace: unknown = JSON.parse(body);
          appendFileSync(join(server.config.root, TRACE_OUT), JSON.stringify({ received: Date.now(), trace }) + String.fromCharCode(10));
          res.statusCode = 204;
        } catch {
          res.statusCode = 400;
        }
        res.end();
      });
    });
  },
  transformIndexHtml(_html: string, ctx: IndexHtmlTransformContext): IndexHtmlTransformResult {
    if (!ctx.server || !existsSync(join(ctx.server.config.root, TRACE_FLAG))) return [];
    return [{ tag: 'script', children: 'window.__GNO_TRACE__ = true;', injectTo: 'head-prepend' as const }];
  },
});

const injectScriptFromQueryPlugin = () => {
  // Each Live Preview page's ?init=, remembered under the page's origin so an init-less reload of
  // /flow-map gets ITS workspace's bridge. See scripts/devInitScript.ts.
  const initTracker = createInitTracker();
  return {
    name: 'inject-script-from-query',
    configureServer(server: ViteDevServer) {
      startDevTokenRefresh(); // dev only — never armed during `vite build`
      // Pre-middleware: runs before Vite's html fallback and index-html middlewares.
      server.middlewares.use(initTracker.middleware);
      const root = server.config.root;
      const watched = WATCHED_CONFIG_FILES.map((rel) => join(root, rel));
      server.watcher.add(watched);
      server.watcher.on('change', (file) => {
        const idx = watched.indexOf(file);
        if (idx === -1) return;
        server.ws.send(CONFIG_CHANGED_HMR_EVENT, { file: WATCHED_CONFIG_FILES[idx] });
      });
    },
    transformIndexHtml(html: string, ctx: IndexHtmlTransformContext): IndexHtmlTransformResult{
      // The tracker's middleware already wrote this page's init into originalUrl when the request
      // carried none; this only reads it. No state here.
      const initSrc = injectedInitSrc(ctx.originalUrl);
      const root = process.cwd();
      let appName;
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: string };
        appName = pkg.name;
      } catch {
        /* ignore missing or invalid package.json */
      }
      appName = appName || 'unknown';
      const tags: Array<{ tag: string; attrs?: Record<string, string>; children?: string; injectTo: 'head-prepend' }> = [];
      tags.push({
        tag: 'script',
        children: `window.CRIBL_APP_ID = '__dev__${appName}';`,
        injectTo: 'head-prepend' as const,
      });
      if (ctx.server && devTarget) {
        // Dev-only: expose the Cribl UI origin so the "Open in Cribl Search"
        // deep link reaches the real Search UI (root-relative would hit :5173).
        tags.push({
          tag: 'script',
          children: `window.__CRIBL_SEARCH_ORIGIN = ${JSON.stringify(devTarget)};`,
          injectTo: 'head-prepend' as const,
        });
      }
      if (ctx.server) {
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          children: CONFIG_CHANGED_BRIDGE,
          injectTo: 'head-prepend' as const,
        });
      }
      if (initSrc) {
        tags.push({
          tag: 'script',
          attrs: { src: initSrc, type: 'text/javascript' },
          injectTo: 'head-prepend' as const,
        });
      }
      return { html, tags };
    },
  };
};

export default defineConfig({
  plugins: [react(), packageEndpointPlugin(), injectScriptFromQueryPlugin(), traceRelayPlugin(), chunkGraphPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  base: './',
  server: {
    cors: true,
    // Pin the dev port so the Cribl __dev__ app (which loads this server at
    // localhost:5173) always reaches it. strictPort => fail loudly instead of
    // silently drifting to 5174/5175 if 5173 is already taken by a stale server.
    port: 5173,
    strictPort: true,
    proxy: devTarget
      ? {
          '/capi': {
            target: devTarget,
            changeOrigin: true,
            secure: true,
            rewrite: (path: string) => path.replace(/^\/capi/, '/api/v1'),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            configure: (proxy: any) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              proxy.on('proxyReq', (proxyReq: any) => {
                if (devToken) proxyReq.setHeader('Authorization', 'Bearer ' + devToken)
              })
            },
          },
        }
      : undefined,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
})

