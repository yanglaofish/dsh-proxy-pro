/**
 * Unit tests for lib/proxy-core.js — the dependency-free pure logic layer.
 * Run with `npm test` (node --test) — no DSH/runtime required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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

test('keepaliveHint only fires on 407/NTLM signals', () => {
  assert.ok(keepaliveHint('407 Proxy Authentication Required').length > 0)
  assert.ok(keepaliveHint('ECONNREFUSED').length === 0)
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