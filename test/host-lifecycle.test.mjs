import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { transport, resetTransport } from './helpers/host-dependencies.mjs'

// 仅替换外部服务边界，不复制或改写插件实现。
const dependencies = new URL('./helpers/host-dependencies.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-http-proxy', 'node:child_process'].includes(specifier)) {
      return { url: dependencies, shortCircuit: true }
    }
    return next(specifier, context)
  },
})
let apply
try { ({ apply } = await import('../lib/index.js')) } finally { hooks.deregister() }

function harness(t, overrides = {}, authority = '127.0.0.1:3080') {
  resetTransport()
  const config = { enabled: true, mode: 'custom', customUrl: 'http://user:test-password@proxy.example:8080',
    noProxy: 'localhost,*.intranet.example', systemPollMs: 0, ...overrides }
  const tools = new Map(), sections = [], effects = [], routes = [], writes = []
  const settings = { update: async (_id, patch) => { writes.push(patch); Object.assign(config, patch) } }
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const services = { settings, webServer }
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-proxy-pro' } } },
    get: (name) => services[name],
    on() {}, emit() {}, logger: { warn() {}, info() {} },
    effect: (setup) => { effects.push(setup()) },
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    systemPrompt: { section: (section) => { sections.push(section) } },
  }
  t.after(async () => { for (const cleanup of effects.reverse()) await cleanup?.() })
  async function request(method, path, headers = {}, body = {}) {
    const req = { method, url: `/dsh-proxy-pro/api${path}`, headers: { host: authority, ...headers },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
    const response = { status: 0, body: '', writeHead(code) { this.status = code }, end(text) { this.body = text } }
    await routes[0].handler(req, response)
    return response
  }
  return { config, tools, sections, writes, services, request, start: () => apply(ctx, config) }
}

test('启动即应用已开启的自定义代理，连接参数保留认证和内网直连名单', async (t) => {
  const h = harness(t)
  await h.start()
  assert.equal(transport.installs.length, 1)
  assert.equal(transport.installs[0].HTTP_PROXY, h.config.customUrl)
  assert.equal(transport.installs[0].HTTPS_PROXY, h.config.customUrl)
  assert.ok(transport.installs[0].NO_PROXY.includes('*.intranet.example'))
})

test('关闭状态启动不改写传输，但状态提示已完成初始化', async (t) => {
  const h = harness(t, { enabled: false })
  await h.start()
  assert.equal(transport.installs.length, 0)
  assert.match(h.sections[0].text(), /OFF/)
})

test('系统模式启动保留分协议代理和 Windows 内网直连项', async (t) => {
  const h = harness(t, { mode: 'system' })
  await h.start()
  assert.equal(transport.installs.length, 1)
  assert.equal(transport.installs[0].HTTP_PROXY, 'http://proxy.example:8080')
  assert.equal(transport.installs[0].HTTPS_PROXY, 'http://secure-proxy.example:8443')
  assert.ok(transport.installs[0].NO_PROXY.includes('*.intranet.example'))
})

test('模型状态和系统提示不泄漏代理认证，编辑表单仍能保留原始配置', async (t) => {
  const h = harness(t)
  await h.start()
  const status = await h.tools.get('proxy_status').execute()
  assert.ok(!JSON.stringify(status).includes('test-password'))
  assert.ok(!h.sections[0].text().includes('test-password'))
  const form = JSON.parse((await h.request('GET', '/config')).body)
  assert.equal(form.config.customUrl, h.config.customUrl)
  assert.equal(transport.installs.at(-1).HTTP_PROXY, h.config.customUrl)
})

test('不同端口的本地网页不能修改配置，桌面桥接的同源请求仍能写入', async (t) => {
  const h = harness(t, { enabled: false })
  await h.start()
  const denied = await h.request('POST', '/config', {
    origin: 'http://127.0.0.1:45678', 'sec-fetch-site': 'same-site',
  }, { noProxy: 'attacker.example' })
  assert.equal(denied.status, 403)
  assert.equal(h.writes.length, 0)
  const allowed = await h.request('POST', '/config', {
    origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin',
  }, { noProxy: '*.intranet.example' })
  assert.equal(allowed.status, 200)
  assert.equal(h.config.noProxy, '*.intranet.example')
  assert.equal((await h.request('GET', '/status')).status, 200)
})

test('双 profile 使用各自端口时都可访问，共用上游代理不放宽配置写权限', async (t) => {
  const desktop = harness(t, { enabled: false }, '127.0.0.1:3080')
  const development = harness(t, { enabled: false }, '127.0.0.1:3081')
  await desktop.start()
  await development.start()
  for (const [profile, ownPort, otherPort] of [[desktop, 3080, 3081], [development, 3081, 3080]]) {
    const own = await profile.request('POST', '/config', {
      origin: `http://127.0.0.1:${ownPort}`, 'sec-fetch-site': 'same-origin',
    }, { customUrl: 'http://shared-proxy.example:8080' })
    assert.equal(own.status, 200)
    const other = await profile.request('POST', '/config', {
      origin: `http://127.0.0.1:${otherPort}`, 'sec-fetch-site': 'same-site',
    }, { customUrl: 'http://unexpected.example:8080' })
    assert.equal(other.status, 403)
    assert.equal(profile.config.customUrl, 'http://shared-proxy.example:8080')
  }
})

test('面板按请求读取宿主 connection，可信域名可访问且未认证不能改配置', async (t) => {
  const h = harness(t, { enabled: false }, 'dsh.example.com:3003')
  await h.start()
  assert.equal((await h.request('GET', '/config')).status, 403)
  let calls = 0
  h.services.connection = { requestRejection(req) {
    calls++
    assert.equal(req.headers.host, 'dsh.example.com:3003')
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403
    if (req.headers.origin && req.headers.origin !== 'https://dsh.example.com:3003') return 403
    if (req.headers.cookie !== 'authenticated') return 401
  } }
  const headers = { cookie: 'authenticated', origin: 'https://dsh.example.com:3003' }
  assert.equal((await h.request('GET', '/config', headers)).status, 200)
  const denied = await h.request('POST', '/config', {}, { customUrl: 'http://attacker.example' })
  assert.equal(denied.status, 401)
  assert.equal(denied.body, 'unauthorized')
  assert.equal(h.writes.length, 0)
  assert.equal((await h.request('GET', '/config', { ...headers, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await h.request('GET', '/config', { ...headers, origin: 'https://evil.example' })).status, 403)
  assert.equal((await h.request('POST', '/config', headers, { noProxy: '*.internal' })).status, 200)
  assert.equal(h.config.noProxy, '*.internal')
  assert.equal(calls, 5)
})

test('宿主拒绝或校验异常时，loopback 请求也不能绕过认证读取配置', async (t) => {
  const h = harness(t, { enabled: false })
  await h.start()
  h.services.connection = { requestRejection: () => 401 }
  assert.equal((await h.request('GET', '/config')).status, 401)
  h.services.connection = {}
  assert.equal((await h.request('GET', '/config')).status, 403)
  h.services.connection = { requestRejection() { throw Error('宿主校验不可用') } }
  assert.equal((await h.request('POST', '/config', {}, { noProxy: 'unexpected' })).status, 403)
  assert.equal(h.writes.length, 0)
})
