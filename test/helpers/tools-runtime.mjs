import path from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// CI 安装隔离的固定版本；本地也支持已有 DSH 安装或显式模块路径。
export function resolveCompilerModule() {
  if (process.env.DSH_TOOLS_MODULE && !existsSync(process.env.DSH_TOOLS_MODULE)) {
    throw new Error(`DSH_TOOLS_MODULE 指定的模块不存在：${process.env.DSH_TOOLS_MODULE}`)
  }
  const require = createRequire(import.meta.url)
  let installed
  try { installed = require.resolve('@deepseek-ai/dsh-tools') } catch {}
  const candidates = [
    process.env.DSH_TOOLS_MODULE,
    fileURLToPath(new URL('../../.test-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js', import.meta.url)),
    installed,
    process.env.DSH_APP_ROOT && path.join(process.env.DSH_APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  ]
  return candidates.find((candidate) => typeof candidate === 'string' && candidate !== '' && existsSync(candidate))
}
