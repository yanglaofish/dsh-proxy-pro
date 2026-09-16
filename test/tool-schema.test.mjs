/**
 * Tool-schema guard: prove the three agent tools compile under the real
 * `@deepseek-ai/dsh-tools` author-schema DSL WITHOUT booting the app.
 *
 * Why this exists (docs/LESSONS.md §15): a schema-DSL violation is thrown by
 * `defineTool` during the plugin's `apply`, so the only feedback was
 * "plugin tree failed to load" after a full DSH restart — three restarts were
 * burned discovering `additionalProperties` and then `required: false`.
 * `defineTool` compiles exactly two things
 *   parameterSchemaSpecToJsonSchema(options.parameters)
 *   valueSchemaSpecToJsonSchema(options.output.schema)
 * and both are exported, so this test mirrors that pair locally.
 *
 * Two layers:
 *  1. always-on structural check that mirrors the compiler's vocabulary;
 *  2. a real-compiler compile, skipped with a diagnostic when the DSH
 *     installation cannot be located (set DSH_APP_ROOT or DSH_TOOLS_MODULE).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  PROXY_CONFIG_PARAMETERS,
  PROXY_SET_PARAMETERS,
  PROXY_STATUS_SCHEMA,
  PROXY_TEST_PARAMETERS,
  PROXY_TEST_SCHEMA,
} from '../lib/tool-schemas.js'

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const SCALARS = ['string', 'number', 'integer', 'boolean', 'null']

/** Mirror of the dsh-tools author-schema vocabulary (see compiler). */
function checkNode(node, where, allowRequired) {
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${where} must be a value schema object`)
  const base = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]
  if (Object.hasOwn(node, 'required')) {
    assert.equal(node.required, true, `${where}.required must be true when present`)
  }
  if (Object.hasOwn(node, 'oneOf')) {
    assert.ok(!Object.hasOwn(node, 'type'), `${where} cannot declare both type and oneOf`)
    assert.ok(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${where}.oneOf must be an array of at least two value schemas`)
    for (const key of Object.keys(node)) {
      assert.ok([...base, 'oneOf', 'type'].includes(key), `${where}.${key} is not supported by the value schema DSL`)
    }
    node.oneOf.forEach((branch, index) => checkNode(branch, `${where}.oneOf[${index}]`, false))
    return
  }
  assert.ok(Object.hasOwn(node, 'type'), `${where}.type is required`)
  const type = node.type
  let allowed
  if (type === 'object') {
    allowed = [...base, 'type', 'properties', 'additionalProperties']
    assert.equal(typeof node.additionalProperties, 'boolean', `${where}.additionalProperties must be explicitly true or false`)
    if (Object.hasOwn(node, 'properties')) checkPropertyMap(node.properties, `${where}.properties`)
  } else if (type === 'array') {
    allowed = [...base, 'type', 'items']
    if (Object.hasOwn(node, 'items')) checkNode(node.items, `${where}.items`, false)
  } else if (type === 'json') {
    allowed = [...base, 'type']
  } else {
    assert.ok(SCALARS.includes(type), `${where}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
    allowed = [...base, 'type', 'enum', 'const']
  }
  for (const key of Object.keys(node)) {
    assert.ok(allowed.includes(key), `${where}.${key} is not supported by the value schema DSL`)
  }
}

/** A parameter map / object property map: every value is a property node. */
function checkPropertyMap(map, where) {
  assert.ok(map !== null && typeof map === 'object' && !Array.isArray(map), `${where} must be an object of value schemas`)
  for (const [key, value] of Object.entries(map)) checkNode(value, `${where}.${key}`, true)
}

test('structural: proxy_status output schema', () => {
  checkNode(PROXY_STATUS_SCHEMA, 'schema', false)
})

test('structural: proxy_set parameters and output schema', () => {
  checkPropertyMap(PROXY_SET_PARAMETERS, 'parameters')
  checkNode(PROXY_STATUS_SCHEMA, 'schema', false)
})

test('structural: proxy_test parameters and output schema', () => {
  checkPropertyMap(PROXY_TEST_PARAMETERS, 'parameters')
  checkNode(PROXY_TEST_SCHEMA, 'schema', false)
})

test('structural: the empty proxy_status parameter map is a legal property map', () => {
  checkPropertyMap({}, 'parameters')
})

test('structural: proxy_config parameters are all optional and use a mode enum', () => {
  checkPropertyMap(PROXY_CONFIG_PARAMETERS, 'parameters')
  for (const [key, value] of Object.entries(PROXY_CONFIG_PARAMETERS)) {
    assert.ok(!Object.hasOwn(value, 'required'), `parameters.${key} must stay optional (omit required)`)
  }
  assert.deepEqual(PROXY_CONFIG_PARAMETERS.mode.enum, ['system', 'custom'])
})

/** Locate the real dsh-tools module in a DSH installation. */
function resolveCompilerModule() {
  const candidates = [
    process.env.DSH_TOOLS_MODULE,
    process.env.DSH_APP_ROOT === undefined
      ? undefined
      : path.join(process.env.DSH_APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  return candidates.find((candidate) => existsSync(candidate))
}

test('real compiler: every tool schema compiles exactly as defineTool would', async (t) => {
  const modulePath = resolveCompilerModule()
  if (modulePath === undefined) {
    t.diagnostic('dsh-tools not found — structural checks only (set DSH_APP_ROOT or DSH_TOOLS_MODULE to enable)')
    return
  }
  const tools = await import(pathToFileURL(modulePath).href)
  assert.equal(typeof tools.parameterSchemaSpecToJsonSchema, 'function', 'parameterSchemaSpecToJsonSchema export missing')
  assert.equal(typeof tools.valueSchemaSpecToJsonSchema, 'function', 'valueSchemaSpecToJsonSchema export missing')
  // Exactly the pair defineTool() compiles for each of our three tools.
  tools.parameterSchemaSpecToJsonSchema({})
  tools.parameterSchemaSpecToJsonSchema(PROXY_SET_PARAMETERS)
  tools.parameterSchemaSpecToJsonSchema(PROXY_TEST_PARAMETERS)
  tools.parameterSchemaSpecToJsonSchema(PROXY_CONFIG_PARAMETERS)
  tools.valueSchemaSpecToJsonSchema(PROXY_STATUS_SCHEMA)
  tools.valueSchemaSpecToJsonSchema(PROXY_TEST_SCHEMA)
  t.diagnostic(`compiled against ${modulePath}`)
})
