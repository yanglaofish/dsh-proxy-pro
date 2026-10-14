// 测试替身隔离进程级代理和注册表；真实 apply、工具和 HTTP 路由仍直接执行。
import { promisify } from 'node:util'
const schema = new Proxy(() => {}, { get: () => schema, apply: () => schema })
export default schema
export const defineTool = (tool) => tool
export const transport = { installs: [], disposals: 0 }
export function resetTransport() {
  transport.installs = []
  transport.disposals = 0
}
export async function installProxyFromEnvironment(env) {
  transport.installs.push(Object.fromEntries(
    ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].map((key) => [key, env.get(key)?.value])
  ))
  return async () => { transport.disposals++ }
}
export function proxyRouteFor() { return { proxied: false } }
export function execFile(_file, args, _options, callback) {
  const name = args.at(-1)
  const values = {
    ProxyEnable: 'REG_DWORD    0x1',
    ProxyServer: 'REG_SZ    http=proxy.example:8080;https=secure-proxy.example:8443',
    ProxyOverride: 'REG_SZ    *.intranet.example;<local>',
  }
  callback(null, `    ${name}    ${values[name]}\r\n`, '')
}
// node:child_process.execFile 的 promisify 结果是对象，而非单个 stdout 字符串。
execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error) reject(error)
    else resolve({ stdout, stderr })
  })
})
