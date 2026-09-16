/**
 * dsh-proxy-pro — host half (Cordis plugin).
 *
 * Routes the whole runtime through a proxy when enabled:
 *  - model requests and plain fetch(): the undici global dispatcher
 *  - web_search / web_fetch: the dsh-http-proxy POLICY that dsh-web-fetch-http's
 *    proxyRouteFor() reads (the KEY fix the stock dsh-plugin-proxy lacks — see
 *    docs/LESSONS.md §2-§3)
 *  - spawned tools: HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY are
 *    written into process.env
 *
 * Everything goes through ONE channel: `installProxyFromEnvironment(envLike)`.
 * That call owns the environment, the global dispatcher, and the module-level
 * policy state as one coherent unit, so the plugin never touches undici
 * directly and no dispatcher/instance skew is possible (LESSONS §3: mixed
 * undici instances → UND_ERR_INVALID_ARG).
 *
 * A "never applied yet" guard keeps boot with `enabled: false` a strict no-op
 * on the transport, so dsh-proxy-pro can coexist with dsh-plugin-proxy during
 * migration (NFR-4: only the row whose switch is ON owns the dispatcher).
 *
 * Configuration lives in the `proxy` settings namespace (Settings → 代理管理),
 * layered over the composition entry (cordis.patch.yml).
 *
 * @module dsh-proxy-pro
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { installProxyFromEnvironment, proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  keepaliveHint,
  makeSystemProxyReader,
  resolveProxyState,
  summarize,
  systemFactsEqual,
} from './proxy-core.js'

const execFileAsync = promisify(execFile)

/** Cordis plugin name (also the bundle row id in cordis.patch.yml). */
const name = 'dsh-proxy-pro'

/** Services this plugin must resolve before it applies. */
const inject = ['tools', 'systemPrompt', 'settings']

/** Settings namespace owning the proxy configuration (shared with stock tooling). */
const PROXY_NS = settingsNamespace('proxy')

/** Ordered placement of the proxy status section in the system prompt. */
const SECTION_ORDER = 55

/** Base path for the status HTTP API (client polls this). */
const ROUTE_BASE = '/dsh-proxy-pro/api'

/** Composition-row configuration (also the settings schema). */
const Config = z.object({
  enabled: z.boolean().default(false),
  mode: z.union([z.const('system'), z.const('custom'), z.const('none')]).default('system'),
  customUrl: z.string().default('http://127.0.0.1:7890'),
  noProxy: z.string().default('localhost,127.0.0.1,::1'),
  systemPollMs: z.number().default(30000).min(0),
})

/** Every proxy environment name dsh-http-proxy's resolver can read. */
const PROXY_ENV_NAMES = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]

/**
 * The virtual environment snapshot for one effective state, or null when the
 * proxy is inactive. installProxyFromEnvironment resolves its policy purely
 * from this (env.get must return `{ value }` or undefined); the lower-case
 * names win in resolution, the upper-case ones are the published form.
 */
function proxyEnvMap(effective) {
  if (effective?.active !== true || effective.url === null || effective.url === undefined) return null
  const http = effective.http ?? effective.url
  const https = effective.https ?? effective.url
  const noProxy = effective.noProxy ?? ''
  return {
    HTTP_PROXY: http, HTTPS_PROXY: https, ALL_PROXY: effective.url, NO_PROXY: noProxy,
    http_proxy: http, https_proxy: https, all_proxy: effective.url, no_proxy: noProxy,
  }
}

/** Build the envLike snapshot `installProxyFromEnvironment` expects (LESSONS §4). */
function makeEnvLike(effective) {
  const map = proxyEnvMap(effective)
  return {
    get: (target) => {
      const value = map === null ? undefined : map[target]
      return value === undefined ? undefined : { value }
    },
  }
}

/** Build the agent-facing status text from the latest sync snapshot. */
function renderStatusText(snapshot) {
  const effective = snapshot?.effective
  const config = snapshot?.config
  if (effective === undefined || config === undefined) {
    return 'Proxy: not yet initialized.'
  }
  const active = effective.active === true
  const mode = config.mode ?? 'none'
  if (!active) {
    const reason = effective.reason === 'system-proxy-off'
      ? 'the Windows system proxy is currently off'
      : effective.reason === 'invalid-custom-url'
        ? 'the custom proxy address is invalid'
        : effective.reason === 'mode-none'
          ? 'the mode is set to "none"'
          : 'the proxy switch is off'
    return [
      '## Proxy status: OFF',
      '',
      `Network traffic currently goes DIRECT (no proxy): ${reason}.`,
      'If a network operation fails and you suspect it needs a proxy, call `proxy_status` to confirm, then `proxy_set` with enabled=true — or ask the user to flip the proxy switch.',
    ].join('\n')
  }
  const source = mode === 'system' ? 'Windows system proxy' : 'custom address'
  return [
    '## Proxy status: ON',
    '',
    `The whole runtime (model requests, web_search/web_fetch, and all spawned tools) is routed through the proxy: ${effective.url} (${source}).`,
    '',
    `Bypass list (NO_PROXY, traffic goes direct): ${effective.noProxy || '(none)'}.`,
    '',
    'Implications you MUST respect:',
    '- Assume every outbound HTTP(S) request goes through this proxy unless the host is on the bypass list.',
    '- Localhost / 127.0.0.1 / ::1 and anything in the bypass list always go direct — use them for local services.',
    '- If an operation must NOT go through the proxy (an internal network target, a local server, a host the proxy would break), call `proxy_set` with enabled=false first, run the operation, then re-enable with enabled=true.',
    '- Do not silently retry failed proxy attempts with a different tool expecting a different route; check `proxy_status` and the failure reason first.',
  ].join('\n')
}

/** Isolate NetworkError-ish codes that mean "could not connect at all". */
function classifyTargetFailure(error) {
  const cause = error?.cause
  const code = cause?.code ?? error?.code ?? ''
  if (code === 'EACCES' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return { ok: false, kind: 'unreachable', short: `cannot reach directly (${code}) — needs a proxy route` }
  }
  if (/407|NTLM|authentication required/i.test(String(error?.message ?? ''))) {
    return { ok: false, kind: 'auth', short: 'the proxy asks for NTLM authentication' }
  }
  return { ok: false, kind: 'other', short: (error?.message ?? String(error)).slice(0, 120) }
}

/**
 * Probe one target the way web_fetch will see it: route verdict first, then a
 * real HEAD through the installed policy (global fetch → policy dispatcher).
 */
async function probeTarget(url, snapshot) {
  const parsed = new URL(url)
  let routeName = 'DIRECT'
  try {
    const policyProbe = proxyRouteFor(parsed)
    routeName = policyProbe.proxied ? `PROXIED ${policyProbe.proxy}` : 'DIRECT'
  } catch {
    // proxyRouteFor unavailable in this composition → rely on state snapshot
  }
  const noProxyList = snapshot?.effective?.noProxy ?? ''
  const bypassed = noProxyList.split(',').some((entry) => {
    const host = entry.trim().replace(/^\*?\./, '').toLowerCase()
    return host.length > 0 && (host === parsed.hostname.toLowerCase() || parsed.hostname.toLowerCase().endsWith(`.${host}`))
  })
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(parsed, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-proxy-pro/0.1' },
    })
    clearTimeout(timer)
    return { url, route: routeName, bypassed, probe: { ok: true, status: res.status } }
  } catch (error) {
    return { url, route: routeName, bypassed, probe: classifyTargetFailure(error) }
  }
}

// ---- browser-trust fence (mirrors dsh's /api fence) ------------------------
// dsh's own RPC channels run every request through isTrustedApiRequest
// (dsh-client-connection): Host must be loopback (DNS rebinding cannot forge
// Host), sec-fetch-site=cross-site is refused (browser CSRF marker), and an
// attached Origin must be same-host. Our panel API is registered directly on
// ctx.webServer, so we replicate that fence here — the same implementation
// dsh-skill-manager ships (its lib/index.js L131-172), matching the loopback
// verdict of the official fence with zero extra dependencies.

/** Normalized URL of a Host-header authority (hostname lowercased), or undefined. */
function parseHostHeader(host) {
  if (typeof host !== 'string' || !host) return undefined
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** localhost | [::1] | any IPv4 in 127/8 — the loopback authority set. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** True when the Host is loopback and any attached browser markers are same-origin. */
function isTrustedPanelRequest(headers) {
  const host = typeof headers?.get === 'function' ? headers.get('host') : headers?.host
  const hostname = parseHostHeader(host)
  if (!hostname || !isLoopbackHostname(hostname)) return false
  if (headers?.get && headers.get('sec-fetch-site') === 'cross-site') return false
  if (!headers?.get && headers?.['sec-fetch-site'] === 'cross-site') return false
  const originRaw = typeof headers?.get === 'function' ? headers.get('origin') : headers?.origin
  if (originRaw === undefined || originRaw === null || originRaw === '') return true
  try {
    return new URL(originRaw).hostname.toLowerCase() === hostname
  } catch {
    return false
  }
}

/** Write 403 and return true when the request fails the fence (handler calls first). */
function denyIfUntrusted(req, res) {
  if (isTrustedPanelRequest(req.headers)) return false
  try {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
  } catch {
    /* client gone */
  }
  return true
}

/**
 * Cordis plugin body.
 * @param ctx - registrant context.
 * @param config - validated composition configuration.
 */
function apply(ctx, config) {
  const systemProxyReader = makeSystemProxyReader(execFileAsync)
  let source = () => config
  let snapshot = undefined
  let httpProxyPolicy = undefined
  let syncing = null
  let disposed = false
  let haveApplied = false
  let pollTimer = undefined
  let lastSystemFacts = null

  /** Read all inputs (config + system facts), apply, and record the snapshot. */
  const sync = async () => {
    if (disposed) return
    const resolved = source()
    let systemProxy = null
    if (resolved.mode === 'system' && resolved.enabled === true) {
      try {
        systemProxy = await systemProxyReader()
        lastSystemFacts = systemProxy
      } catch (error) {
        ctx.logger.warn('dsh-proxy-pro: reading the Windows system proxy failed: %s', String(error))
      }
    }
    const effective = resolveProxyState(resolved, systemProxy)
    const active = effective.active === true && effective.url !== null
    // Guard: while we have never applied anything, OFF stays a transport
    // no-op so boot with the default switch never touches env/dispatcher
    // (coexistence with dsh-plugin-proxy during migration, NFR-4).
    if (!active && !haveApplied) {
      snapshot = { config: resolved, effective, systemProxy, at: new Date().toISOString() }
      ctx.emit('dsh-proxy-pro/status', summarize(snapshot))
      return
    }
    if (active) haveApplied = true
    // Single transport channel: installProxyFromEnvironment owns process.env,
    // the global dispatcher, and the module-level policy that proxyRouteFor()
    // reads. Uninstall the previous policy before (re)installing so the
    // package's active/installed state never goes stale (LESSONS §4).
    try {
      if (httpProxyPolicy !== undefined) {
        await httpProxyPolicy()
        httpProxyPolicy = undefined
      }
      const envLike = makeEnvLike(effective)
      httpProxyPolicy = await installProxyFromEnvironment(envLike, (m) => ctx.logger.warn('dsh-proxy-pro: dsh-http-proxy: %s', m))
    } catch (error) {
      ctx.logger.warn('dsh-proxy-pro: applying the proxy policy failed: %s', String(error))
    }
    snapshot = { config: resolved, effective, systemProxy, at: new Date().toISOString() }
    ctx.emit('dsh-proxy-pro/status', summarize(snapshot))
  }

  /** Coalesced sync: concurrent triggers share one in-flight pass. */
  const requestSync = () => {
    if (disposed) return Promise.resolve()
    if (syncing !== null) return syncing
    syncing = sync().finally(() => { syncing = null })
    return syncing
  }

  // Configuration source: the `proxy` settings namespace layered over the
  // composition entry; every committed change re-syncs live.
  installSettingsSection(ctx, PROXY_NS, Config, config, {
    setSource: (current) => {
      source = current
      void requestSync()
    },
    onChange: () => {
      void requestSync()
    },
  })

  // ---------- Agent tools ----------

  ctx.tools.register(defineTool({
    name: 'proxy_status',
    description: 'Show the current proxy state of this runtime: whether traffic goes through a proxy, the effective proxy address, the NO_PROXY bypass list, and the source of the setting. Call this before any network operation where the proxy route matters, and whenever a network operation fails unexpectedly.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'boolean', required: true },
          enabled: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          url: { type: 'string', required: true },
          noProxy: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          source: { type: 'string', required: true },
          at: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const head = value.active
          ? `Proxy ON — ${value.url} (${value.source === 'system' ? 'system' : 'custom'})`
          : `Proxy OFF — direct connection (${value.reason})`
        const lines = [head, `NO_PROXY bypass: ${value.noProxy || '(none)'}`]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async () => {
      await requestSync()
      return summarize(snapshot)
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Proxy status',
      kind: 'other',
      rawInput: {},
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'proxy_set',
    description: 'Turn the proxy on or off for the whole runtime. Use enabled=false when an operation must go DIRECT (an internal/intranet target, a local server, or a host the proxy would break), then re-enable with enabled=true afterwards. The change is persisted and takes effect immediately for model requests, web fetches, and spawned tools.',
    parameters: {
      enabled: {
        type: 'boolean',
        required: true,
        description: 'true = route traffic through the configured proxy; false = go direct (no proxy).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'boolean', required: true },
          enabled: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          url: { type: 'string', required: true },
          noProxy: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          source: { type: 'string', required: true },
          at: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.active
          ? `Proxy enabled — ${value.url} (${value.source === 'system' ? 'system' : 'custom'})`
          : `Proxy disabled — traffic now goes direct.`,
      }],
    },
    execute: async (args) => {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        throw new Error('proxy_set: the settings service is unavailable in this composition — change the proxy config instead')
      }
      await settings.update(PROXY_NS, { enabled: args.enabled === true })
      await requestSync()
      return summarize(snapshot)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Proxy ${args.enabled === true ? 'on' : 'off'}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'proxy_test',
    description: 'Diagnose whether a target URL will route through the proxy or direct, and probe actual connectivity. Use when a fetch/git/curl to a host fails unexpectedly: it reports the route web_fetch will take (PROXIED vs DIRECT), whether the host is bypassed by NO_PROXY, a live connectivity probe, and an NTLM keepalive hint when the proxy asks for authentication.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'The URL to diagnose, e.g. https://github.com/foo/bar.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          route: { type: 'string', required: true },
          bypassed: { type: 'boolean', required: true },
          probe: { type: 'object', required: true },
          hint: { type: 'string', required: false },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Route: ${value.route}`,
          `NO_PROXY bypassed: ${value.bypassed}`,
          `Probe: ${value.probe?.ok === true ? `reachable (HTTP ${value.probe.status})` : value.probe?.short ?? 'unknown'}`,
        ]
        if (value.hint) lines.push(`Hint: ${value.hint}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      await requestSync()
      const result = await probeTarget(String(args.url ?? ''), snapshot)
      result.hint = keepaliveHint(result.probe?.short ?? '')
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Proxy test',
      kind: 'other',
      rawInput: args,
    }),
  }))

  // The model must always know whether the proxy is in force.
  ctx.systemPrompt.section({
    name: 'dsh-proxy-pro:status',
    order: SECTION_ORDER,
    text: () => renderStatusText(snapshot),
  })

  // ---------- Status HTTP API (for the client UI) ----------
  const sendJson = (res, status, body) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    } catch {
      /* client gone */
    }
  }
  const readJsonBody = async (req, maxBytes = 2 * 1024 * 1024) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > maxBytes) throw new Error('request body too large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return {}
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    try {
      const unregisterRoute = webServer.register({
        kind: 'prefix',
        path: ROUTE_BASE,
        handler: async (req, res) => {
          if (denyIfUntrusted(req, res)) return
          const url = new URL(req.url ?? '/', 'http://localhost')
          const is = (p, m) => url.pathname === `${ROUTE_BASE}${p}` && req.method === m
          try {
            if (is('/status', 'GET')) {
              await requestSync()
              sendJson(res, 200, { ok: true, status: summarize(snapshot) })
              return
            }
            if (is('/route', 'GET')) {
              const target = url.searchParams.get('url') ?? ''
              await requestSync()
              const result = await probeTarget(target, snapshot)
              result.hint = keepaliveHint(result.probe?.short ?? '')
              sendJson(res, 200, { ok: true, ...result })
              return
            }
            if (is('/toggle', 'POST')) {
              const body = await readJsonBody(req)
              const settings = ctx.get('settings')
              if (settings === undefined) {
                sendJson(res, 503, { ok: false, error: 'settings service unavailable' })
                return
              }
              await settings.update(PROXY_NS, { enabled: body.enabled === true })
              await requestSync()
              sendJson(res, 200, { ok: true, status: summarize(snapshot) })
              return
            }
            sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })
      ctx.effect(() => () => { try { unregisterRoute?.() } catch { /* best effort */ } }, 'dsh-proxy-pro: route cleanup')
    } catch (error) {
      ctx.logger.warn('dsh-proxy-pro: webServer unavailable — status API disabled: %s', String(error))
    }
  }

  // Follow the Windows system proxy at runtime (change-only re-apply).
  if (config.systemPollMs > 0) {
    pollTimer = setInterval(async () => {
      if (disposed) return
      const resolved = source()
      if (resolved.mode !== 'system' || resolved.enabled !== true) return
      let facts
      try {
        facts = await systemProxyReader()
      } catch {
        return
      }
      if (lastSystemFacts !== null && systemFactsEqual(lastSystemFacts, facts)) return
      void requestSync()
    }, config.systemPollMs)
    pollTimer.unref?.()
  }

  // Tear down: restore env, dispatcher, and dsh-http-proxy policy.
  ctx.effect(() => {
    return () => {
      disposed = true
      if (pollTimer !== undefined) clearInterval(pollTimer)
      void Promise.resolve(httpProxyPolicy?.()).catch(() => {})
      httpProxyPolicy = undefined
    }
  }, 'dsh-proxy-pro: cleanup')
}

export { Config, apply, inject, name }