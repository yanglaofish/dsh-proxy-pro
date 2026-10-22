// 仅替换网络传输，供真实插件执行诊断；不访问用户代理或公网。
export const probes = { proxy: 200, direct: 200, calls: [] }
export class Agent {
  channel = 'direct'
  async close() {}
}
export class ProxyAgent extends Agent {
  channel = 'proxy'
}
export async function fetch(url, { method, dispatcher }) {
  const channel = dispatcher.channel
  probes.calls.push({ channel, method, url: String(url) })
  const result = probes[channel]
  if (result instanceof Error) throw result
  return { status: result }
}
