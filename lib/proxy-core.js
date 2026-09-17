/**
 * dsh-proxy-pro — pure proxy-resolution logic (host + agent tools + HTTP API).
 *
 * Dependency-free (no DSH/Cordis imports) so it can be tested in isolation.
 * Covers:
 *  - parseProxyServer / parseRegValue — read Windows Internet Settings facts.
 *  - makeSystemProxyReader — reg.exe-backed reader (runner injectable).
 *  - composeNoProxy / parseOverrideEntries — NO_PROXY + Windows ProxyOverride merge.
 *  - resolveProxyState — effective proxy from config + (system mode) live facts.
 *  - keepaliveHint — when to suggest a curl NAT window (NTLM SWG proxies).
 *
 * @module dsh-proxy-pro/proxy-core
 */

const PROXY_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const LOCAL_ENTRIES = ['localhost', '127.0.0.1', '::1']

/** Normalize a bare `host:port` or already-schemed URL into an http(s) URL. */
export function normalizeProxyUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  let url
  try {
    url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return url.toString().replace(/\/+$/, '')
}

/**
 * Parse a Windows `ProxyServer` string: single `host:port` (both protocols)
 * or `http=...;https=...` form; `socks=` ignored (undici speaks HTTP CONNECT).
 */
export function parseProxyServer(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const parts = trimmed.split(';').map((p) => p.trim()).filter(Boolean)
  const out = {}
  let usable = false
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      const url = normalizeProxyUrl(part)
      if (url === null) return null
      out.http = url
      out.https = url
      usable = true
      continue
    }
    const protocol = part.slice(0, eq).trim().toLowerCase()
    const target = part.slice(eq + 1).trim()
    if (protocol !== 'http' && protocol !== 'https') continue
    const url = normalizeProxyUrl(target)
    if (url === null) return null
    out[protocol] = url
    usable = true
  }
  return usable ? out : null
}

/** Parse a `REG_DWORD` line like `    ProxyEnable    REG_DWORD    0x1`. */
export function parseRegDword(line) {
  if (typeof line !== 'string') return undefined
  const match = /REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(line)
  if (match === null) return undefined
  return Number.parseInt(match[1], 16)
}

/** Parse a `REG_SZ` line like `    ProxyServer    REG_SZ    127.0.0.1:10808`. */
export function parseRegString(line) {
  if (typeof line !== 'string') return undefined
  const match = /REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line)
  if (match === null) return undefined
  return match[1].trim()
}

/** Decode one `reg query` invocation's raw stdout into a fact. */
export function queryRegValue(stdout) {
  if (typeof stdout !== 'string') return null
  const match = /REG_(?:DWORD|SZ|EXPAND_SZ)\s+(.*)$/.exec(stdout.trim())
  if (match === null) return null
  return match[1].trim()
}

/**
 * Build a system-proxy reader for Windows: three `reg.exe` queries resolved
 * into `{ enabled, http, https, url, override, serverLine }`.
 * @param execFile - `(file, args, options) => Promise<{ stdout, stderr }>`.
 */
export function makeSystemProxyReader(execFile) {
  const query = async (valueName) => {
    try {
      const result = await execFile('reg', ['query', PROXY_REG_KEY, '/v', valueName], {
        windowsHide: true,
        timeout: 3000,
      })
      const raw = queryRegValue(String(result.stdout ?? ''))
      if (raw === null) return undefined
      if (valueName === 'ProxyEnable') {
        return /^0x[0-9a-fA-F]+$/.test(raw) ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10)
      }
      return raw
    } catch {
      return undefined
    }
  }
  return async () => {
    const [enable, server, override] = await Promise.all([
      query('ProxyEnable'),
      query('ProxyServer'),
      query('ProxyOverride'),
    ])
    const enabled = typeof enable === 'number' && enable === 1
    const parsed = parseProxyServer(typeof server === 'string' ? server : '')
    const url = enabled ? (parsed?.http ?? parsed?.https ?? null) : null
    return {
      enabled,
      http: enabled ? (parsed?.http ?? null) : null,
      https: enabled ? (parsed?.https ?? null) : null,
      url,
      serverLine: typeof server === 'string' ? server : '',
      override: typeof override === 'string' ? override : '',
      raw: { enable, server, override },
    }
  }
}

/**
 * Merge configured NO_PROXY entries with always-local entries and (optionally)
 * the Windows ProxyOverride list. `<local>` maps to loopbacks; dedup in order.
 */
export function composeNoProxy(configured, override) {
  const seen = new Set()
  const out = []
  const push = (entry) => {
    if (entry.length === 0 || seen.has(entry)) return
    seen.add(entry)
    out.push(entry)
  }
  for (const entry of LOCAL_ENTRIES) push(entry)
  const raw = typeof configured === 'string' ? configured : ''
  for (const part of raw.split(',')) {
    const entry = part.trim()
    if (entry.length === 0) continue
    if (entry === '<local>') {
      for (const local of LOCAL_ENTRIES) push(local)
      continue
    }
    push(entry)
  }
  if (typeof override === 'string' && override.trim().length > 0) {
    for (const entry of parseOverrideEntries(override)) push(entry)
  }
  return out.join(',')
}

/**
 * Parse a Windows `ProxyOverride` string into NO_PROXY entries undici honors.
 * `;`-separated; `<local>` maps to loopbacks; IP-prefix wildcards (`10.*`) are
 * dropped because undici's matcher cannot represent them.
 */
export function parseOverrideEntries(override) {
  const out = []
  const seen = new Set()
  const push = (entry) => {
    if (entry.length === 0 || seen.has(entry)) return
    seen.add(entry)
    out.push(entry)
  }
  if (typeof override !== 'string') return out
  const parts = override.split(/[;,]/).map((part) => part.trim()).filter(Boolean)
  for (const part of parts) {
    if (part === '<local>') {
      for (const local of LOCAL_ENTRIES) push(local)
      continue
    }
    if (part.includes('*') && !/^\*?\.[^.*]/.test(part)) continue
    if (/^\*\./.test(part)) {
      push(part)
      continue
    }
    push(part)
  }
  return out
}

/** Compare two system-proxy fact sets (poll dedup). */
export function systemFactsEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.enabled === b.enabled
    && (a.url ?? null) === (b.url ?? null)
    && (a.http ?? null) === (b.http ?? null)
    && (a.https ?? null) === (b.https ?? null)
    && (a.override ?? '') === (b.override ?? '')
}

/**
 * Decide the effective proxy from config plus live system facts. The system
 * ProxyOverride is merged into NO_PROXY only in mode 'system': in custom mode
 * the configured whitelist stands alone (the user's own list, nothing from
 * Windows) (§17.3f).
 * @param {object} config - `{ enabled, mode, customUrl, noProxy }`.
 * @param {object|null} systemProxy - reader output (url/override facts).
 */
export function resolveProxyState(config, systemProxy = null) {
  const configOnlyNoProxy = composeNoProxy(config?.noProxy)
  if (config?.enabled !== true || config?.mode === 'none') {
    return { active: false, url: null, http: null, https: null, noProxy: configOnlyNoProxy, reason: config?.mode === 'none' ? 'mode-none' : 'disabled' }
  }
  if (config?.mode === 'custom') {
    const url = normalizeProxyUrl(config?.customUrl)
    if (url === null) {
      return { active: false, url: null, http: null, https: null, noProxy: configOnlyNoProxy, reason: 'invalid-custom-url' }
    }
    return { active: true, url, http: url, https: url, noProxy: configOnlyNoProxy, reason: 'custom' }
  }
  // mode === 'system'
  if (systemProxy?.enabled !== true || systemProxy.url === null) {
    return { active: false, url: null, http: null, https: null, noProxy: configOnlyNoProxy, reason: 'system-proxy-off' }
  }
  return {
    active: true,
    url: systemProxy.url,
    http: systemProxy.http ?? systemProxy.url,
    https: systemProxy.https ?? systemProxy.url,
    noProxy: composeNoProxy(config?.noProxy, systemProxy.override),
    reason: 'system',
  }
}

/**
 * Render a short human-ready summary of the effective state (used by tools,
 * the system prompt section, and the JSON status API).
 */
export function summarize(snapshot) {
  const effective = snapshot?.effective
  const config = snapshot?.config
  return {
    active: effective?.active === true,
    enabled: config?.enabled === true,
    mode: config?.mode ?? 'none',
    url: effective?.url ?? '',
    noProxy: effective?.noProxy ?? composeNoProxy(config?.noProxy),
    reason: effective?.reason ?? 'unknown',
    source: config?.mode === 'system' ? 'system' : config?.mode === 'custom' ? 'custom' : 'none',
    at: snapshot?.at ?? '',
  }
}

/**
 * NTLM keepalive hint: SWG proxies (netentsec etc.) ask undici for NTLM auth
 * which undici cannot negotiate; a curl/browser NAT'd connection keeps a
 * window open. Only relevant when a 407 or auth-required response is seen.
 * The example URL is caller-supplied (the effective proxy), never hardcoded —
 * a fixed sample leaked this developer's own corporate proxy into every hint.
 */
export function keepaliveHint(message = '', proxyUrl = '') {
  const text = typeof message === 'string' ? message : ''
  if (!/407|NTLM|proxy authentication|authentication required/i.test(text)) return ''
  const example = typeof proxyUrl === 'string' && proxyUrl !== '' ? proxyUrl : 'http://localhost:7890'
  return `This proxy asks for NTLM authentication, which undici cannot negotiate by itself. A recent curl/browser connection to the same proxy keeps an authenticated window open — run a \`curl\` through the proxy (e.g. \`curl -x ${example} -I https://github.com\`) once, then retry.`
}

/**
 * Three-state verdict for one HTTP answer, shared by the panel, `proxy_test`
 * and the HTTP API:
 *
 *  - `usable`   — the route works for real calls (2xx/3xx, plus 401: a healthy
 *                 API endpoint answering the credential-less probe).
 *  - `degraded` — an HTTP answer came back, so the route works, but the call
 *                 itself would likely fail (403/404/405/429 and other 4xx).
 *  - `unusable` — the route or the far end failed (407 auth wall, 5xx from the
 *                 target, gateway/upstream timeouts).
 *
 * Every verdict carries `why` (the likely cause) and `fix` (what to try), so a
 * diagnosis is actionable instead of a bare status code (2026-09-17: 504 and
 * 200 both rendered as "reachable", which answered nothing).
 *
 * @param status - the HTTP status code a probe received.
 * @returns `{ ok, verdict, kind, status, short, why, fix }`.
 */
export function classifyProbeStatus(status) {
  const code = Number(status)
  const base = { status: code }
  if (code === 407) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'auth', short: 'HTTP 407 — the proxy asks for authentication (NTLM)',
      why: 'The request never reached the target: the proxy demands NTLM, which undici cannot negotiate.',
      fix: 'Run one curl/browser request through the same proxy (e.g. curl -x <proxy> -I https://github.com) to open an authenticated window, then retry.' }
  }
  if (code >= 200 && code < 400) {
    return { ...base, ok: true, verdict: 'usable', kind: 'ok', short: `HTTP ${code} — the target answered`, why: '', fix: '' }
  }
  if (code === 401) {
    return { ...base, ok: true, verdict: 'usable', kind: 'ok', short: 'HTTP 401 — the target is alive (credentials required)',
      why: 'The probe sends no credentials, so 401 is the healthy answer from an API endpoint.',
      fix: 'Real calls need a valid key/header; the route itself is proven to work.' }
  }
  if (code === 403) {
    return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: 'HTTP 403 — the target refused the request',
      why: 'The server was reached but denies this client: key scope, IP allow-list, WAF, or a blocked probe User-Agent.',
      fix: 'Compare the other channel (direct vs proxy) and check the key/UA rules for this host.' }
  }
  if (code === 404) {
    return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: 'HTTP 404 — path not found',
      why: 'The route reached the server; that path does not exist there (probes often hit the bare origin).',
      fix: 'Re-test with the concrete path you really call; if that works, ignore this result.' }
  }
  if (code === 405 || code === 501) {
    return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: `HTTP ${code} — the endpoint does not accept HEAD`,
      why: 'The diagnostic probes with HEAD; some APIs and gateways only implement GET.',
      fix: 'The panel retries with GET automatically; a GET success means the host is usable.' }
  }
  if (code === 429) {
    return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: 'HTTP 429 — rate limited',
      why: 'The server is alive but throttling this client.',
      fix: 'Retry later or lower the request rate; the route itself is fine.' }
  }
  if (code === 502) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'gateway', short: 'HTTP 502 — bad gateway',
      why: 'An intermediary (the proxy or the target gateway) got an invalid answer from upstream — often the proxy cannot reach this host.',
      fix: 'Compare the other channel (direct vs proxy); if the proxy is the failing leg, keep this host on the working side of NO_PROXY.' }
  }
  if (code === 503) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'gateway', short: 'HTTP 503 — service unavailable',
      why: 'The target (or its gateway) is overloaded or in maintenance.',
      fix: 'Retry later; this is server-side and unrelated to the route.' }
  }
  if (code === 504) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'gateway', short: 'HTTP 504 — gateway/upstream timeout',
      why: 'The request was forwarded but nothing answered upstream in time: the target is slow or dead, or the proxy leg to it is broken.',
      fix: 'Compare the other channel (direct vs proxy) and retry; if only one channel times out, that channel is the problem.' }
  }
  if (code >= 500) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'server-error', short: `HTTP ${code} — the target failed`,
      why: 'The server answered with an error of its own; the route is fine.',
      fix: 'Retry later; nothing to change in the proxy configuration.' }
  }
  return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: `HTTP ${code} — request rejected`,
    why: 'The route works (an HTTP answer came back) but the request itself was not successful.',
    fix: 'Check the method, path and headers your real calls use.' }
}

/**
 * Turn a fetch rejection into an actionable verdict. A bare `fetch failed`
 * hides the real cause: a dispatcher built by one undici copy handed to another
 * rejects with UND_ERR_INVALID_ARG ("invalid onRequestStart method"), which is
 * how the forced-channel diagnostic failed for both channels (LESSONS §22).
 *
 * @param error - the rejection from `fetch`.
 * @returns `{ ok, verdict, kind, short, why, fix }` with a cause-aware message.
 */
export function classifyTargetFailure(error) {
  const cause = error?.cause
  const code = cause?.code ?? error?.code ?? ''
  const message = String(error?.message ?? error)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: `DNS lookup failed (${code})`,
      why: 'The hostname did not resolve — a wrong name/DNS, or a proxy that cannot resolve it.',
      fix: 'Check the hostname; if this host must go through the proxy, remove it from NO_PROXY (or add it if it must go direct).' }
  }
  if (code === 'ECONNREFUSED') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: 'connection refused (ECONNREFUSED)',
      why: 'Something answered but refused the connection: nothing listens on that port, or the proxy is not accepting.',
      fix: 'Check the port and that the proxy is running; compare the other channel.' }
  }
  if (code === 'EACCES' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: `cannot reach directly (${code}) — needs a proxy route`,
      why: 'The network path itself is unavailable from this machine.',
      fix: 'Route this host through the proxy (remove the NO_PROXY entry) and retry.' }
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ABORT_ERR' || error?.name === 'AbortError') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: `no answer before the timeout (${code || error?.name || 'timeout'})`,
      why: 'Nothing answered in time — a slow/dead target, or a proxy that silently drops this destination.',
      fix: 'Compare the other channel (direct vs proxy) and retry; if only one channel times out, that channel is the problem.' }
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: `connection reset (${code})`,
      why: 'The connection was cut mid-flight by an intermediary or a TLS problem (corporate interception, MTU, or a reset by the far end).',
      fix: 'Retry; compare the other channel; if TLS interception is in play, confirm the corporate CA is trusted (NODE_EXTRA_CA_CERTS).' }
  }
  if (code === 'UND_ERR_INVALID_ARG' || /invalid onRequestStart/i.test(String(cause?.message ?? ''))) {
    return { ok: false, verdict: 'unusable', kind: 'dispatcher', short: `dispatcher rejected by this undici instance (${code || 'UND_ERR_INVALID_ARG'}) — mixed undici copies`,
      why: 'The request and its dispatcher came from two different undici copies; the diagnostic had this bug (fixed in 1.0.2).',
      fix: 'Update the plugin; if it persists, report the plugin version with this message.' }
  }
  if (/407|NTLM|authentication required/i.test(message)) {
    return { ok: false, verdict: 'unusable', kind: 'auth', short: 'the proxy asks for NTLM authentication',
      why: 'The proxy demands NTLM, which undici cannot negotiate by itself.',
      fix: 'Run one curl/browser request through the same proxy to open an authenticated window, then retry.' }
  }
  const detail = cause?.code
    ? `${cause.code}${cause?.message ? `: ${String(cause.message).slice(0, 90)}` : ''}`
    : (cause?.message ?? '')
  return { ok: false, verdict: 'unusable', kind: 'other', short: (detail ? `${message} (${detail})` : message).slice(0, 180),
    why: 'The request failed for a reason the probe could not classify.',
    fix: 'Compare the other channel (direct vs proxy) and retry; check proxy_status for the effective route.' }
}
