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
 * NTLM keepalive 提示：SWG 类代理（netentsec 等）向 undici 索要 NTLM 认证，
 * undici 无法协商；curl/浏览器最近一次经过同一代理的连接会保持一段已认证
 * 窗口。仅在看到 407 或认证相关应答时才有意义。示例 URL 由调用方传入
 * （生效代理地址），绝不硬编码——固定样例曾把开发者自己的公司代理泄漏进
 * 每一条提示里。
 */
export function keepaliveHint(message = '', proxyUrl = '') {
  const text = typeof message === 'string' ? message : ''
  if (!/407|NTLM|proxy authentication|authentication required/i.test(text)) return ''
  const example = typeof proxyUrl === 'string' && proxyUrl !== '' ? proxyUrl : 'http://localhost:7890'
  return `该代理要求 NTLM 认证，undici 无法自行协商。最近一次 curl/浏览器到同一代理的连接会保持一段已认证窗口——先执行一次 \`curl -x ${example} -I https://github.com\`，然后重试。`
}

/**
 * 单个 HTTP 应答的三态判定，供面板、`proxy_test` 与 HTTP API 共用：
 *
 *  - `usable`   — 真实调用可用（2xx/3xx，以及 401：健康的 API 端点对
 *                 不带凭证的探测就该回 401）。
 *  - `degraded` — 拿到了 HTTP 应答（路由通），但这次调用多半会失败
 *                 （403/404/405/429 等 4xx）。
 *  - `unusable` — 路由或对端失败（407 认证墙、目标 5xx、网关/上游超时）。
 *
 * 每个结论都带 `why`（可能原因）与 `fix`（挽救措施），让诊断直接可行动，
 * 而不是丢一个状态码（2026-09-17：504 曾与 200 一样显示成「可达」）。
 *
 * @param status - 探测收到的 HTTP 状态码。
 * @returns `{ ok, verdict, kind, status, short, why, fix }`（中文文案）。
 */
/**
 * HEAD 结论不可信、必须换 GET 复测的状态码。
 *
 * 405/501 是服务器明说「不支持该方法」；**404 同样是陷阱**：很多网关不给
 * HEAD 注册路由，对 HEAD 一律回 404，而同一路径 GET 会正常回 401/200 ——
 * 实测 DashScope：`HEAD /compatible-mode/v1/models` → 404，同路径 GET → 401
 * （2026-09-18 用户报「测什么都 404」时定位）。不复测就会把健康端点误判成
 * 「路径不存在」。
 *
 * @param status - HEAD 探测收到的状态码。
 * @returns 是否需要用 GET 复测。
 */
export function headNeedsGetRetry(status) {
  const code = Number(status)
  return code === 404 || code === 405 || code === 501
}

export function classifyProbeStatus(status) {
  const code = Number(status)
  const base = { status: code }
  if (code === 407) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'auth', short: 'HTTP 407 — 代理要求 NTLM 认证',
      why: '请求根本没到目标：代理拦下并索要 NTLM 认证，undici 无法协商。',
      fix: '先用 curl/浏览器走同一代理过一次（如 curl -x <代理> -I https://github.com）打开认证窗口，再重试。' }
  }
  if (code >= 200 && code < 400) {
    return { ...base, ok: true, verdict: 'usable', kind: 'ok', short: `HTTP ${code} — 目标正常响应`, why: '', fix: '' }
  }
  if (code === 401) {
    return { ...base, ok: true, verdict: 'usable', kind: 'ok', short: 'HTTP 401 — 目标存活（需要凭证）',
      why: '探测不带凭证，所以 401 是健康 API 端点的正常应答。',
      fix: '真实调用需要有效 key/请求头；这条结果已经证明路由可用。' }
  }
  if (code === 403) {
    return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: 'HTTP 403 — 目标拒绝了请求',
      why: '已到达服务器但被拒绝：key 权限、IP 白名单、WAF，或探测 UA 被挡。',
      fix: '对比直连/代理两侧，并检查该主机的 key/UA 规则。' }
  }
  if (code === 404) {
    return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: 'HTTP 404 — 路径不存在',
      why: 'HEAD 与 GET 都拿到了 404：路由已到服务器，但该路径确实没有资源（探测常打根路径或裸前缀）。',
      fix: '改用真实调用的完整端点复测（如 .../models、.../chat/completions）；那里有响应就说明主机可用。' }
  }
  if (code === 405 || code === 501) {
    return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: `HTTP ${code} — 端点不支持 HEAD`,
      why: '诊断用 HEAD 探测，有些 API/网关只实现 GET。',
      fix: '面板已自动换 GET 复测；GET 成功即主机可用。' }
  }
  if (code === 429) {
    return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: 'HTTP 429 — 被限流',
      why: '服务器活着但在限流。',
      fix: '稍后重试或降低请求频率；路由本身没问题。' }
  }
  if (code === 502) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'gateway', short: 'HTTP 502 — 网关错误（bad gateway）',
      why: '中间环节（代理或目标网关）拿到无效上游响应——常见是代理连不上该主机。',
      fix: '对比直连/代理两侧；若失败在代理侧，把该主机保留在 NO_PROXY 的另一边。' }
  }
  if (code === 503) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'gateway', short: 'HTTP 503 — 服务不可用',
      why: '目标（或其网关）过载或维护中。',
      fix: '稍后重试；这是服务端问题，与路由无关。' }
  }
  if (code === 504) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'gateway', short: 'HTTP 504 — 网关/上游超时',
      why: '请求已转发但上游迟迟无响应：目标慢或挂了，或代理到目标这一段坏了。',
      fix: '对比直连/代理两侧并重试；只有某一侧超时，问题就在那一侧。' }
  }
  if (code >= 500) {
    return { ...base, ok: false, verdict: 'unusable', kind: 'server-error', short: `HTTP ${code} — 目标服务端错误`,
      why: '服务器自身报错；路由没问题。',
      fix: '稍后重试；无需改动代理配置。' }
  }
  return { ...base, ok: false, verdict: 'degraded', kind: 'http-error', short: `HTTP ${code} — 请求被拒绝`,
    why: '路由通（拿到了 HTTP 应答），但这次请求本身不成功。',
    fix: '检查真实调用用的方法、路径和请求头。' }
}

/**
 * 把 fetch 的拒绝转成可行动的结论。裸的 `fetch failed` 掩盖了真正原因：
 * 一份 undici 造的 dispatcher 交给另一份使用时，会抛 UND_ERR_INVALID_ARG
 * （"invalid onRequestStart method"）——1.0.2 之前强制通道诊断两个方向都
 * 死在这里（LESSONS §22）；1.0.4 又发现策略通道也在混两份副本
 * （LESSONS §25）。把 cause code 亮出来，下一次报告就能指名道姓。
 *
 * @param error - `fetch` 抛出的拒绝。
 * @returns 带 cause 信息的 `{ ok, verdict, kind, short, why, fix }`（中文文案）。
 */
export function classifyTargetFailure(error) {
  const cause = error?.cause
  const code = cause?.code ?? error?.code ?? ''
  const message = String(error?.message ?? error)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: `DNS 解析失败（${code}）`,
      why: '主机名没解析出来——名字/DNS 错，或代理无法解析它。',
      fix: '检查主机名；该主机若必须走代理，把它移出 NO_PROXY（反之加进去）。' }
  }
  if (code === 'ECONNREFUSED') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: '连接被拒绝（ECONNREFUSED）',
      why: '有东西应答但拒绝连接：端口无人监听，或代理不在接受连接。',
      fix: '检查端口与代理是否在运行；对比另一侧通道。' }
  }
  if (code === 'EACCES' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: `直连不可达（${code}）—需要走代理`,
      why: '本机到目标的网络路径本身不可用。',
      fix: '让该主机走代理（从 NO_PROXY 移除）再重试。' }
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ABORT_ERR' || error?.name === 'AbortError') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: `超时前无应答（${code || error?.name || 'timeout'}）`,
      why: '到时间没应答——目标慢/挂，或代理静默丢弃该目标。',
      fix: '对比直连/代理两侧并重试；只有某一侧超时，问题就在那一侧。' }
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') {
    return { ok: false, verdict: 'unusable', kind: 'unreachable', short: `连接被重置（${code}）`,
      why: '连接中途被切断——中间设备或 TLS 问题（公司拦截、MTU、对端重置）。',
      fix: '重试并对比另一侧；若有 TLS 拦截，确认公司 CA 已被信任（NODE_EXTRA_CA_CERTS）。' }
  }
  if (code === 'UND_ERR_INVALID_ARG' || /invalid onRequestStart/i.test(String(cause?.message ?? ''))) {
    return { ok: false, verdict: 'unusable', kind: 'dispatcher', short: `dispatcher 被当前 undici 副本拒绝（${code || 'UND_ERR_INVALID_ARG'}）—两份副本混用`,
      why: '请求和它的 dispatcher 来自两份不同的 undici 副本；1.0.2 修过强制通道，1.0.4 修策略通道。',
      fix: '更新插件；若仍出现，把插件版本连同这条信息一起反馈。' }
  }
  if (/407|NTLM|authentication required/i.test(message)) {
    return { ok: false, verdict: 'unusable', kind: 'auth', short: '代理要求 NTLM 认证',
      why: '代理索要 NTLM，undici 无法单独完成协商。',
      fix: '先用 curl/浏览器走同一代理过一次（打开认证窗口），再重试。' }
  }
  const detail = cause?.code
    ? `${cause.code}${cause?.message ? `: ${String(cause.message).slice(0, 90)}` : ''}`
    : (cause?.message ?? '')
  return { ok: false, verdict: 'unusable', kind: 'other', short: (detail ? `${message}（${detail}）` : message).slice(0, 180),
    why: '请求失败，探测器无法归类原因。',
    fix: '对比直连/代理两侧并重试；用 proxy_status 查看生效路由。' }
}

/**
 * 单侧通道的徽章：按真实语义给色，杜绝"严重性误导"（LESSONS §32）。
 * - usable（2xx/3xx/401）→ 🟢 链路通 · 目标正常响应
 * - degraded（403/404/405/429 等被目标拒绝）→ 🟡 链路通 · 目标拒绝（…）
 * - 5xx（500/502/503/504 拿到应答但目标/网关报错）→ 🟡 链路通 · 目标/网关报错（…）
 * - 407 认证拦截 → 🔴 链路不通 · 代理要求认证
 * - 其他不可达（DNS/拒绝/超时/本地错误）→ 🔴 链路不通 · …
 * 关键区分：**只要拿到了 HTTP 应答（含 4xx/5xx）链路就是通的**，只有
 * 连接层失败（未拿到应答）才是"链路不通"。404 曾因 ok=false 被误标红色
 * 链路不通 → 截图"代理与直连均失败"误导（2026-09-18 用户实况）。
 */
function dualBadge(probe) {
  const detail = (s) => String(s ?? '').replace(/^HTTP \d+ — /, '')
  if (!probe) return { text: '结果未知', tone: 'warn' }
  if (probe.verdict === 'usable') return { text: '链路通 · 目标正常响应', tone: 'ok' }
  if (probe.verdict === 'degraded') {
    return { text: `链路通 · 目标拒绝（${detail(probe.short) || '请求被拒'}）`, tone: 'warn' }
  }
  if (probe.kind === 'gateway' || probe.kind === 'server-error') {
    return { text: `链路通 · 目标/网关报错（${detail(probe.short) || String(probe.status ?? '5xx')}）`, tone: 'warn' }
  }
  if (probe.kind === 'auth') return { text: '链路不通 · 代理要求认证', tone: 'bad' }
  return { text: `链路不通 · ${detail(probe.short) || '连接失败'}`, tone: 'bad' }
}

/**
 * 双通道综合判定：把「强制走代理」与「强制直连」两次探测合成为一份可给人
 * 看的结果：两条徽章（各自带 tone 色）+ 一条推荐。
 *
 * 三个概念分离（LESSONS §32 严重性误导修复）：
 * - 可达（reachable）：通道真正拿到了目标应答——usable 或 degraded（4xx）。
 *   5xx 属"链路通但目标/网关报错"（kind=gateway/server-error），不算可达
 *   也不算不通，徽章黄色；407/连接层失败才是"不通"。
 * - 健康（healthy）：usbale，目标给了正常应答。
 * - 徽章：由 dualBadge 按实际 verdict/kind 生成，绝不把 404/403 标红。
 *   只有连接层失败才标红"链路不通"。
 *
 * 单侧探针拿不到应答者身份，因此「代理策略拦截」只能靠两侧对比得到方向性
 * 结论（LESSONS §30：直连通+代理失败 → 问题在代理一侧；代理通+直连失败 →
 * 代理是唯一通路；都失败 → 环境/服务端问题；都通 → 保持现状）。
 *
 * @param proxyProbe - 强制走代理通道的探测结果（classify 输出形态）。
 * @param directProbe - 强制直连通道的探测结果。
 * @returns `{ verdict, short, why, fix, proxyBadge, directBadge }`，
 *   badge = { text, tone: 'ok'|'warn'|'bad' }。
 */
export function combineDualProbe(proxyProbe, directProbe) {
  const p = proxyProbe ?? {}
  const d = directProbe ?? {}
  const pReach = p.verdict === 'usable' || p.verdict === 'degraded'
  const dReach = d.verdict === 'usable' || d.verdict === 'degraded'
  const pOk = p.verdict === 'usable'
  const dOk = d.verdict === 'usable'
  const proxyAuth = p.kind === 'auth'
    || (p.verdict === 'unusable' && /NTLM|407/.test(String(p.short ?? '')))

  const notReachable = (probe, label) => {
    const detail = (probe?.short ?? '未知原因').replace(/^HTTP \d+ — /, '')
    return `${label}：${detail}`
  }

  // ① 都健康 → 都可以（保持现状）
  if (pOk && dOk) {
    return {
      verdict: 'both-ok',
      short: '代理与直连均通',
      why: '两条通道都拿到了正常应答，目标本身可用。',
      fix: '保持当前策略即可；无需改 NO_PROXY。',
      proxyBadge: { text: '链路通 · 目标正常响应', tone: 'ok' },
      directBadge: { text: '链路通 · 目标正常响应', tone: 'ok' },
    }
  }

  // ② 只有代理健康 → 走代理
  if (pOk && !dOk) {
    return {
      verdict: 'proxy-only',
      short: '只有走代理能通',
      why: `直连 ${notReachable(d, '失败')}；走代理正常——该目标在当前网络需经代理访问。`,
      fix: '确认该域名不在 NO_PROXY 直连名单里；保持代理开启。',
      proxyBadge: { text: '链路通 · 目标正常响应', tone: 'ok' },
      directBadge: dualBadge(d),
    }
  }

  // ③ 只有直连健康 → 问题在代理一侧（认证拦截 / 不可达 / 被目标拒绝）
  if (!pOk && dOk) {
    const pSide = proxyAuth
      ? '代理要求 NTLM 认证（407），请求没到目标'
      : p.verdict === 'degraded'
        ? '经代理已到达目标，但目标拒绝了这次请求（403/404/429 等）'
        : '经代理未能连接目标（可能是代理策略拦截、代理故障或链路异常）'
    const base = proxyAuth
      ? {
          why: '代理要求 NTLM 认证（407），而直连正常——该目标不值得绕代理。',
          fix: '该域名走代理会被认证卡住：把它加入 NO_PROXY 直连名单即可；无需打开认证窗口。',
        }
      : {
          why: `${pSide}；而直连正常——结论：该域名走直连更可靠。`,
          fix: p.verdict === 'degraded'
            ? '把该域名加入 NO_PROXY 直连名单即可绕开代理侧的目标拒绝；若确需走代理，检查 key/UA/权限。'
            : '先重试排除临时故障；仍失败则检查代理可用性或联系管理员。若确认是策略拦截，把该域名加入 NO_PROXY 直连名单。',
        }
    return {
      verdict: proxyAuth ? 'direct-only-auth' : 'direct-only',
      short: proxyAuth ? '直连可通 · 代理需认证' : (p.verdict === 'degraded' ? '直连可通 · 代理侧被目标拒绝' : '直连可通 · 代理被拦'),
      ...base,
      proxyBadge: dualBadge(p),
      directBadge: { text: '链路通 · 目标正常响应', tone: 'ok' },
    }
  }

  // ④ 都不健康但都可达（双 4xx：链路通，目标对探测路径有异常应答）
  if (pReach && dReach) {
    const pNote = notReachable(p, '代理').replace(/^失败：/, '代理：')
    const dNote = notReachable(d, '直连').replace(/^失败：/, '直连：')
    return {
      verdict: 'both-reached',
      short: '双链路通 · 目标应答异常',
      why: `两条通道都到达了目标，但目标返回异常状态：${pNote}；${dNote}。`,
      fix: '探测的是根路径/裸前缀，目标可能对 HEAD 或未授权请求如此应答——改用真实调用端点（如 /models、/chat/completions）复测，或检查该主机的 API Key。',
      proxyBadge: dualBadge(p),
      directBadge: dualBadge(d),
    }
  }

  // ⑤ 只有代理可达（哪怕 404/403，也是唯一通路）——修复重点：
  //    404 不再落入"双失败"，恢复为代理是唯一通路（腾讯 Copilot 实况）
  if (pReach && !dReach) {
    const pNote = p.verdict === 'usable' ? '正常响应' : notReachable(p, '请求被拒').replace(/^请求被拒：/, '')
    return {
      verdict: 'proxy-only',
      short: p.verdict === 'usable' ? '只有走代理能通' : '只有走代理可达 · 目标有异常应答',
      why: `直连 ${notReachable(d, '失败')}；经代理 ${pNote}——该域名在当前网络只有代理通道能到达目标。`,
      fix: p.verdict === 'usable'
        ? '确认该域名不在 NO_PROXY 直连名单里；保持代理开启。'
        : '走代理链路是通的，但目标返回异常（尝试换真实端点复测）；同时确认该域名不在 NO_PROXY 直连名单里。',
      proxyBadge: dualBadge(p),
      directBadge: dualBadge(d),
    }
  }

  // ⑥ 只有直连可达（代理侧 4xx/5xx 或不可达）
  if (dReach) {
    return {
      verdict: proxyAuth ? 'direct-only-auth' : 'direct-only',
      short: proxyAuth ? '直连可达 · 代理需认证' : (d.verdict === 'usable' ? '直连可通 · 代理被拦' : '直连可达 · 代理侧异常'),
      why: proxyAuth
        ? '代理要求 NTLM 认证（407），而直连正常——该目标不值得绕代理。'
        : `经代理 ${p.kind === 'gateway' || p.kind === 'server-error' ? '返回网关/服务端错误（链路本身通，问题在目标或中间网关）' : `失败（${notReachable(p, '').replace(/^：/, '')}）`}；直连 ${dOk ? '正常' : notReachable(d, '可达但目标异常')}。`,
      fix: proxyAuth
        ? '把该域名加入 NO_PROXY 直连名单即可。'
        : '建议该域名走直连（加入 NO_PROXY）；若代理侧是 4xx/5xx，也检查一下真实调用端点。',
      proxyBadge: dualBadge(p),
      directBadge: dualBadge(d),
    }
  }

  // ⑦ 都不可达（连接层失败）→ 环境/服务端问题
  return {
    verdict: 'both-bad',
    short: '代理与直连均失败',
    why: `两条通道都没能建立到目标的连接：代理 ${notReachable(p, '失败')}；直连 ${notReachable(d, '失败')}。`,
    fix: '是环境或服务端问题，与代理开关无关：检查网络/目标服务，或稍后重试。',
    proxyBadge: dualBadge(p),
    directBadge: dualBadge(d),
  }
}
