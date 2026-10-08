/**
 * Manifest compatibility guard.
 *
 * Why this exists (docs/LESSONS.md §33): dsh-app-boot's
 * `evaluatePluginCompatibility` checks every `@deepseek-ai/dsh*`
 * peerDependency range against the RUNNING dsh version and **skips the whole
 * bundle** when one does not satisfy it. dsh 0.2.0-rc.2 silently dropped this
 * plugin because the manifest still said `^0.1.5-rc.2` — the plugin vanished
 * from the composition with no build error. This test pins the ranges to the
 * runtime generations the code actually supports, and pins the client
 * `inject` list against services the core has removed.
 *
 * The semver subset implemented here is deliberately small (^, >=, <) — it
 * mirrors only what the manifest and the dsh evaluator use.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const clientSource = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

/** Runtime generations this plugin supports (both settings APIs are guarded). */
const SUPPORTED_RUNTIMES = ['0.1.5-rc.2', '0.2.0-rc.2']

function parse(version) {
  const [core, pre = ''] = String(version).trim().split('-')
  const [major, minor, patch] = core.split('.').map(Number)
  return { major, minor, patch, pre: pre === '' ? [] : pre.split('.') }
}

function compareIdentifier(a, b) {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Number(a) - Number(b)
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Semver precedence, prerelease included. */
function compare(left, right) {
  const a = parse(left)
  const b = parse(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const diff = compareIdentifier(x, y)
    if (diff !== 0) return diff
  }
  return 0
}

/** `satisfies` for the comparator subset the manifest uses, prereleases included. */
function satisfies(version, range) {
  for (const raw of String(range).trim().split(/\s+/)) {
    if (raw.startsWith('^')) {
      const base = parse(raw.slice(1))
      const current = parse(version)
      if (compare(version, raw.slice(1)) < 0) return false
      // Caret on 0.x allows only the same minor (npm's rule for 0.x).
      if (base.major === 0 ? current.minor !== base.minor || current.major !== base.major : current.major !== base.major) return false
    } else if (raw.startsWith('>=')) {
      if (compare(version, raw.slice(2)) < 0) return false
    } else if (raw.startsWith('<')) {
      if (compare(version, raw.slice(1)) >= 0) return false
    } else if (raw !== '') {
      throw new Error(`unsupported range token in test helper: ${raw}`)
    }
  }
  return true
}

test('every @deepseek-ai/dsh* peer range covers the supported runtime generations', () => {
  const peers = manifest.peerDependencies ?? {}
  const dshPeers = Object.entries(peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(dshPeers.length > 0, 'the manifest must declare its dsh peer requirements')
  for (const [name, range] of dshPeers) {
    for (const runtime of SUPPORTED_RUNTIMES) {
      assert.ok(
        satisfies(runtime, range),
        `${name} range "${range}" excludes runtime ${runtime} — dsh-app-boot would skip the whole bundle (LESSONS §33)`
      )
    }
  }
})

test('the old caret-on-0.1 range really does exclude 0.2 — the trap is detected', () => {
  // Documents the exact failure: ^0.1.5-rc.2 never matches 0.2.0-rc.2.
  assert.equal(satisfies('0.2.0-rc.2', '^0.1.5-rc.2'), false)
  assert.equal(satisfies('0.1.5-rc.2', '^0.1.5-rc.2'), true)
})

test('the browser half no longer requires the removed settingsScope service', () => {
  // dsh 0.2 removed ctx.settingsScope; a cordis inject on a missing service
  // keeps the client plugin permanently pending (LESSONS §6/§33).
  const inject = /exports\.inject\s*=\s*\[([^\]]*)\]/.exec(clientSource)
  assert.ok(inject !== null, 'client.js must declare its cordis inject list')
  assert.ok(!/settingsScope/.test(inject[1]), 'the client must not inject the removed settingsScope service')
  assert.ok(/slots/.test(inject[1]), 'the client still needs the slots service')
  assert.ok(!/ctx\.settingsScope\.bind/.test(clientSource), 'client.js must not bind a settings scope')
})

test('the client talks to the host config API instead of the settings transport', () => {
  assert.ok(/fetchJson\("\/config"/.test(clientSource), 'client.js must read the host /config endpoint')
  assert.ok(/createProxyStore/.test(clientSource), 'client.js must build the host-backed config store')
})
