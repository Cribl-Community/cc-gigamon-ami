import { defineConfig, type IndexHtmlTransformContext, type IndexHtmlTransformResult, type ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'path'
import react from '@vitejs/plugin-react'
// @ts-ignore
import { servePackageTgz } from './scripts/pkgutil.mjs'

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

const injectScriptFromQueryPlugin = () => {
  let initScriptUrl: string | null = null;
  return {
    name: 'inject-script-from-query',
    configureServer(server: ViteDevServer) {
      startDevTokenRefresh(); // dev only — never armed during `vite build`
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
      const url = new URL(ctx.originalUrl ?? '/', 'https://localhost');
      initScriptUrl = initScriptUrl || url.searchParams.get('init');
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
      if (initScriptUrl) {
        tags.push({
          tag: 'script',
          attrs: { src: initScriptUrl, type: 'text/javascript' },
          injectTo: 'head-prepend' as const,
        });
      }
      return { html, tags };
    },
  };
};

export default defineConfig({
  plugins: [react(), packageEndpointPlugin(), injectScriptFromQueryPlugin()],
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

