# dsh-proxy-pro 设计规格（DESIGN SPEC）

> 版本：0.1（2026-09-16，2026-09-17 修订部署形态为发布/软件包制）
> 状态：v0.1 代码完成（2026-09-17），待安装验收 A1-A10
> 读者：接手开发的模式（拥有更高权限与技能）。请把本文与 `docs/LESSONS.md`
> 一起读：LESSONS 记录**已验证的事实与踩坑教训**（不可违背），本文记录
> **要做什么、怎么验收**。两者冲突时以 LESSONS.md 为准。

---

## 1. 背景与目标

### 1.1 背景

用户环境的 `web_fetch` 曾全线失败，根因链路见 LESSONS §2-§3。修复方案（给已装
的 `dsh-plugin-proxy` 打补丁调用 `installProxyFromEnvironment`）已验证有效，但
原插件存在体验问题：

- 前端藏在 Settings → Plugins 深处（旧式 `settings.plugin.item` 卡片）＋侧边栏
  底部小开关，状态全靠推算，看不到运行时事实。
- 代码在 `node_modules` 里（pnpm HardLink），改完一次 `pnpm install` 就被洗掉，
  升级也覆盖 —— 用户明确不满。

### 1.2 目标（用户原话提炼）

1. 做一个我们自己的代理插件，参考 `LucienLL/dsh-plugin-proxy` 的机制但重写体验。
2. **设置里独立一页「代理管理」**（用户已确认，推荐项）。
3. **对话页面上一个可点击开关的代理按钮**（用户已确认；"如果能拖动更好"——
   见 §5.3 的处理决定）。
4. 修复并保持：web_fetch 也走代理（这是本插件的第一价值）。
5. 无缝过渡：**不破坏现在已配通的路由**，回滚容易，配置零迁移。

### 1.3 非目标（明确不做）

- ✗ NTLM keepalive 常驻机制（用户已同意：不常见，只做可选诊断，见 §4.5）。
- ✗ 多网站 keepalive（代理是单点，无意义）。
- ✗ 拖拽式浮动按钮（平台 slots 不支持；见 §5.3 决策）。
- ✗ PAC 文件解析、代理测速排行、多代理切换 UI 等超需求功能。

---

## 2. 需求清单

### 2.1 功能需求

| ID | 需求 | 验收要点 |
|---|---|---|
| FR-1 | Settings 独立页「代理管理」 | 从 Settings 侧栏可直达；显示运行时状态 + 可编辑配置 |
| FR-2 | 对话头部代理按钮 | 每会话头部右侧可见；一个点击完成开关；显示当前状态（ON/OFF） |
| FR-3 | 状态实时可见 | 头部按钮/设置页展示**运行时事实**（active/url/noProxy/reason），非设置推算 |
| FR-4 | 工具：proxy_status | 同现有语义，读实时快照 |
| FR-5 | 工具：proxy_set | 开关 + 持久化 + 立即生效（三通道：env/dispatcher/policy） |
| FR-6 | 工具：proxy_test | 单 URL 路由诊断：PROXIED/DIRECT 判定 + 实际连通探测 + NTLM 提示 |
| FR-7 | web_fetch 修复保持 | installProxyFromEnvironment 纳入 sync 主流程 |
| FR-8 | 系统代理跟随 | mode=system 时周期读注册表，变更才重应用 |
| FR-9 | 干净卸载 | teardown 恢复 env/dispatcher/policy，无人为残留 |

### 2.2 非功能需求

| ID | 需求 | 约束 |
|---|---|---|
| NFR-1 | 配置零迁移 | 复用 `proxy` settings namespace，settings.yaml 原样生效 |
| NFR-2 | 独立部署 | 插件目录在 `~/.dsh/plugins/dsh-proxy-pro/`，不经 node_modules/pnpm |
| NFR-3 | 可回滚 | 切回原插件只需恢复 cordis.patch.yml 一行 + 保留 `.bak` |
| NFR-4 | 单一 dispatcher 主人 | 与 dsh-plugin-proxy 二选一启用，不同时 |
| NFR-5 | 无新增第三方依赖 | 纯 ESM + 现有 DSH 包；逻辑层（proxy-core.js）零依赖可单测 |
| NFR-6 | 双 profile 部署 | web + obsidian-web 都要装 |

---

## 3. 总体架构

### 3.1 部署形态（2026-09-17 修订：file:// 方案作废，改为发布形态）

插件以标准 npm 插件包发布，经 `dsh plugin --profile <name> add dsh-proxy-pro`
装入各 profile（= 写 dependencies + 追加 `dsh.profile.bundles` + pnpm 安装）。
启动时 dsh-app-boot 依次读每个 bundle 包的 `dsh.bundle.patch`（cordis.patch.yml）
把插件行 insert 进入口树。参照 dsh-skill-manager（已发布 4.3.3，机制见
LESSONS §12）。

```
开发源（~/.dsh/plugins/dsh-proxy-pro/，git 仓库）：
  package.json       # name/exports["/client","/cordis.patch.yml"]/dsh.client(platform:web)
  cordis.patch.yml   # bundle patch：insert 一行 name: 'dsh-proxy-pro'（dsh.bundle.patch 指向）
  lib/
    index.js         # host 半（Cordis 插件）
    client.js        # 浏览器半（__ModuleLoader__.load）
    proxy-core.js    # 纯逻辑（系统代理读取/NO_PROXY/状态解析/probe 分类）
  test/proxy-core.test.mjs   # node --test 单测（16 例）
  docs/ README.md LICENSE

profile 内安装（pnpm nodeLinker: hoisted；本地=file: 软链，发布=registry 包）：
"dependencies": { "dsh-proxy-pro": "file:../../plugins/dsh-proxy-pro" }
"dsh": { "profile": { "bundles": [ "...", "dsh-proxy-pro" ] } }
```

- **host 加载**：bundle patch 以 `name: 'dsh-proxy-pro'`（包名）insert → profile
  resolver 从 profile node_modules（没有则兜底 app 安装副本）解析，无需 file://。
- **client 发现**：client-modules 按已装包的 `dsh.client.platform: web` +
  `exports["./client"]` 扫描打包（skill-manager 同款）。
- **两个 profile 共用一份源码**：file: 软链指向同一目录，改一处两处生效。

### 3.2 运行时交互图

```
[浏览器 client.js]                    [host index.js (NodeService 链)]
  │  inject settings.section            │  installSettingsSection(proxy NS)
  │  inject header.utilities            │  sync(): resolve → applyEffective(env+dispatcher)
  │  fetch /dsh-proxy-pro/api/*  ◄──────┤          → installProxyFromEnvironment(policy)
  │                                     │              ↓ 让 web_fetch 的 proxyRouteFor 判 PROXIED
  │                                     │  tools: proxy_status/set/test
  │                                     │  systemPrompt.section(proxy:status)
  └─ settingsScope (bind proxy NS)  ──► │  (用户改设置 → onChange → requestSync)
```

### 3.3 状态模型

`snapshot = { config, effective, systemProxy, at }`；对外统一用
`summarize(snapshot)`（proxy-core.js）：

```json
{ "active": true, "enabled": true, "mode": "system",
  "url": "http://proxyhk.huawei.com:8080", "noProxy": "localhost,127.0.0.1,::1,*.huawei.com",
  "reason": "system", "source": "system", "at": "2026-09-16T…" }
```

---

## 4. Host 详细设计（lib/index.js）

### 4.1 生命周期

```js
const name = 'dsh-proxy-pro'
const inject = ['tools', 'systemPrompt', 'settings']   // webServer 改可选（ctx.get）
function apply(ctx, config) { … }   // 导出 { Config, apply, inject, name }
```

- **没有 savedEnv / EnvHttpProxyAgent / 手写 dispatcher**：传输完全委托
  `installProxyFromEnvironment`（env + 全局 dispatcher + 模块级策略一体，
  LESSONS §12.4：单一通道，杜绝 undici 错版）。
- `installSettingsSection(ctx, PROXY_NS, Config, config, { setSource, onChange })`，
  onChange → `requestSync()`（合并去重，`syncing` 单飞）。
- teardown（`ctx.effect`）：清 pollTimer → `await httpProxyPolicy?.()`（卸载=恢复
  env/dispatcher/策略）。

### 4.2 sync() 主流程（顺序不可乱）

```
0. haveApplied 守卫：从未启用过且当前不 active → 只记快照，不碰传输层
   （与旧 dsh-plugin-proxy 并存启动时互不抢 dispatcher，NFR-4）
1. resolved = source()
2. if mode=system && enabled: systemProxy = await systemProxyReader()（reg.exe）
3. effective = resolveProxyState(resolved, systemProxy)
4. active 判定：active 时 haveApplied = true
5. ★ 唯一传输通道：await httpProxyPolicy?.()（先卸载旧 policy）
   → httpProxyPolicy = await installProxyFromEnvironment(makeEnvLike(effective), log)
6. snapshot = { ... }; ctx.emit('dsh-proxy-pro/status', summarize(snapshot))
```

`makeEnvLike(effective)`：active 时输出 8 个名字（HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/
NO_PROXY 大小写双写）的 `{ value }` 快照，inactive 时全空；必须带 `.get()`，
且**重新 install 前先 await 旧 policy**（LESSONS §4）。OFF 分支由
installProxyFromEnvironment 的 none-branch 完成：恢复首次安装前的 env + 装直连 Agent。

### 4.3 为什么没有 applyEffective（2026-09-17 重构）

- 旧设计先 `applyEffective`（EnvHttpProxyAgent + 手写 env + savedEnv），随后
  `installProxyFromEnvironment` 又覆盖 dispatcher：后者永远最后赢，前者白建白关，
  还引入两个 undici 实例（profile 7.29.0 vs app 8.10.0）的错版风险（LESSONS §3）。
- dsh-http-proxy 的 `applyPolicyEnv` 本来就写 env（含 ALL_PROXY 兜底 + loopback
  合并），`installGlobalProxy` 装 per-origin Agent dispatcher——三件事一次调用完成。
- 结论：**删除 undici 依赖 + EnvHttpProxyAgent + savedEnv + applyEffective**，
  插件对 undici 零依赖，UND_ERR_INVALID_ARG 这类问题在源头上不存在。

### 4.4 系统代理跟随

- `makeSystemProxyReader(execFileAsync)`（proxy-core.js）——reg.exe 三查
  ProxyEnable / ProxyServer / ProxyOverride（HKCU Internet Settings）。
- `systemPollMs`（默认 30000）轮询；`systemFactsEqual` 判变，没变不重应用。

### 4.5 NTLM 可选诊断（非核心）

- `keepaliveHint(message)`：响应文本命中 `407|NTLM|proxy authentication` 时返回
  一句提示（"先 curl 通一次建 NAT 窗口"），否则返回空串。
- 只在 `proxy_test` / `/api/route` 中使用，不进 sync 主流程，无常驻。

### 4.6 工具契约（与 dsh-plugin-proxy 相同语义 + 新增）

| 工具 | 参数 | 返回（render 摘要） |
|---|---|---|
| proxy_status | – | summarize(snapshot)；active 显示 ON — url (system/custom) |
| proxy_set | enabled: bool | 更新 settings(PROXY_NS) → requestSync → summarize |
| proxy_test | url: string | { url, route: PROXIED url/DIRECT, bypassed: bool, probe: {ok,status/short}, hint? } |

`proxy_test` 内部：`proxyRouteFor(parsed)` 判路由名（try/catch，不可用时回退快照
推导）→ NO_PROXY 列表命中判断 → `fetch(url, {method:'HEAD', redirect:'manual'})`
实测 6s 超时（AbortController）→ `classifyTargetFailure` 归类
（EACCES/ENETUNREACH/EHOSTUNREACH → "needs a proxy route"；407/NTLM → auth）。

### 4.7 系统提示段落

`ctx.systemPrompt.section({ name: 'dsh-proxy-pro:status', order: 55, text: () => renderStatusText(snapshot) })`
——文本与 dsh-plugin-proxy 相同结构（模型必须知道代理是否在力）。

### 4.8 状态 HTTP API（客户端轮询用）

```
GET  /dsh-proxy-pro/api/status           → { ok, status: summarize }
GET  /dsh-proxy-pro/api/route?url=…      → { ok, route, bypassed, probe, hint }
POST /dsh-proxy-pro/api/toggle {enabled} → 更新 settings + sync → { ok, status }
404 其它 / 500 内部错
```

**安全铁律**：handler 首行 `denyIfUntrusted(req, res)`（browser-trust fence：
Host 必须 loopback；`sec-fetch-site: cross-site` 拒绝；origin 异源拒绝；403）。
实现细节抄 skill-manager L131-162（LESSONS §7 有完整清单）。

---

## 5. Client 详细设计（lib/client.js）

### 5.1 骨架（铁律）

```js
window.__ModuleLoader__.load({
  id: "dsh-proxy-pro",
  factory: (require) => {
    const react = require("react");
    const { useSyncExternalStore } = react;   // 或 useState/useEffect 轮询
    const inject = ["slots", "settingsScope"]; // 服务名，不是包名！
    function apply(ctx) { … }
    return { apply, inject };
  }
});
```

⚠️ 不要引入 jsx runtime 构建依赖：用 `react.createElement`（dsh-plugin-proxy 的
client.js 就是这么写的，worked）。样式用注入 `<style data-plugin="dsh-proxy-pro">`
或内联 CSS 字符串，别引 UI 组件库。

### 5.2 设置独立页（FR-1）

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "dsh-proxy-pro",
  order: 20,          // 排在「技能管理」(30) 之前
  label: "代理管理",
}, ProxyManagerPanel));
```

`ProxyManagerPanel` 结构（自上而下）：

| 区块 | 内容 |
|---|---|
| 状态卡 | 大开关（enabled）+ 运行时事实：active ✓/✗、url、mode 标签、reason（红色显示 OFF 原因）、source、最近同步 at |
| 模式 | radio：system（Windows 系统代理）/ custom（自定义地址）/ none（禁用） |
| custom 地址 | input（mode=custom 时启用）placeholder `http://127.0.0.1:7890` |
| NO_PROXY | input（blur 提交）placeholder `localhost,127.0.0.1,::1`，说明行 |
| 诊断 | 输入 URL + 「测试路由」按钮 → 显示 route / bypassed / probe / hint |
| 状态轮询 | 每 3~5s `fetch('/dsh-proxy-pro/api/status')` 刷新状态卡（不刷新表单编辑值） |

- 表单写回：`ctx.settingsScope.bind({ namespace: "proxy" })` →
  `scope.set(field, value)`（与原插件同法）；写回后状态卡等轮询自然刷新。
- 可复用 dsh-plugin-proxy client.js 的 `useProxySnapshot`（useSyncExternalStore +
  scope.subscribe/getSnapshot）。

### 5.3 对话头部按钮（FR-2/FR-3）

```js
ctx.slots.inject("conversation.session.header", () => ctx.slots.register({
  name: "conversation.session.header.utilities",  // list, scope session
  id: "dsh-proxy-pro",
  order: 10,
  label: "代理",
}, ProxyHeaderButton));
```

**关于拖动（用户问过）**：`conversation.session.header.*` 是 slots 布局注入点，
不提供拖拽 API。**决定**：做成「状态胶囊按钮」——圆形状态点（绿=ON 红=OFF）+
标签「代理 · ON/system」；点击切换 enabled（调 `/api/toggle` 或
`scope.set("enabled", !v)`）；title 提示完整 url/status。若要"拖"，留作
README 的延伸议题（可评估在 composer 区域做实验性悬浮，但不承诺进 v0.1）。

### 5.4 状态来源约定

- 按钮与状态卡：**优先用 `/api/status` 轮询的运行时事实**，表单值只是配置编辑层。
- 轮询节流：同一页面两处（设置页/按钮）共用一次 poll 或按钮用长轮询+事件，
  v0.1 允许各自 3~5s 轮询（DSH 是本地回环，开销可忽略）。
- 写路径优先走 settingsScope（声明式、可持久化），`/api/toggle` 仅在需要立即
  拿到最新全文快照时用（二选一即可，别双写）。

---

## 6. 设置 Schema 与过渡

### 6.1 Config（= settings.yaml proxy 段，与现有一致）

```yaml
enabled: true
mode: system            # system | custom | none
customUrl: "http://127.0.0.1:7890"
noProxy: "localhost,127.0.0.1,::1"
systemPollMs: 30000
```

- schema（schemastery）：enabled bool / mode union / customUrl string /
  noProxy string / systemPollMs number min 0。

### 6.2 过渡步骤（NFR-3，2026-09-17 改为 bundle 形态）

1. 本地装入 web profile：
   `dsh plugin --profile web add file:../../plugins/dsh-proxy-pro`
   （发布后即 `add dsh-proxy-pro`；等价包级操作见 §3.1）。
2. profile 的 cordis.patch.yml **同时**把原 `dsh-plugin-proxy` 行改为
   `- id: proxy, disabled: true`（bundle 层 insert 的行可按 id patch），
   **不要动 settings.yaml 任何内容**。
3. 重启 DSH → `proxy_status` 确认 active=true、url=proxyhk → 手动 web_fetch
   一个被墙 URL（如 github）确认 200。
4. 验证 proxy_test github=PROXIED / deepseek=DIRECT。
5. 再对 obsidian-web profile 做同样操作，重复验证。
6. 回滚 = 恢复原插件行 enabled（settings.yaml 没动过，天然安全），或
   `dsh plugin --profile web remove dsh-proxy-pro`。

---

## 7. 验收清单（开发完成逐项打勾）

- [ ] A1 设置页出现「代理管理」，显示 status 真实事实（active/url/noProxy/reason）
- [ ] A2 对话头部有代理按钮，绿点/红点随开关联动，点击切换生效且持久（重启仍在）
- [ ] A3 `proxy_status` 返回与 UI 一致
- [ ] A4 `proxy_set enabled=false` 后 web_fetch 到 github 报 EACCES；true 后 200
- [ ] A5 `proxy_test https://github.com` → route=PROXIED proxyhk…
- [ ] A6 `proxy_test https://www.deepseek.com` → route=DIRECT（NO_PROXY 命中）
- [ ] A7 mode=none 时三通道全关，process.env 无代理变量，web_fetch 直连
- [ ] A8 修改 customUrl（如 127.0.0.1:9999 无效端口）→ status 显示 OFF +
      reason=invalid-custom-url
- [ ] A9 teardown（禁用插件/退出）后 process.env 恢复原状、dispatcher 恢复默认
- [ ] A10 两 profile 均通过 A1-A9
- [ ] A11 拖拽 → 明确降级为胶囊按钮（无拖拽，符合 spec 决定）

---

## 8. 已知风险与开放问题

1. `proxyRouteFor` 不可用（旧版 dsh-http-proxy / 组合里未安装）→ proxy_test 的
   route 降级为快照推导，工具仍可用（try/catch 已兜底）。
2. 两个 profile 同时起两个插件实例 → 各自进程独立，无冲突；同 profile 内与原
   插件二选一（NFR-4）。
3. settings 写回与 `/api/toggle` 双通道可能竞态 → 选一主一辅（§5.4）。
4. 无 jsx 编译 → client 代码保持 createElement 风格，别引非打包可用依赖。
5. NTLM 环境首次启用后若 407，提示文案足够（keepaliveHint），不自动重试。

---

## 9. 开发状态（2026-09-17 更新：v0.1 代码完成并提交）

1. ✅ `lib/proxy-core.js`（16 例单测全过）
2. ✅ `lib/index.js`（host：settings → sync（单一通道）→ 工具 → fence API → poll → teardown）
3. ✅ `lib/client.js`（设置页 → 头部按钮 → 轮询/诊断）
4. ✅ `cordis.patch.yml` / `package.json`（发布形态）+ git init（commit 04eb709）
5. ⏳ 装 web profile → 重启 → 验收 A1-A9（§6.2 步骤）
6. ⏳ obsidian-web profile → 验收 A10；发布 npm 收尾