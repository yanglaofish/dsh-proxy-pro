import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolveCompilerModule } from './helpers/tools-runtime.mjs'
import { probes } from './helpers/probe-transport.mjs'

// 真实插件及宿主校验器，只隔离注册表、代理安装和网络边界。
const dependencies = new URL('./helpers/host-dependencies.mjs', import.meta.url).href
const network = new URL('./helpers/probe-transport.mjs', import.meta.url).href
const modulePath = resolveCompilerModule()

test('四个工具的实际返回值通过 DSH 严格输出校验', { skip: !modulePath && '请安装测试运行时或设置 DSH_TOOLS_MODULE' }, async (t) => {
  const { valueSchemaSpecToJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(modulePath).href)
  assert.equal(typeof validateJsonSchemaValue, 'function', '需要包含严格输出校验器的新版 dsh-tools')
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'undici') return { url: network, shortCircuit: true }
      if (['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-http-proxy', 'node:child_process'].includes(specifier)) {
        return { url: dependencies, shortCircuit: true }
      }
      return next(specifier, context)
    },
  })
  t.after(() => hooks.deregister())
  const { apply } = await import('../lib/index.js')
  const config = { enabled: true, mode: 'custom', customUrl: 'http://proxy.example:8080',
    noProxy: 'localhost', systemPollMs: 0 }
  const tools = new Map(), effects = []
  t.after(async () => { for (const cleanup of effects.reverse()) await cleanup?.() })
  const settings = { update: async (_id, patch) => Object.assign(config, patch) }
  await apply({
    fiber: { entry: { options: { id: 'dsh-proxy-pro' } } },
    get: (name) => name === 'settings' ? settings : undefined,
    on() {}, emit() {}, logger: { warn() {}, info() {} },
    effect: (setup) => effects.push(setup()),
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: { section() {} },
  }, config)

  async function execute(name, args) {
    const tool = tools.get(name), value = await tool.execute(args)
    const schema = valueSchemaSpecToJsonSchema(tool.output.schema)
    assert.deepEqual(validateJsonSchemaValue(schema, value), [], `${name} 返回值必须符合输出声明`)
    assert.ok(tool.output.render(args, value)[0].text.length > 0)
    return { value, schema }
  }
  for (const [name, args] of [
    ['proxy_status', {}], ['proxy_set', { enabled: false }],
    ['proxy_config', {}], ['proxy_config', { enabled: true }],
  ]) await execute(name, args)

  const failure = (code) => new Error('fetch failed', { cause: { code } })
  for (const [label, proxy, direct, verdict] of [
    ['双通道成功', 200, 200, 'both-ok'],
    ['仅代理可达', 200, failure('ENETUNREACH'), 'proxy-only'],
    ['仅直连可达', failure('ECONNREFUSED'), 200, 'direct-only'],
    ['代理要求认证', 407, 200, 'direct-only-auth'],
    ['目标拒绝访问', 403, 403, 'both-reached'],
    ['HEAD 与 GET 都无此路径', 404, 404, 'both-reached'],
    ['双通道网关失败', 502, 504, 'both-bad'],
    ['双通道 DNS 失败', failure('ENOTFOUND'), failure('ENOTFOUND'), 'both-bad'],
  ]) {
    await t.test(label, async () => {
      Object.assign(probes, { proxy, direct, calls: [] })
      const { value, schema } = await execute('proxy_test', { url: 'https://example.test/check' })
      assert.equal(value.verdict, verdict)
      assert.equal(value.channel, 'dual')
      assert.equal(new Set(probes.calls.map((call) => call.channel)).size, 2)
      assert.equal(typeof value.proxyBadge.text, 'string')
      assert.equal(typeof value.directBadge.text, 'string')
      assert.ok(['ok', 'warn', 'bad'].includes(value.proxyBadge.tone))
      assert.ok(['ok', 'warn', 'bad'].includes(value.directBadge.tone))
      // 保留严格边界，不能通过放开未知字段来掩盖声明遗漏。
      assert.ok(validateJsonSchemaValue(schema, { ...value, undeclared: true }).length > 0)
      assert.ok(validateJsonSchemaValue(schema, { ...value, proxyBadge: { text: 'x', tone: 'unknown' } }).length > 0)
      assert.ok(validateJsonSchemaValue(schema, { ...value, directBadge: { tone: 'ok' } }).length > 0)
    })
  }
  await t.test('关闭代理仍返回双通道报告', async () => {
    await execute('proxy_set', { enabled: false })
    Object.assign(probes, { direct: 200, calls: [] })
    const { value } = await execute('proxy_test', { url: 'https://example.test/check' })
    assert.equal(value.proxy.kind, 'bad-proxy')
    assert.equal(value.verdict, 'direct-only')
    assert.equal(probes.calls.length, 1)
  })
  await t.test('无效 URL 的提前返回不要求存在通道徽标', async () => {
    const { value } = await execute('proxy_test', { url: 'not a url' })
    assert.equal(value.route, 'invalid')
    assert.equal(value.verdict, 'both-bad')
  })
})
