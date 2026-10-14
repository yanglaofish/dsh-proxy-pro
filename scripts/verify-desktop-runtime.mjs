// 用法：node scripts/verify-desktop-runtime.mjs "桌面程序所在目录"
// 两个隔离进程共用本地测试代理；不访问真实内网，也不改写已安装的配置。
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const appDir = process.argv[2]
if (!appDir) throw new Error('请提供 DeepSeek Harness 桌面程序所在目录')
const children = [], sockets = new Set(), events = []
function authenticatedLabel(req) {
  const auth = req.headers['proxy-authorization'] ?? ''
  return ['profile-a', 'profile-b'].find((name) =>
    auth === `Basic ${Buffer.from(`${name}:smoke-password`).toString('base64')}`)
}
// 宿主可用普通 HTTP 转发或 CONNECT 隧道，两种均接收，且都核验认证。
const proxy = http.createServer((req, res) => {
  const label = authenticatedLabel(req)
  if (!label) { res.writeHead(407); res.end(); return }
  assert.equal(req.url, 'http://proxy-smoke.invalid/check')
  events.push(label)
  res.end(`proxied:${label}`)
})
proxy.on('connect', (req, socket) => {
  const label = authenticatedLabel(req)
  if (!label) { console.error('测试代理收到缺失或不匹配的认证'); socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return }
  assert.equal(req.url, 'proxy-smoke.invalid:80')
  events.push(label)
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  socket.once('data', () => {
    const body = `proxied:${label}`
    socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
  })
})
const direct = http.createServer((_req, res) => { res.end('direct') })
for (const server of [proxy, direct]) {
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
}
function waitFor(child, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`等待 ${event} 超时`)), 15000)
    function done(error) {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('error', done)
      if (error) reject(error)
      else resolve()
    }
    function onMessage(message) {
      if (message.event === 'error') done(new Error(message.message))
      else if (message.event === event) done()
    }
    function onExit(code) { done(new Error(`子进程提前退出：${code}`)) }
    child.on('message', onMessage)
    child.once('exit', onExit)
    child.once('error', done)
  })
}
try {
  for (const server of [proxy, direct]) {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    delete env[key]
    delete env[key.toLowerCase()]
  }
  delete env.NODE_USE_ENV_PROXY
  const script = fileURLToPath(new URL('./runtime-smoke-child.cjs', import.meta.url))
  const ready = []
  for (const label of ['profile-a', 'profile-b']) {
    const child = spawn(path.join(appDir, 'DeepSeek Harness.exe'), ['--expose-internals', script,
      path.join(appDir, 'resources', 'app.asar', 'dsh'), String(proxy.address().port), String(direct.address().port), label],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    children.push(child)
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    ready.push(waitFor(child, 'ready'))
  }
  await Promise.all(ready)
  const off = waitFor(children[0], 'off')
  children[0].send('off')
  await off
  const probe = waitFor(children[1], 'probe')
  children[1].send('probe')
  await probe
  assert.equal(events.filter((name) => name === 'profile-a').length, 2)
  assert.equal(events.filter((name) => name === 'profile-b').length, 4)
  const exits = children.map((child) => once(child, 'exit'))
  for (const child of children) child.send('quit')
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0)
  console.log('PASS：真实 DSH 编译器；启动首请求经认证代理；本地直连；双进程共用代理；关闭 A 不影响 B；状态脱敏。')
} catch (error) {
  console.error('已记录的测试代理连接：', events)
  throw error
} finally {
  for (const child of children) if (child.exitCode === null) child.kill()
  for (const socket of sockets) socket.destroy()
  for (const server of [proxy, direct]) server.close()
}
