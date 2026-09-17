/**
 * Unit tests for lib/proxy-core.js — the dependency-free pure logic layer.
 * Run with `npm test` (node --test) — no DSH/runtime required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyProbeStatus,
  classifyTargetFailure,
  composeNoProxy,
  keepaliveHint,
  makeSystemProxyReader,
  normalizeProxyUrl,
  parseOverrideEntries,
  parseProxyServer,
  parseRegDword,
  parseRegString,
  resolveProxyState,
  summarize,
  systemFactsEqual,
} from '../lib/proxy-core.js'

test('normalizeProxyUrl accepts bare host:port and http(s) URLs', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyUrl('http://proxy.example:8080/'), 'http://proxy.example:8080')
  assert.equal(normalizeProxyUrl('https://proxy.example:8443'), 'https://proxy.example:8443')
})

test('normalizeProxyUrl rejects junk and non-http protocols', () => {
  assert.equal(normalizeProxyUrl(''), null)
  assert.equal(normalizeProxyUrl('   '), null)
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), null)
  assert.equal(normalizeProxyUrl('ftp://x'), null)
  assert.equal(normalizeProxyUrl('not a url with spaces'), null)
})

test('parseProxyServer parses single host:port and per-scheme forms', () => {
  assert.deepEqual(parseProxyServer('proxyhk.huawei.com:8080'), {
    http: 'http://proxyhk.huawei.com:8080',
    https: 'http://proxyhk.huawei.com:8080',
  })
  assert.deepEqual(parseProxyServer('http=127.0.0.1:8080;https=127.0.0.1:8443'), {
    http: 'http://127.0.0.1:8080',
    https: 'http://127.0.0.1:8443',
  })
})

test('parseProxyServer ignores socks and rejects unusable input', () => {
  const socksOnly = parseProxyServer('socks=127.0.0.1:1080')
  assert.equal(socksOnly, null)
  assert.equal(parseProxyServer(''), null)
  assert.equal(parseProxyServer('http=not a url'), null)
})

test('parseRegDword / parseRegString decode `reg query` output lines', () => {
  assert.equal(parseRegDword('    ProxyEnable    REG_DWORD    0x1'), 1)
  assert.equal(parseRegDword('    ProxyEnable    REG_DWORD    0x0'), 0)
  assert.equal(parseRegDword('garbage'), undefined)
  assert.equal(parseRegString('    ProxyServer    REG_SZ    127.0.0.1:10808'), '127.0.0.1:10808')
  assert.equal(parseRegString('    ProxyOverride  REG_SZ    <local>;github.com'), '<local>;github.com')
})

test('composeNoProxy merges configured + override, locals always first', () => {
  assert.equal(composeNoProxy('', ''), 'localhost,127.0.0.1,::1')
  assert.equal(composeNoProxy('github.com,localhost', ''), 'localhost,127.0.0.1,::1,github.com')
  assert.equal(composeNoProxy('github.com', '<local>;api.example.com'), 'localhost,127.0.0.1,::1,github.com,api.example.com')
})

test('parseOverrideEntries turns a Windows ProxyOverride string into entries', () => {
  assert.deepEqual(parseOverrideEntries('<local>;api.example.com;*.cn'), ['localhost', '127.0.0.1', '::1', 'api.example.com', '*.cn'])
  assert.deepEqual(parseOverrideEntries(''), [])
})

test('resolveProxyState: disabled / mode-none are inactive', () => {
  assert.equal(resolveProxyState({ enabled: false, mode: 'system', customUrl: 'x', noProxy: '' }, null).active, false)
  const none = resolveProxyState({ enabled: true, mode: 'none', customUrl: '', noProxy: '' }, null)
  assert.equal(none.active, false)
  assert.equal(none.reason, 'mode-none')
})

test('resolveProxyState: system mode follows live facts', () => {
  const facts = { enabled: true, http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890', url: 'http://127.0.0.1:7890', override: '', serverLine: '' }
  const state = resolveProxyState({ enabled: true, mode: 'system', customUrl: '', noProxy: '' }, facts)
  assert.equal(state.active, true)
  assert.equal(state.url, 'http://127.0.0.1:7890')
})

test('resolveProxyState: system mode with proxy off reports its reason', () => {
  const state = resolveProxyState({ enabled: true, mode: 'system', customUrl: '', noProxy: '' }, { enabled: false, http: null, https: null, url: null, override: '', serverLine: '' })
  assert.equal(state.active, false)
  assert.equal(state.reason, 'system-proxy-off')
})

test('resolveProxyState: custom mode uses the custom address', () => {
  const state = resolveProxyState({ enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890', noProxy: '' }, null)
  assert.equal(state.active, true)
  assert.equal(state.url, 'http://127.0.0.1:7890')
})

test('resolveProxyState: invalid custom address is inactive with a reason', () => {
  const state = resolveProxyState({ enabled: true, mode: 'custom', customUrl: 'not a url', noProxy: '' }, null)
  assert.equal(state.active, false)
  assert.equal(state.reason, 'invalid-custom-url')
})

test('resolveProxyState: custom mode keeps only its own NO_PROXY (never the system override)', () => {
  const facts = { enabled: true, url: 'http://system:8080', http: 'http://system:8080', https: 'http://system:8080', override: '<local>;internal.corp', serverLine: '' }
  const state = resolveProxyState({ enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890', noProxy: '' }, facts)
  assert.equal(state.active, true)
  assert.equal(state.url, 'http://127.0.0.1:7890')
  assert.equal(state.noProxy, 'localhost,127.0.0.1,::1')
  assert.ok(!state.noProxy.includes('internal.corp'))
})

test('resolveProxyState: system mode merges the Windows ProxyOverride into NO_PROXY', () => {
  const facts = { enabled: true, url: 'http://system:8080', http: 'http://system:8080', https: 'http://system:8080', override: '<local>;internal.corp;*.cn', serverLine: '' }
  const state = resolveProxyState({ enabled: true, mode: 'system', customUrl: '', noProxy: '' }, facts)
  assert.equal(state.active, true)
  assert.equal(state.noProxy, 'localhost,127.0.0.1,::1,internal.corp,*.cn')
})

test('summarize exposes the fields the tools and API promise', () => {
  const snapshot = {
    config: { enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890', noProxy: '' },
    effective: { active: true, url: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890', noProxy: 'localhost', reason: null },
    systemProxy: null,
    at: '2026-09-17T00:00:00.000Z',
  }
  const s = summarize(snapshot)
  assert.equal(s.active, true)
  assert.equal(s.enabled, true)
  assert.equal(s.mode, 'custom')
  assert.equal(s.url, 'http://127.0.0.1:7890')
  assert.equal(s.source, 'custom')
  assert.ok(typeof s.at === 'string')
})

test('systemFactsEqual treats identical facts as equal', () => {
  const a = { enabled: true, url: 'http://x', http: 'http://x', https: 'http://x', override: '', serverLine: '' }
  const b = { enabled: true, url: 'http://x', http: 'http://x', https: 'http://x', override: '', serverLine: '' }
  const c = { enabled: false, url: null, http: null, https: null, override: '', serverLine: '' }
  assert.equal(systemFactsEqual(a, b), true)
  assert.equal(systemFactsEqual(a, c), false)
})

test('systemFactsEqual: http/https-only differences are unequal (drive re-sync + effKey rebuild)', () => {
  const base = { enabled: true, url: 'http://x:8080', http: 'http://x:8080', https: 'http://x:8080', override: '', serverLine: '' }
  const httpsChanged = { enabled: true, url: 'http://x:8080', http: 'http://x:8080', https: 'http://x:8443', override: '', serverLine: '' }
  const httpChanged = { enabled: true, url: 'http://y:8080', http: 'http://y:8080', https: 'http://x:8080', override: '', serverLine: '' }
  assert.equal(systemFactsEqual(base, httpsChanged), false)
  assert.equal(systemFactsEqual(base, httpChanged), false)
})

test('keepaliveHint only fires on 407/NTLM signals and uses the given proxy URL', () => {
  assert.ok(keepaliveHint('407 Proxy Authentication Required', 'http://127.0.0.1:7890').length > 0)
  assert.ok(keepaliveHint('ECONNREFUSED').length === 0)
})

test('keepaliveHint prefers the caller-provided proxy over a neutral placeholder', () => {
  const hint = keepaliveHint('407 Proxy Authentication Required', 'http://127.0.0.1:7890')
  assert.ok(hint.includes('http://127.0.0.1:7890'))
  const fallback = keepaliveHint('407 Proxy Authentication Required')
  assert.ok(fallback.includes('localhost'))
  assert.ok(!fallback.includes('proxyhk'))
})

test('makeSystemProxyReader queries reg via execFile', async () => {
  const calls = []
  const execFile = async (file, args) => {
    calls.push(args.join(' '))
    if (String(args).includes('ProxyEnable')) return { stdout: '\r\n    ProxyEnable    REG_DWORD    0x1\r\n\r\n' }
    throw new Error('no such value')
  }
  const reader = makeSystemProxyReader(execFile)
  const facts = await reader()
  assert.equal(facts.enabled, true)
  assert.ok(calls.length >= 3)
})

test('classifyTargetFailure names the connection code and stays actionable', () => {
  const dns = classifyTargetFailure({ cause: { code: 'ENOTFOUND' } })
  assert.equal(dns.kind, 'unreachable')
  assert.equal(dns.verdict, 'unusable')
  assert.match(dns.short, /ENOTFOUND/)
  assert.ok(dns.why.length > 0)
  assert.ok(dns.fix.length > 0)
  const refused = classifyTargetFailure({ cause: { code: 'ECONNREFUSED' } })
  assert.equal(refused.kind, 'unreachable')
  assert.match(refused.short, /ECONNREFUSED/)
})

test('classifyTargetFailure flags a mixed-undici dispatcher rejection', () => {
  const verdict = classifyTargetFailure({
    message: 'fetch failed',
    cause: { code: 'UND_ERR_INVALID_ARG', message: 'invalid onRequestStart method' },
  })
  assert.equal(verdict.kind, 'dispatcher')
  assert.match(verdict.short, /UND_ERR_INVALID_ARG/)
  assert.match(verdict.short, /混用/)
  // the message is enough even when the code is missing
  assert.equal(classifyTargetFailure({ cause: { message: 'invalid onRequestStart method' } }).kind, 'dispatcher')
})

test('classifyTargetFailure keeps the cause detail instead of a bare "fetch failed"', () => {
  const reset = classifyTargetFailure({ message: 'fetch failed', cause: { code: 'ECONNRESET', message: 'socket hang up' } })
  assert.equal(reset.kind, 'unreachable')
  assert.match(reset.short, /ECONNRESET/)
  const unknown = classifyTargetFailure({ message: 'fetch failed', cause: { code: 'EUNKNOWNCODE', message: 'mystery' } })
  assert.equal(unknown.kind, 'other')
  assert.match(unknown.short, /fetch failed/)
  assert.match(unknown.short, /EUNKNOWNCODE/)
})

test('classifyTargetFailure detects an NTLM proxy demand and probe aborts', () => {
  assert.equal(classifyTargetFailure({ message: 'HTTP 407 proxy authentication required' }).kind, 'auth')
  assert.equal(classifyTargetFailure({ message: 'HTTP 407 — the proxy asks for authentication' }).kind, 'auth')
  const timeout = classifyTargetFailure({ name: 'AbortError', message: 'This operation was aborted' })
  assert.equal(timeout.kind, 'unreachable')
  assert.match(timeout.short, /超时/)
})

test('classifyProbeStatus: 2xx/3xx and 401 are usable', () => {
  for (const code of [200, 204, 301, 302]) {
    const v = classifyProbeStatus(code)
    assert.equal(v.ok, true)
    assert.equal(v.verdict, 'usable')
    assert.equal(v.status, code)
    assert.equal(v.why, '')
    assert.equal(v.fix, '')
  }
  const auth = classifyProbeStatus(401)
  assert.equal(auth.ok, true)
  assert.equal(auth.verdict, 'usable')
  assert.match(auth.short, /401/)
})

test('classifyProbeStatus: 4xx is degraded with a cause and a fix', () => {
  for (const code of [403, 404, 405, 429, 418]) {
    const v = classifyProbeStatus(code)
    assert.equal(v.ok, false)
    assert.equal(v.verdict, 'degraded')
    assert.ok(v.why.length > 0, `why missing for ${code}`)
    assert.ok(v.fix.length > 0, `fix missing for ${code}`)
  }
  assert.match(classifyProbeStatus(405).short, /HEAD/)
  assert.match(classifyProbeStatus(404).short, /404/)
})

test('classifyProbeStatus: gateway and server errors are unusable, not "reachable"', () => {
  for (const code of [500, 502, 503, 504]) {
    const v = classifyProbeStatus(code)
    assert.equal(v.ok, false)
    assert.equal(v.verdict, 'unusable')
    assert.match(v.short, new RegExp(String(code)))
    assert.ok(v.why.length > 0 && v.fix.length > 0)
  }
  // the regression this classification exists for: 504 used to print as reachable
  const timeout = classifyProbeStatus(504)
  assert.equal(timeout.verdict, 'unusable')
  assert.match(timeout.why, /上游|超时/)
})

test('classifyProbeStatus: 407 is unusable and names the proxy auth wall', () => {
  const v = classifyProbeStatus(407)
  assert.equal(v.ok, false)
  assert.equal(v.verdict, 'unusable')
  assert.equal(v.kind, 'auth')
  assert.match(v.short, /407/)
  assert.match(v.fix, /curl/)
})