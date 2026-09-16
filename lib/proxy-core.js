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
  return url.toString().replace(/\/$/, '')
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
  return a.enabled === b.enabled && (a.url ?? null) === (b.url ?? null) && (a.override ?? '') === (b.override ?? '')
}

/**
 * Decide the effective proxy from config plus (mode 'system') live facts.
 * @param {object} config - `{ enabled, mode, customUrl, noProxy }`.
 * @param {object|null} systemProxy - reader output for mode 'system'.
 */
export function resolveProxyState(config, systemProxy = null) {
  const noProxy = composeNoProxy(config?.noProxy)
  if (config?.enabled !== true || config?.mode === 'none') {
    return { active: false, url: null, http: null, https: null, noProxy, reason: config?.mode === 'none' ? 'mode-none' : 'disabled' }
  }
  if (config?.mode === 'custom') {
    const url = normalizeProxyUrl(config?.customUrl)
    if (url === null) {
      return { active: false, url: null, http: null, https: null, noProxy, reason: 'invalid-custom-url' }
    }
    return { active: true, url, http: url, https: url, noProxy, reason: 'custom' }
  }
  // mode === 'system'
  if (systemProxy?.enabled !== true || systemProxy.url === null) {
    return { active: false, url: null, http: null, https: null, noProxy, reason: 'system-proxy-off' }
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
 */
export function keepaliveHint(message = '') {
  const text = typeof message === 'string' ? message : ''
  return /407|NTLM|proxy authentication|authentication required/i.test(text)
    ? 'This proxy asks for NTLM authentication, which undici cannot negotiate by itself. A recent curl/browser connection to the same proxy keeps an authenticated window open — run a `curl` through the proxy (e.g. `curl -x http://proxyhk.huawei.com:8080 -I https://github.com`) once, then retry.'
    : ''
}