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
  classifyProbeStatus,
  classifyTargetFailure,
  keepaliveHint,
  makeSystemProxyReader,
  normalizeProxyUrl,
  resolveProxyState,
  summarize,
  systemFactsEqual,
} from './proxy-core.js'
import {
  PROXY_CONFIG_PARAMETERS,
  PROXY_SET_PARAMETERS,
  PROXY_STATUS_SCHEMA,
  PROXY_TEST_PARAMETERS,
  PROXY_TEST_SCHEMA,
} from './tool-schemas.js'

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
  // 'none' kept only for parsing pre-removal settings.yaml values; the UI and
  // proxy_config never produce it anymore (LESSONS §17.3e).
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
      'If a network operation fails and you suspect it needs a proxy, call `proxy_status` to confirm, then `proxy_set` with enabled=true — or `proxy_config` to change the mode, the address, or the direct/NO_PROXY list.',
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
    '- To change the configuration itself — switch between the system proxy and a custom address, or edit the direct/NO_PROXY list so some hosts bypass the proxy — call `proxy_config`; it persists the change and applies it immediately.',
    '- Do not silently retry failed proxy attempts with a different tool expecting a different route; check `proxy_status` and the failure reason first.',
  ].join('\n')
}

// classifyTargetFailure lives in proxy-core.js (pure logic, unit-tested) so the
// panel's verdict can name the undici cause instead of a bare "fetch failed".

// Forced-channel probing uses undici directly. Load lazily and never let a
// resolution failure block boot (LESSONS §14: boot must not depend on a new
// bare import).
let undiciPromise = null
function getUndici() {
  if (undiciPromise === null) {
    undiciPromise = import('undici').then((m) => m, () => null)
  }
  return undiciPromise
}

const PROBE_UA = 'dsh-proxy-pro/0.1'
const PROBE_TIMEOUT_MS = 6000

/**
 * 一个探测尝试：先 HEAD，端点不支持 HEAD（405/501）时再用 GET 复测——
 * 很多 API 只实现 GET，只用 HEAD 会冤枉一个可用主机。`request` 是调用方
 * 的 fetch：两条通道现在都用 app undici 的 `und.fetch` 配同副本 dispatcher
 * （LESSONS §22/§25 —— 绝不要把两份副本混在一起）。
 *
 * @returns classifyProbeStatus / classifyTargetFailure 的判定。
 */
async function probeHttp(request, target, dispatcher) {
  const attempt = async (method) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const init = { method, redirect: 'manual', signal: controller.signal, headers: { 'user-agent': PROBE_UA } }
      if (method === 'GET') init.headers.range = 'bytes=0-0'
      if (dispatcher !== undefined) init.dispatcher = dispatcher
      const res = await request(target, init)
      return { res }
    } catch (error) {
      return { error }
    } finally {
      clearTimeout(timer)
    }
  }
  const head = await attempt('HEAD')
  if (head.error !== undefined) return classifyTargetFailure(head.error)
  const verdict = classifyProbeStatus(head.res.status)
  if (verdict.kind !== 'http-error' || (head.res.status !== 405 && head.res.status !== 501)) return verdict
  const get = await attempt('GET')
  if (get.error !== undefined) return classifyTargetFailure(get.error)
  const retried = classifyProbeStatus(get.res.status)
  retried.note = retried.ok === true
    ? 'HEAD 被拒绝但 GET 可用 — 主机可用。'
    : 'HEAD 被拒绝；GET 复测也遇到同类问题。'
  return retried
}

/**
 * Force the probe down one specific channel, bypassing the routing policy:
 * `'proxy'` goes through the configured proxy unconditionally, `'direct'`
 * ignores the proxy entirely. Used by the panel diagnostic's 「使用代理」
 * checkbox so the user can decide whether a host belongs in NO_PROXY.
 */
async function forceChannelProbe(url, channel, proxyUrl) {
  const und = await getUndici()
  if (und === null) {
    return { ok: false, verdict: 'unusable', kind: 'unavailable', short: '强制通道不可用（undici 未能加载）',
      why: '宿主进程无法加载 app 侧 undici 包。',
      fix: '取消勾选「使用代理」改用策略通道，或重启 DSH；仍出现请反馈插件版本。' }
  }
  let dispatcher
  try {
    dispatcher = channel === 'direct'
      ? new und.Agent({ connections: 1 })
      : new und.ProxyAgent(proxyUrl)
  } catch (error) {
    return { ok: false, verdict: 'unusable', kind: 'bad-proxy', short: `代理地址无效：${String(error?.message ?? error)}`,
      why: '当前生效的代理地址不是有效的 http(s) 代理 URL。',
      fix: '在「代理配置」修复地址（mode = 自定义地址）或清空自定义地址。' }
  }
  try {
    // MUST issue the request with THIS undici copy. The host runs two copies —
    // Node's built-in `fetch` and the app's `undici` package — and a dispatcher
    // built by one handed to the other rejects with UND_ERR_INVALID_ARG
    // ("invalid onRequestStart method"); the panel rendered that as a bare
    // "fetch failed" for BOTH forced channels (LESSONS §22). und.fetch and the
    // Agent/ProxyAgent above come from the same import, so they always agree.
    return await probeHttp((u, i) => und.fetch(u, i), url, dispatcher)
  } finally {
    try { dispatcher.close?.().catch?.(() => {}) } catch { /* best effort */ }
  }
}

/**
 * 按已安装策略探测，与 web_fetch 走同一条路：用同一份 undici 的 fetch 加
 * 全局 dispatcher。策略通道不能用 Node 内置 `fetch`——全局 dispatcher 由
 * app 的 undici（installProxyFromEnvironment）安装，内置 fetch 拿它必然
 * UND_ERR_INVALID_ARG（LESSONS §25，A 组合；面板当时显示"dispatcher
 * rejected… mixed undici copies"）。
 */
async function policyProbe(target) {
  const und = await getUndici()
  if (und === null) {
    return { ok: false, verdict: 'unusable', kind: 'unavailable', short: '策略通道不可用（undici 未能加载）',
      why: '宿主进程无法加载 app 侧 undici 包。', fix: '重启 DSH；仍出现请反馈插件版本。' }
  }
  const dispatcher = typeof und.getGlobalDispatcher === 'function' ? und.getGlobalDispatcher() : undefined
  return probeHttp((u, i) => und.fetch(u, i), target, dispatcher)
}

/**
 * 按 web_fetch 的方式探测一个目标：先给路由判定，再用策略通道发真实请求
 * （app undici 的 fetch + 全局 dispatcher，见 policyProbe）。`channel` 选择
 * 探测路径：'policy'（默认）、'proxy'（强制走代理）、'direct'（强制绕过）。
 */
async function probeTarget(url, snapshot, channel = 'policy') {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { url, route: 'invalid', bypassed: false,
      probe: { ok: false, verdict: 'unusable', kind: 'invalid', short: 'URL 无效 — 需要 http(s)://主机/路径',
        why: '输入不是可解析的绝对 URL。', fix: '用完整形式，如 https://github.com/foo/bar。' } }
  }
  let routeName = 'DIRECT'
  try {
    const routeProbe = proxyRouteFor(parsed)
    routeName = routeProbe.proxied ? `PROXIED ${routeProbe.proxy}` : 'DIRECT'
  } catch {
    // proxyRouteFor unavailable in this composition → rely on state snapshot
  }
  const noProxyList = snapshot?.effective?.noProxy ?? ''
  const bypassed = noProxyList.split(',').some((entry) => {
    const host = entry.trim().replace(/^\*?\./, '').toLowerCase()
    return host.length > 0 && (host === parsed.hostname.toLowerCase() || parsed.hostname.toLowerCase().endsWith(`.${host}`))
  })
  if (channel === 'proxy' || channel === 'direct') {
    const proxyUrl = channel === 'proxy' ? (snapshot?.effective?.url ?? '') : ''
    const probe = proxyUrl === '' && channel === 'proxy'
      ? { ok: false, verdict: 'unusable', kind: 'bad-proxy', short: '当前快照里没有可用的代理地址',
        why: '代理开关处于关闭（或 Windows 系统代理关闭），没有可强制走代理的对象。',
        fix: '打开代理，或在「代理配置」里修复地址/模式。' }
      : await forceChannelProbe(parsed, channel, proxyUrl)
    return { url, route: routeName, bypassed, channel, probe }
  }
  const probe = await policyProbe(parsed)
  return { url, route: routeName, bypassed, probe }
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
  let lastAppliedKey = undefined
  let pollTimer = undefined
  let lastSystemFacts = null

  /** Read all inputs (config + system facts), apply, and record the snapshot. */
  const sync = async () => {
    if (disposed) return
    const resolved = source()
    let systemProxy = null
    // System facts are only consulted in mode 'system': custom mode keeps the
    // configured whitelist alone, so no registry read is needed there (§17.3f).
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
    // Idempotency (LESSONS §17): when the effective transport is unchanged we
    // refresh the rich snapshot but MUST NOT rebuild env/dispatcher — sync is
    // a rebuild only when the effective state actually changed. Pollers may
    // call requestSync() freely; the cost of an unchanged pass is a snapshot.
    // http/https are part of the key: a https-only change (same url) must
    // still rebuild so HTTPS_PROXY actually switches (review fix, 2026-09-17).
    const effKey = JSON.stringify([active, effective.url ?? null, effective.http ?? null, effective.https ?? null, effective.noProxy ?? null, effective.reason ?? 'unknown'])
    if (lastAppliedKey !== undefined && lastAppliedKey === effKey) {
      snapshot = { config: resolved, effective, systemProxy, at: new Date().toISOString() }
      ctx.emit('dsh-proxy-pro/status', summarize(snapshot))
      return
    }
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
        // Do NOT await the disposer: it restores dispatcher + env synchronously
        // (setGlobalDispatcher / restoreEnv run before the first await inside),
        // then awaits agent.close() — undici's graceful close drains every
        // keep-alive connection, which with the whole desktop's traffic in
        // flight can block this turn for seconds. Fire it, keep the install
        // serial, and let the pool drain in the background (LESSONS §17.3b).
        const dispose = httpProxyPolicy
        httpProxyPolicy = undefined
        void dispose().catch(() => {})
      }
      const envLike = makeEnvLike(effective)
      httpProxyPolicy = await installProxyFromEnvironment(envLike, (m) => ctx.logger.warn('dsh-proxy-pro: dsh-http-proxy: %s', m))
      lastAppliedKey = effKey
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
      void requestSync().catch(() => {})
    },
    onChange: () => {
      void requestSync().catch(() => {})
    },
  })

  // ---------- Agent tools ----------

  ctx.tools.register(defineTool({
    name: 'proxy_status',
    description: 'Show the current proxy state of this runtime: whether traffic goes through a proxy, the effective proxy address, the NO_PROXY bypass list, and the source of the setting. Call this before any network operation where the proxy route matters, and whenever a network operation fails unexpectedly.',
    parameters: {},
    output: {
      schema: PROXY_STATUS_SCHEMA,
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
    parameters: PROXY_SET_PARAMETERS,
    output: {
      schema: PROXY_STATUS_SCHEMA,
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
    parameters: PROXY_TEST_PARAMETERS,
    output: {
      schema: PROXY_TEST_SCHEMA,
      render: (_args, value) => {
        const p = value.probe ?? {}
        const head = p.verdict === 'usable'
          ? `可用${p.status === undefined ? '' : `（HTTP ${p.status}）`}`
          : `${p.verdict === 'degraded' ? '降级' : '不可用'} — ${p.short ?? '未知'}`
        const lines = [
          `路由: ${value.route}`,
          `NO_PROXY 命中: ${value.bypassed}`,
          `连通探测: ${head}`,
        ]
        if (p.why) lines.push(`可能原因: ${p.why}`)
        if (p.fix) lines.push(`挽救措施: ${p.fix}`)
        if (p.note) lines.push(`备注: ${p.note}`)
        if (value.hint) lines.push(`提示: ${value.hint}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      await requestSync()
      const result = await probeTarget(String(args.url ?? ''), snapshot)
      result.hint = keepaliveHint(result.probe?.short ?? '', snapshot?.effective?.url ?? '')
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Proxy test',
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'proxy_config',
    description: 'Read or change the proxy configuration: the switch (enabled), the source mode (system / custom / none), the custom proxy address, and the NO_PROXY direct-connection list. Call it with no arguments to read the current configuration, or with any subset of fields to change them. Changes are persisted and take effect immediately for model requests, web fetches, and spawned tools. Use `proxy_set` for a plain on/off toggle, and `proxy_test` to check how one URL routes.',
    parameters: PROXY_CONFIG_PARAMETERS,
    output: {
      schema: PROXY_STATUS_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.active
          ? `Proxy config — mode=${value.mode}, ${value.url} (${value.source === 'system' ? 'system' : 'custom'}), bypass: ${value.noProxy || '(none)'}`
          : `Proxy config — inactive (${value.reason}); mode=${value.mode}, bypass: ${value.noProxy || '(none)'}`,
      }],
    },
    execute: async (args) => {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        throw new Error('proxy_config: the settings service is unavailable in this composition — change the proxy configuration in Settings instead')
      }
      const patch = {}
      if (args.enabled !== undefined) patch.enabled = args.enabled === true
      if (args.mode !== undefined) patch.mode = args.mode
      if (args.customUrl !== undefined) {
        const raw = String(args.customUrl).trim()
        if (raw === '') {
          patch.customUrl = ''
        } else {
          const normalized = normalizeProxyUrl(raw)
          if (normalized === null) {
            throw new Error(`proxy_config: "${args.customUrl}" is not a usable proxy address — expected http(s)://host:port (a bare host:port is also accepted)`)
          }
          patch.customUrl = normalized
        }
      }
      if (args.noProxy !== undefined) patch.noProxy = String(args.noProxy).trim()
      if (Object.keys(patch).length > 0) await settings.update(PROXY_NS, patch)
      await requestSync()
      return summarize(snapshot)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Proxy config',
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
              // Pull-triggered refresh: requestSync is idempotent — when the
              // effKey is unchanged it only refreshes the snapshot (no
              // dispatcher/env rebuild); only a real system-proxy change
              // reinstalls. So refreshing here is cheap and every pull serves
              // fresh facts. This is safe where the pre-096e431 /status was
              // not: that one reinstalled UNCONDITIONALLY on every pull and
              // dragged the desktop down (LESSONS §17). The 30s host poll
              // still owns unattended following (page-closed changes); this
              // exists only to serve the viewer.
              await requestSync()
              sendJson(res, 200, { ok: true, status: summarize(snapshot) })
              return
            }
            if (is('/route', 'GET')) {
              const target = url.searchParams.get('url') ?? ''
              const useProxy = url.searchParams.get('useProxy')
              const channel = useProxy === '1' ? 'proxy' : useProxy === '0' ? 'direct' : 'policy'
              const result = await probeTarget(target, snapshot, channel)
              result.hint = keepaliveHint(result.probe?.short ?? '', snapshot?.effective?.url ?? '')
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
      void requestSync().catch(() => {})
    }, config.systemPollMs)
    pollTimer.unref?.()
  }

  // Tear down: restore env, dispatcher, and dsh-http-proxy policy. If a sync
  // is still in flight (e.g. a status-API request), uninstall chained AFTER it
  // — otherwise a late install would leak a policy that teardown already
  // skipped (review fix, 2026-09-17).
  ctx.effect(() => {
    return () => {
      disposed = true
      if (pollTimer !== undefined) clearInterval(pollTimer)
      const detach = () => {
        if (httpProxyPolicy === undefined) return
        const policy = httpProxyPolicy
        httpProxyPolicy = undefined
        void Promise.resolve(policy()).catch(() => {})
      }
      if (syncing !== null) {
        void Promise.resolve(syncing).catch(() => {}).finally(detach)
      } else {
        detach()
      }
    }
  }, 'dsh-proxy-pro: cleanup')
}

export { Config, apply, inject, name }