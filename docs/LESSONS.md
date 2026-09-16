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

> **⚠️ 2026-09-17 已修订：下面的 file:// 部署决策作废。**用户明确要求
> 「不要 file:// host 插件，要能安装发布的插件」→ 改为标准 npm 插件包 +
> `dsh plugin --profile add` 部署，机制见本文档 §12。本节保留为历史证据
> （node_modules 硬链接被洗的动机仍然成立，但解法是"自有包 + file: 软链装
> 入 profile"，而不是 file:// 加载）。

**原决策（已作废）：`dsh-proxy-pro` 独立部署在 `~/.dsh/plugins/dsh-proxy-pro/`，
通过 `cordis.patch.yml` 以 file:// 形式加载，完全不进 node_modules。**

```yaml
# profiles/<profile>/cordis.patch.yml 增补（已作废）
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
- 本插件：`~/.dsh/plugins/dsh-proxy-pro/`（git 仓库，发布形态，见 §12）
- 环境事实：`~/.dsh/.env`（已删，纯冗余证据）；`settings.yaml`、`cordis.patch.yml`、`cordis.yml`

---

## 12. 发布形态（2026-09-17 修订，取代 §5 的 file:// 方案）

**决策：dsh-proxy-pro 是标准 npm 插件包**，参照已发布的 `dsh-skill-manager@4.3.3`
（GitHub yanglaofish/dsh-skill-manager）。`~/.dsh/plugins/dsh-proxy-pro/` 是它的
开发源目录（git init，commit 04eb709），发布后从 npm / GitHub 安装。

### 12.1 机制（全部经本机源码验证）

- profile 的 `package.json`：
  - `dependencies` 装插件：发布版 = registry 包；本地开发 =
    `file:../../plugins/dsh-proxy-pro`（pnpm 软链，改源码免重装、两 profile 共用一份）。
  - `dsh.profile.bundles` 追加包名 → dsh-app-boot `loadProfileDirectory`
    （app lib/index.js L866-877）逐个读每个 bundle 包的 `dsh.bundle.patch`：
    **声明了 dsh.bundle 但 patch 文件缺失 = 整个 profile boot 抛错**（不是跳过）。
- 插件包自己的 `cordis.patch.yml`（dsh.bundle.patch 指向）insert 一行
  `- id: dsh-proxy-pro, name: '@yanglaofish/dsh-proxy-pro', config: {enabled:false, mode:system, ...}`，
  格式照抄 dsh-plugin-proxy 自己的 patch。
- host 解析：一行 `name: '@yanglaofish/dsh-proxy-pro'`（包名）→ include import 走 profile
  resolver（app lib/module-resolution-*.js 的 registerHooks）：
  - profile 边界/图内模块的裸包名先按 profile node_modules 解析，
    没有则兜底 app 安装副本（`@deepseek-ai/*` 全在 app；profile 里实际只有
    cosmokit/dsh-storage-domain/schemastery——已实测）。
  - 因此 peerDependencies 声明版本即可，**profile 无需安装 `@deepseek-ai/*`**。
- client 发现同 skill-manager：package.json `dsh.client.platform: "web"` +
  `exports["./client"]`；exports 应含 `"./cordis.patch.yml"`。
- 安装命令：`dsh plugin --profile web add <包或 file: 或 github:>`；卸载
  `dsh plugin --profile web remove @yanglaofish/dsh-proxy-pro`。

### 12.2 传输架构（host 重构后，v0.1 落地）

- **删掉 undici 依赖 / EnvHttpProxyAgent / savedEnv / applyEffective**——
  插件对 undici 零依赖，错版雷区（§3：7.29.0 vs 8.10.0）在源头上不存在。
- 唯一通道：`installProxyFromEnvironment(makeEnvLike(effective), log)` 一次完成
  env（applyPolicyEnv 写 8 个名字大小写双写 + loopback 合并）+ per-origin
  dispatcher + 模块级策略（proxyRouteFor 读它 → web_fetch 通道，§2 图）。
- OFF 分支：none-branch 恢复首次安装前的 env + 装直连 Agent（A9 干净卸载即此）。
- **haveApplied 守卫**：从未启用过且当前 OFF → 只记快照不碰传输层；默认
  enabled:false 启动时与旧 dsh-plugin-proxy 并存互不抢 dispatcher（NFR-4）。
- 动机：旧设计先 applyEffective 再 installProxyFromEnvironment，后者永远最后赢，
  EnvHttpProxyAgent 白建白关；且窗口期两个 undici 实例的 dispatcher 互操作正是
  §3 UND_ERR_INVALID_ARG 的触发面。

### 12.3 过渡（NFR-3）

新行默认 `enabled: false` 共存启动 → 验证通过后再接管：profile cordis.patch.yml
加 `- id: proxy, disabled: true`（bundle 层 insert 的行可按 id patch）→ 重启。
回滚 = 删该行或 `dsh plugin remove`；settings.yaml 全程不动。

---

## 13. 自查记录（2026-09-17，code-review-skill 一轮）

### 13.1 dsh-tools schema 编译器铁律（**会让整树 boot 失败**）

- 每个 `type: 'object'` 必须显式 `additionalProperties: true|false`，否则
  `defineTool` 抛 `JsonSchemaError: ... additionalProperties must be explicitly
  true or false` → 该行 apply 抛错 → plugin tree 加载失败、GUI 起不来。
- 只信赖 schema 的**静态审计**不够：这次错误只在**运行期 apply** 暴露，
  `--dump-config` 预检测不到（它只 compose 行，不执行插件）。
- 教训：改工具 schema 后，用「遍历全部 object 断言 additionalProperties
  存在」的静态脚本或直接引用编译器，而不是靠肉眼。

### 13.2 settings.yaml 共享命名空间的实测事实

- 本机 `~/.dsh/settings.yaml` `proxy:` = `{enabled: true, mode: system}`——
  与旧 dsh-plugin-proxy 共用同一 namespace。
- 后果：**重启后本插件会立即接管**（行序在后 = install 最后落地），
  不是展示层默认的 OFF。这是预期行为，验收按 ON 流程走即可。
- 双插件共存期：任何 UI 改设置都会触发两边 sync，但两边读同一份配置、
  计算结果一致，且我们是最后写入者 → 终态一致；旧行是天然兜底
  （本插件 apply 失败时代理仍由旧插件管理）。

### 13.3 已修的三类问题（commit 5918310）

1. **teardown 与在途 sync 竞态**：卸载若赶在 sync 完成前执行，晚到的
   `installProxyFromEnvironment` 会把 policy 泄漏到卸载之后 → 卸载链到
   `syncing.finally` 之后。
2. **probeTarget 无效 URL 抛 throw**：`new URL('not a url')` 已捕获 →
   结构化 `{route:'invalid', probe:{ok:false, kind:'invalid', ...}}`，
   工具与 /api/route 都友好显示而非 500。
3. **`void requestSync()` 未捕获拒绝**：Node 15+ 未捕获的 promise 拒绝会
   崩主进程 → setSource/onChange/poll 三处调用点都补 `.catch(() => {})`。

### 13.4 遗留 backlog（非阻塞，已文档化）

- index.js 业务逻辑（sync/guard/teardown/API/fence）无单测——依赖运行时验收；
  补测需 mock dsh-http-proxy/dsh-settings，成本中等，留待发布后。
- client 轮询无 no-op 去重、无超时、慢响应可能乱序显示旧状态——组件极小，
  现实风险低，暂不改。

---

## 14. 桌面 recovery 会静默重写 profile 的 package.json（2026-09-16 事故）

### 14.1 现象与根因

- 用户重启后"啥也没看到"：头部无胶囊、设置页无「代理管理」。
- 查 `%APPDATA%\DSH Desktop\logs\dsh-<date>.log`：最后一次 run
  （12:56）**无报错**，但更早一次（11:48）记录了
  `unsupported JSON schema: schema.properties.probe.additionalProperties`
  ——这就是 8ce5e21 修的那个 schema bug（跑在修复前）。
- 决定性证据：`profiles/web/package.json` LastWriteTime = **11:50:28**，
  恰好在 desktop 的 `recovery plugin uninstall failed`（11:50:09 error.log）
  窗口内；对读 `profiles/obsidian-web/package.json` 完好（11:35 未动）。
- **根因：桌面版启动时对解析失败的插件执行 recovery 卸载**
  （`dsh plugin --profile web remove @yanglaofish/dsh-skill-manager`），
  该操作重写了 web profile 的 package.json，**把我们手工加的两处
  dsh-proxy-pro 条目连带清掉**，而 node_modules 的 Junction 软链仍在。
- 结论：**profile 文件不是只写一次的**——desktop 会在特定条件下用
  `dsh plugin` 命令重写它。验收前必须复查 package.json 而非只信一次
  `--dump-config` 的记忆。

### 14.2 修复与预防

- 修复：对照 obsidian-web 的形态把 `dependencies["dsh-proxy-pro"] =
  link:...` 与 `dsh.profile.bundles` 里的 `"dsh-proxy-pro"` 加回
  web/package.json；`dsh --profile web --dump-config` 预检两行都在、exit=0。
- 预防：每次用户重启前**先读 profile 的 package.json** 确认条目在（read
  工具，别依赖记忆）；recovery 只会在树加载失败时触发——schema 已修 +
  行在 = 干净加载 = 不会再被重写。

### 14.3 可复用排查路径（"重启后啥也没看到"标准动作）

1. 读 `%APPDATA%\DSH Desktop\logs\dsh-<date>.log` 最后几段——成功 run
   只有 `--- run ---` 头，失败 run 有 `Error:` 行 + 完整栈（栈里
   `#dsh-proxy-pro` / `#include` 指向 profiles/web，确认 desktop 用的
   就是 web profile）。
2. 对照同一时刻 `dsh-<date>.error.log` 与 profile package.json 的
   LastWriteTime——两者撞窗 = recovery 重写过。
3. `dsh --profile web --dump-config` 复检行在树里。
4. 修好 → 重启 → 按 ACCEPTANCE.md 验收。

---

## 15. dsh-tools 工具 schema DSL 完整词表 + 本地编译验证（2026-09-16）

### 15.1 事故：schema 类错误烧掉三次重启

三次 boot 失败，同一个根因家族，全都是 `defineTool` 在 apply 期抛
`JsonSchemaError` → 整个 plugin tree 加载失败：

| 报错 | 违规写法 | 正确写法 |
|---|---|---|
| `.additionalProperties must be explicitly true or false` | object 省略该键 | 每个 `type:'object'` 显式 `additionalProperties: false` |
| `.required must be true when present` | `{ type:'number', required: false }` | 可选属性**省略 `required`**，不能写 `false` |

### 15.2 DSL 词表（编译器逐字确认，dsh-tools lib/schema）

每个节点允许的键 = 通用注解 `description/title/default/examples`
+（仅**属性节点**且仅当 `required === true` 时）`required`
+ 按类型：

| 类型 | 额外允许键 | 硬性要求 |
|---|---|---|
| `object` | `properties`, `additionalProperties` | `additionalProperties` 必须是显式 boolean |
| `array` | `items` | — |
| `string`/`number`/`integer`/`boolean`/`null` | `enum`, `const` | — |
| `json` | （仅注解） | — |
| 替代式 `oneOf` | `oneOf`（≥2 分支） | 不可与 `type` 同时出现 |

- **任何 DSL 之外的键都是错误**（`format`/`pattern`/`minimum` 等一律不支持）。
- `required` 是**属性级标记**而非属性名数组；对象根的 required 列表由编译器收集。

### 15.3 解法：把 apply 期错误提前到本地（不重启）

`dsh-tools` **导出**了 `defineTool` 内部使用的两个编译器：

```js
parameterSchemaSpecToJsonSchema(options.parameters)   // defineTool L846
valueSchemaSpecToJsonSchema(options.output.schema)    // defineTool L847
```

因此工具 schema 抽到 `lib/tool-schemas.js`（纯数据、零依赖），
`test/tool-schema.test.mjs` 做两层校验：

1. **静态镜像**：完整复刻上面的词表（含 `required` 只许 true、object 必须
   显式 additionalProperties、未知键报错），无 app 也能跑；
2. **真实编译器**：定位 `@deepseek-ai/dsh-tools` 并调用那两个导出——
   路径来源依次为 `DSH_TOOLS_MODULE` → `DSH_APP_ROOT` →
   `%LOCALAPPDATA%\Programs\DSH Desktop\resources\app`；找不到则 skip
   并打 diagnostic（可移植，不硬编码机器路径）。

### 15.4 规矩

- **改任何 tool schema（含新增工具）后，必须先跑 `npm test`**——
  `test/tool-schema.test.mjs` 必须绿，否则不要重启 DSH。
- `--dump-config` 检测不到这类错误（它只 compose 行，不执行插件 apply），
  别用它当"能启动"的证据。

---

## 16. Client 半的槽位规矩（2026-09-16 静态核对发现）

### 16.1 inject 的槽名必须等于 register 的槽名

- 错误写法（本插件原样，已修）：`slots.inject("conversation.session.header", …)`
  里 `register({ name: "conversation.session.header.utilities" })` ——
  **注入父槽、注册子槽**，注册不会生效。
- 正确写法（app 官方先例逐字）：
  `dsh-client-ui-open-in-app/lib/client.js:406`、
  `dsh-session-log-export/lib/client.js:274` 都是
  `ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
      name: "conversation.session.header.utilities", … }))`。
- 结论：**inject 的键就是 register 的 name**，子槽也要写全名。

### 16.2 可用槽位的事实来源（别再猜）

- `conversation.session.header` 家族由 `@deepseek-ai/dsh-client-ui-conversation`
  定义（client.js L16684-16699：`.lineage` / `.actions` / `.utilities` / `.corner`），
  渲染点在 L14951 / L15072-15082。
- `settings.section` 由 `dsh-client-ui-settings-general`、`settings-models`、
  `settings-plugins`、`ui-agent-preset` 等注册；`dsh-cordis-client-runner`
  L3872 持有槽树 `key: "settings.section"`。
- 核对方法：grep `@deepseek-ai/*/lib/client.js` 找 `renderSlot("槽名"` 与
  `register({ name: "槽名"` 的**实际先例**，照抄其形式（含 `slots.inject` 写法）。
- 对比：dsh-plugin-proxy 挂在 `sidebar.footer.action` + `settings.plugin.item`；
  本插件按 FR-2 选对话头部工具区（`…header.utilities`），与 open-in-app 同款。

### 16.3 两处 inject 不要混

- `package.json` 的 `dsh.client.inject` = **client 包名列表**（加载顺序）。
- `client.js` 导出的 `exports.inject` = **Cordis 服务名**（`slots`、`settingsScope`）。
- 把包名写进 `exports.inject` 会永久 pending 并阻塞 web boot（§6）。
- 本插件 client 模块 id 遵循 `<包名>/client`（`"dsh-proxy-pro/client"`），
  与 `"dsh-plugin-proxy/client"` 同规。

---

## 17. 轮询≠重组：GET 状态绝不能触发全量重装（2026-09-17 桌面卡顿根因）

### 17.1 现象

- 用户报告：挂上 dsh-proxy-pro 后 desktop 很卡，"切换模型都卡"。
- 直觉困惑："插件只是流量走代理转发，怎么会卡 UI？"——**转发本身不卡，
  卡的是把读状态变成了每几秒拆装一次代理通道**。

### 17.2 根因链（三层叠加）

1. client 两个 `useRuntimeStatus(4000/3000)` 轮询 `/api/status`；
2. host 的 `/api/status` handler 上来就 `await requestSync()`；
3. `sync()` 无条件执行：**读注册表（execFile 子进程）→ 卸载旧 policy →
   `installProxyFromEnvironment` 重装全局 dispatcher + 重置 env**。

结果：GUI 打开时 ≈ 每 3-4 秒一次全量重建全局代理（undici agent 池反复
弃建、在途连接被拆、utility process 高频 spawn reg 子进程）。所有走代理的
请求（含模型/页面）都在被反复打断，desktop 自然拖垮。

### 17.3 修复（commit 096e431，两层）

1. **API 只读快照**：`/api/status`、`/api/route` 不再 `requestSync()`——
   直接返回内存里的 `summarize(snapshot)`。快照由配置钩子 + systemPollMs
   轮询维持新鲜，读请求零成本。（`/api/toggle` 是写操作，保留 requestSync。）
2. **sync 幂等化**：sync 开头计算 `effKey = JSON.stringify([active, url, noProxy, reason])`，
   **生效状态未变 → 只刷新快照 + emit，绝不触碰 env/dispatcher**；只有
   effKey 变化（配置变更 / 系统代理事实变化）才真正重装。

### 17.4 此后铁律

- **读型 API / 读型轮询永远不触发重装**；重装只发生在"生效状态真正变化"
  的路径上（写操作、poll 检测到变化）。
- `requestSync()` 本身也要幂等：被高频调用时，未变化的 pass 必须 ≈0 成本。
- 新增任何"定时/轮询"行为时，先问：它会不会触发全量重建？会就拆开。