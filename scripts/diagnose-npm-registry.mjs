// 发布失败后的只读探测：比较匿名与认证请求，不输出凭据或响应正文。
const token = process.env.NPM_TOKEN ?? ''
console.log(JSON.stringify({ hasToken: !!token, hasOuterWhitespace: token !== token.trim(),
  tokenFormatMatches: /^npm_[A-Za-z0-9_-]+$/.test(token) }))
const packageName = '@yanglaofish%2Fdsh-proxy-pro'
const paths = [
  '/-/ping', '/-/whoami', `/${packageName}`,
  `/-/package/${packageName}/version/2.0.3/status`,
]
await Promise.all(paths.flatMap((pathname) => [false, true].map(async (authenticated) => {
  if (authenticated && !token) return
  const started = Date.now()
  try {
    const response = await fetch(`https://registry.npmjs.org${pathname}`, {
      headers: { accept: 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(8000), cache: 'no-store',
    })
    await response.body?.cancel()
    console.log(JSON.stringify({ pathname, authenticated, httpStatus: response.status, elapsedMs: Date.now() - started }))
  } catch (error) {
    console.log(JSON.stringify({ pathname, authenticated, error: error.name, code: error.cause?.code, elapsedMs: Date.now() - started }))
  }
})))
