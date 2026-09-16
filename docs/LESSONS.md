# dsh-proxy-pro — 设计依据与踩坑备忘

> 本文档记录本插件诞生的完整背景：DSH 代理链路的真实行为、我们踩过的每一个
> 坑、验证过的修复方案，以及据此做出的插件设计决策。**后续任何改动请先读本文**，
> 很多"看起来显然"的假设在这里都被证伪过。

---

## 1. 一句话背景

2026-09-16 前后，用户的 `web_fetch` 全线失败（`web fetch failed: TypeError: fetch failed`），
我们在调测中发现 DSH 的代理机制存在一个真实缺口：**环境里的代理设置对 web_fetch
进程完全不生效**。修好之后，用户决定基于这次积累的经验自研代理插件（本插件），
替换体验别扭的 `dsh-plugin-proxy`。

---

## 2. 代理链路真实架构（务必先看懂这张图）

```
┌─ web_fetch / web_search 工具 ─────────────────────────────────────┐
│ dsh-tool-web (line ~805)                                          │
│   await ctx.web.fetch({ url }, exec.signal)                       │
│     └─ dsh-web-fetch-http 的 HttpFetchProvider (id "http")        │
│          └─ requestOnce (line ~500-504)                           │
│               const route = proxyRouteFor(url)                    │
│               if (route.proxied && !isNonPublicIpLiteral(...))    │
│                 → publicHttpNetwork.requestVia(route.dispatcher…) │
│               else → requestPinned 直连（被墙 = EACCES）           │
└───────────────────────────────────────────────────────────────────┘

┌─ 模型请求 / 其他 spawn 的进程 ─────────────────────────────────────┐
│ undici 全局 dispatcher (setGlobalDispatcher)                      │
│   + process.env 的 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY│
└───────────────────────────────────────────────────────────────────┘

关键：proxyRouteFor() 读的是 @deepseek-ai/dsh-http-proxy 模块级状态
      （active / installed），这个状态只有 installProxyFromEnvironment() 会写入。
```

### 进程架构（重启后实测）

```
DSH main (28404)
  └─ NodeService utility (21872) —— 监听 :43120 web 服务
       ├─ 我的 pwsh 祖父链：15416 → 21872 → 28404
       └─ web_fetch 工具运行在这条链上（**从不跑 profile-boot 的
          installProxyFromEnvironment** —— 这就是 web_fetch 恒 DIRECT 的根因）
```

- `~/.dsh/.env`（home 层）只影响跑 **profile-boot** 的进程（host/main）。
- web_fetch 在 **NodeService 链**，且该链没有调用任何 `installProxy…`。
- 结论：**只要 web_fetch 进程内 `proxyRouteFor` 判定为 DIRECT，它就连不上
  外网被墙的 github 等目标；与你的系统代理、shell 代理、DSH 设置全无关。**

---

## 3. 根因与已证伪的假设（血泪史）

| 假设 | 结论 | 证据 |
|---|---|---|
| `.env` 设置 HTTP_PROXY 能修 web_fetch | ❌ 证伪 | `.env` 只被 profile-boot 读取；删除后 loadLayeredEnv 仍解出代理，但 **web_fetch 依旧 DIRECT** |
| `settings.yaml` 的 proxy 段是给 dsh-http-proxy 用的 | ❌ 被用户纠正两次 | 真消费者是**已安装插件 dsh-plugin-proxy**（settingsNamespace('proxy')） |
| 改全局 dispatcher 就够 | ❌ 不覆盖 web_fetch | web_fetch 不读全局 dispatcher，只读 proxyRouteFor |
| 两份 undici 混用没问题 | ❌ UND_ERR_INVALID_ARG | Node fetch + DSH dispatcher 是两个 undici 实例，构造参数不兼容；必须同源 |
| proxyhk 是普通代理 | ❌ NTLM | SWG 代理需要 NAT 认证窗口；undici ProxyAgent 不协商 NTLM，靠 keepalive 复用 |

**真正修复（已验证 HTTP 200）**：给 dsh-plugin-proxy 打补丁，在 sync() 内
`applyEffective` 之后追加调用：

```js
httpProxyPolicy = await installProxyFromEnvironment(envLike, (m) => ctx.logger.warn('proxy: dsh-http-proxy: %s', m))
```

重启后：github → PROXIED (proxyhk)，deepseek → DIRECT，web_fetch 200。✅

---

## 4. installProxyFromEnvironment 的调用契约（新插件必须遵守）

```js
// dsh-http-proxy/lib/index.js 真实逻辑
// installProxyFromEnvironment(env, report) = resolveProxyPolicy(env) + installGlobalProxy(policy)
// resolveProxyPolicy 读 all_proxy/http_proxy/https_proxy/no_proxy（lowercase 优先，uppercase 兜底）
// policy.source 只有 "env" / "none" 两种

// env 必须带 .get()，不是裸 process.env（否则 "env.get is not a function"）：
const envLike = {
  get: (name) => {
    const value = process.env[name]
    return value === undefined ? undefined : { value }
  }
}
```

**幂等要求**：再次 install 前必须先 `await 旧 policy?.()`（卸载），否则模块级
`active/installed` 状态残留导致判定错乱。

**loadLayeredEnv 行为**（dsh-app-boot lib/index.js ~1091-1116）：
`inherited={...process.env}` + 项目层 `cwd/.env` + home 层 `~/.dsh/.env`
（`home !== resolve(cwd)` 时读），只在 `process.env[name] === void 0` 时写入；
返回带 `.get()` 的快照。`HOME_LAYER_PROXY_NAMES` 允许 home .env 设代理变量。

---

## 5. 为什么新插件放独立目录（避开 node_modules）

```
C:\Users\...\profiles\[web|obsidian-web]\node_modules\dsh-plugin-proxy\package.json
  LinkType = HardLink → C:\Users\...\pnpm\store\v11\files\...（pnpm 全局 store）
```

- profile 用 pnpm（`nodeLinker: hoisted`）安装插件，**node_modules 里是 store 的硬链接**。
- 直接改 node_modules 文件 = 改 store 里的原文件；**下次 `pnpm install` 会洗回 store 原样**，
  我们的补丁全丢（这也是用户抱怨"修改别扭"的根源）。
- 原 `dsh-plugin-proxy` 版本升级同样会覆盖我们的补丁（我们保留了 `.bak` 也是无奈之举）。

**决策：`dsh-proxy-pro` 独立部署在 `~/.dsh/plugins/dsh-proxy-pro/`，通过
`cordis.patch.yml` 以 file:// 形式加载，完全不进 node_modules。**

```yaml
# profiles/<profile>/cordis.patch.yml 增补
- insert:
    - id: dsh-proxy-pro
      name: file:///C:/Users/w00958282/.dsh/plugins/dsh-proxy-pro/lib/index.js?raw  # 见 loader 约定
```

### file:// 插件能否带 client 端？——能（已验证源码）

`dsh-client-modules/lib/index.js` 的 `locatePkgJson`（L679-708）：
- `loaderName.startsWith("file:")` 或绝对路径 → pathLike 分支
- 通过 `nearestPackage(moduleUrl)` 向上找最近的 package.json
- **只要该目录的 package.json 声明 `dsh.client`（platform: "web"）+ `exports["./client"]`，
  client 端就会被 client-modules 扫描、打包、注入**

所以新插件形态：
```
~/.dsh/plugins/dsh-proxy-pro/
  package.json      # name/dsh.client/platform:web/exports["./client"]
  cordis.patch.yml  # dsh.bundle.patch 指向的补丁
  lib/index.js      # host 半
  lib/client.js     # 浏览器半（__ModuleLoader__.load 格式）
  lib/proxy-core.js # 纯逻辑（无依赖，可单测）
  docs/LESSONS.md   # 本文档
```

---

## 6. Client 插件写法（浏览器端铁律）

```js
window.__ModuleLoader__.load({
  id: "dsh-proxy-pro",
  factory: (require) => {
    // 注意：inject 列的是【服务名】（如 "slots","settingsScope","sessions"），
    // 不是包名！写包名会阻塞 web boot（踩坑教训，见插件 docs/LESSONS.md）
    const inject = ["slots", "settingsScope"];
    function apply(ctx) { ... }
    return { apply, inject };
  }
});
```

技能库里的 `dsh-skill-manager@4.3.3`（obsidian-web profile 已装）是**现代写法参照模板**：

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section", id: "skill-manager", order: 30, label: "技能管理",
}, Panel));
ctx.slots.inject("conversation.view", () => ctx.slots.register({
  name: "conversation.view", id: "skill-manager", order: 20, label: "技能",
}, View));
```

### 对话头部按钮（用户明确要的"对话页面上可点击开关的代理按钮"）

```js
// dsh-client-ui-conversation/lib/client.js L16683-16715
// registerConversationHeader 声明了 4 个子 slot：
//   conversation.session.header.lineage   (single, session)
//   conversation.session.header.actions   (list,  session)   ← 左侧
//   conversation.session.header.utilities (list,  session)   ← 右侧操作区
//   conversation.session.header.corner    (single, session)
// 用法：ctx.slots.inject("conversation.session.header", () => ctx.slots.register({
//   name: "conversation.session.header.utilities", id: "...", order: 10, label: "代理",
// }, Button));
```

拖动按钮：reflect/slots 是布局注入点，**原生不支持拖拽浮层**（用户问过"如果能拖动更好"）。
采用"状态胶囊按钮 + 点击弹层"形态代替，信息密度更高且不违背平台约束。

### 原 dsh-plugin-proxy client 的写法（旧式，可见性差）

- `sidebar.footer.action`（侧边栏底部小开关）
- `settings.plugin.item`（Settings → Plugins 页卡片）
- 只读 settingsScope，**看不到运行时状态**（active/url/reason 纯推算）
- 新插件改为：settings 独立页（`settings.section`，现代式）+ 对话头部按钮 + 状态 API 轮询

---

## 7. Host 状态如何给到 Client（不重启也能实时）

`dsh-skill-manager` 的做法（样板）：

```js
const routePath = '/skill-manager/api'
const unregisterRoute = ctx.webServer.register({
  kind: 'prefix',
  path: routePath,
  handler: async (req, res) => { /* 解析 method+pathname 分发 */ }
})
// client 端直接 fetch(API + "/xxx") 同源调用
```

**必须带 browser-trust fence**（防跨站请求，skill-manager L131-162 完整实现）：
- `Host` 头解析后必须 loopback（localhost / [::1] / 127/8）
- `sec-fetch-site: cross-site` 拒绝
- `origin` 若存在必须与 host 同源
- 拒绝时 403 `forbidden`（`denyIfUntrusted(req, res)` 供 handler 首行调用）

新插件 API 设计：
```
GET  /dsh-proxy-pro/api/status   → { ok, status: summarize(snapshot) }   # UI 轮询
GET  /dsh-proxy-pro/api/route?url=… → { ok, route, bypassed, probe, hint } # 诊断
POST /dsh-proxy-pro/api/toggle {"enabled":bool} → 更新 settings + 立即 sync
```

---

## 8. NTLM / keepalive（用户明确要求"有打的应用范围才做"）

**事实**：
- proxyhk.huawei.com:8080 是 NTLM 认证的 SWG 代理。
- curl 用 `--proxy-ntlm --proxy-user ":"` 自带 NTLM 协商；**undici ProxyAgent 不协商 NTLM**。
- 因此依赖"认证后 keepalive 连接复用窗口"：`~/.dsh/proxy-keepalive` 在跑，日志 09:24:31 "ok"。

**判断（对用户问题的答复——已确认）**：
- **不常见**：仅企业 SWG（netentsec/华为这类）需要；家里 Clash/v2rayN 本地代理无 NTLM。
- **不做进核心**：keepalive 做成**可选诊断**——`proxy_test` 探测到 407/authentication
  required 时，才提示"可能需要 curl 先建认证窗口"（`keepaliveHint()`，贴近响应文本检测）。
- 多网站 keepalive **无意义**：代理是单点，keepalive 只对代理那一台建，与目标网站无关。

---

## 9. 无缝过渡方案（用户问"避免现在的路由断掉"）

1. 新插件读**同一个 `proxy` settings namespace** → settings.yaml 的 proxy 段直接接管，
   用户已有的 enabled/mode/customUrl/noProxy 配置零迁移。
2. 行为对齐：新插件 = 原来 dsh-plugin-proxy（env + 全局 dispatcher）**+ 我们验证过的
   installProxyFromEnvironment 修复**，路由判定结果与当前打补丁后的状态完全一致
   （github→PROXIED，deepseek→DIRECT）。
3. 切换顺序：装好新插件 → **先禁原插件**（cordis.patch.yml `- id: proxy, disabled: true`
   或删除该行）→ 重启 → `proxy_status` 确认 → `web_test`/web_fetch 200 确认。
   任何时候出问题，恢复原插件行 + 保留的 `.bak` 即回滚，配置从未动过。
4. 同一时刻只允许一个 dispatcher 主人（新老插件都写全局 dispatcher，同时启用会互踩）。

---

## 10. 已知事实速查（调测用）

| 项 | 值 |
|---|---|
| DSH | 2.0.10 / Electron 43.3.0 |
| Web GUI | http://127.0.0.1:43120（NodeService 21872 监听） |
| 系统代理 | proxyhk.huawei.com:8080（NTLM SWG，Proxy ON） |
| NO_PROXY | 大列表：`*.huawei.com` 等内网全量 + localhost/127.0.0.1/::1 |
| profile | web / obsidian-web（两份，插件需都装） |
| settings.yaml | proxy: {enabled: true, mode: system, customUrl: http://127.0.0.1:7890} |
| 验证基线 | github → PROXIED；deepseek.com → DIRECT；web_fetch PR#3574 → 200 |
| loadLayeredEnv | process.env + cwd/.env + ~/.dsh/.env（仅 undefined 时写入） |

## 11. 关键文件位置

- 打包源码：`C:\Users\w00958282\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\...`
  （dsh-web-fetch-http / dsh-http-proxy / dsh-app-boot / dsh-web / dsh-tool-web /
   dsh-client-ui-conversation / dsh-client-ui-chat / dsh-client-modules / dsh-settings）
- 原插件（已打补丁 + .bak）：`~/.dsh/profiles\{web,obsidian-web}\node_modules\dsh-plugin-proxy\lib\`
- 参照模板：`~/.dsh/profiles\obsidian-web\node_modules\dsh-skill-manager\lib\`（index.js + client.js）
- 本插件：`~/.dsh/plugins/dsh-proxy-pro/`
- 环境事实：`~/.dsh/.env`（已删，纯冗余证据）；`settings.yaml`、`cordis.patch.yml`、`cordis.yml`