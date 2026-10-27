// 仅在隔离子进程内装载真实桌面依赖；不启动或修改用户的 profile。
const { createRequire, registerHooks } = require('node:module')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const [runtimeRoot, proxyPort, directPort, label] = process.argv.slice(2)
const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'))
let resolvingRuntime = false
registerHooks({
  resolve(specifier, context, next) {
    if (!resolvingRuntime && (specifier.startsWith('@deepseek-ai/') || specifier === 'undici')) {
      let resolved
      try {
        resolvingRuntime = true
        resolved = runtimeRequire.resolve(specifier)
      } finally { resolvingRuntime = false }
      return { url: pathToFileURL(resolved).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})
const plugin = require('../lib/index.js')
const schemas = require('../lib/tool-schemas.js')
const compiler = runtimeRequire('@deepseek-ai/dsh-tools')
const { fetch: runtimeFetch } = runtimeRequire('undici')
const { Context } = runtimeRequire('@deepseek-ai/cordis')
const { HostConnectionService } = runtimeRequire('@deepseek-ai/dsh-client-connection')
const admissionContext = new Context()
admissionContext.provide('webServer', { host: '192.168.51.116', protocol: 'http:' })
let authenticated = true
// 凭据签名验证以固定值代替，准入逻辑使用真实宿主实现。
const connection = new HostConnectionService(admissionContext, ['dsh.example.com:3003'], {
  isAuthenticated: () => authenticated, authenticateApi: () => undefined,
})
for (const schema of [schemas.PROXY_SET_PARAMETERS, schemas.PROXY_CONFIG_PARAMETERS, schemas.PROXY_TEST_PARAMETERS]) {
  compiler.parameterSchemaSpecToJsonSchema(schema)
}
for (const schema of [schemas.PROXY_STATUS_SCHEMA, schemas.PROXY_TEST_SCHEMA]) {
  compiler.valueSchemaSpecToJsonSchema(schema)
}
const config = { enabled: true, mode: 'custom', customUrl: `http://${label}:smoke-password@127.0.0.1:${proxyPort}`,
  noProxy: 'localhost,127.0.0.1,::1', systemPollMs: 0 }
const tools = new Map(), effects = [], routes = []
const webServer = { register(route) { routes.push(route); return () => {} } }
const settings = { update: async (_id, patch) => { Object.assign(config, patch) } }
const ctx = {
  fiber: { entry: { options: { id: 'dsh-proxy-pro' } } },
  get: (name) => ({ settings, connection, webServer })[name],
  on() {}, emit() {}, logger: { warn: console.error, info() {} },
  effect: (setup) => effects.push(setup()),
  tools: { register: (tool) => tools.set(tool.name, tool) },
  systemPrompt: { section() {} },
}
async function probe() {
  // 同时验证普通工具常用的原生 fetch 和插件诊断使用的宿主 undici。
  for (const request of [fetch, runtimeFetch]) {
    const proxy = await request('http://proxy-smoke.invalid/check', { signal: AbortSignal.timeout(5000) })
      .catch((error) => { throw new Error(`${label} 代理请求失败：${error.message}`) })
    assert.equal(await proxy.text(), `proxied:${label}`)
  }
  const direct = await runtimeFetch(`http://127.0.0.1:${directPort}/check`, { signal: AbortSignal.timeout(5000) })
    .catch((error) => { throw new Error(`${label} 直连请求失败：${error.message}`) })
  assert.equal(await direct.text(), 'direct')
}
async function probePanel() {
  async function request(headers, expected) {
    let status
    await routes[0].handler({ method: 'GET', url: '/dsh-proxy-pro/api/config', headers }, {
      writeHead(code) { status = code }, end() {},
    })
    assert.equal(status, expected, JSON.stringify(headers))
  }
  const remote = { host: 'dsh.example.com:3003', origin: 'https://dsh.example.com:3003' }
  await request(remote, 200)
  await request({ host: 'dsh.example.com:3004' }, 403)
  await request({ ...remote, 'sec-fetch-site': 'cross-site' }, 403)
  await request({ ...remote, origin: 'https://evil.example' }, 403)
  authenticated = false
  await request(remote, 401)
  await request({ host: 'localhost:3080' }, 401)
  authenticated = true
}
process.on('message', async (message) => {
  try {
    if (message === 'off') {
      await tools.get('proxy_set').execute({ enabled: false })
      assert.equal(process.env.HTTP_PROXY, undefined)
      process.send({ event: 'off' })
    } else if (message === 'probe') {
      await probe()
      process.send({ event: 'probe' })
    } else if (message === 'quit') {
      for (const cleanup of effects.reverse()) await cleanup?.()
      process.exit(0)
    }
  } catch (error) {
    process.send({ event: 'error', message: error.message })
    process.exit(1)
  }
})
;(async () => {
  await plugin.apply(ctx, config)
  assert.equal(process.env.HTTP_PROXY, config.customUrl)
  assert.equal(runtimeRequire('@deepseek-ai/dsh-http-proxy').proxyRouteFor(new URL('http://proxy-smoke.invalid/check')).proxied, true)
  // 不先查状态：首个真实请求就必须已经走代理。
  await probe()
  await probePanel()
  const status = await tools.get('proxy_status').execute({})
  assert.ok(!JSON.stringify(status).includes('smoke-password'))
  process.send({ event: 'ready' })
})().catch((error) => {
  process.send({ event: 'error', message: error.message })
  process.exit(1)
})
