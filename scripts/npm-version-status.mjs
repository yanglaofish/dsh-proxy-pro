// 只读查询上传处理状态；日志仅保留状态字段，不输出认证头。
import { readFile, appendFile } from 'node:fs/promises'
const { name, version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (!process.env.NPM_TOKEN) throw new Error('缺少 npm 状态查询凭据')
const packagePath = encodeURIComponent(name).replace(/^%40/, '@')
const response = await fetch(`https://registry.npmjs.org/-/package/${packagePath}/version/${encodeURIComponent(version)}/status`, {
  headers: { authorization: `Bearer ${process.env.NPM_TOKEN}` },
  signal: AbortSignal.timeout(30000),
})
const result = await response.json()
console.log(JSON.stringify({ httpStatus: response.status, packageName: result.packageName,
  version: result.version, status: result.status, error: result.error, message: result.message }))
if (!response.ok && response.status !== 404) throw new Error(`npm 状态查询失败：HTTP ${response.status}`)
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `accepted=${response.ok}\n`)
}
