# dsh-proxy-pro

一个 DeepSeek Harness（DSH）插件的**代理管理器**：把整个运行时（模型请求、web_search / web_fetch、spawned 工具）统一路由到 **Windows 系统代理**或**自定义地址**，并提供随时可见、一键切换、可诊断的体验。

区别于原 dsh-plugin-proxy 的核心差异：

- **web_fetch / web_search 真正走代理**。原插件只换 undici 全局 dispatcher + env，而 `dsh-web-fetch-http` 的 `proxyRouteFor()` 只读 `@deepseek-ai/dsh-http-proxy` 的模块级策略——本插件通过 `installProxyFromEnvironment()` 纳入这条通道，web_fetch 的网络故障（`fetch failed`）被根治。
- **对话头部一键开关**：每会话头部胶囊按钮（绿 = ON / 红 = OFF），点击即切换；「关→开」兼作手动重检——触发 host 现读注册表并重新应用，代理出问题时直接在头部拨一下即可。
- **设置页「代理配置」**：显示运行时事实（生效地址 / 原因 / 直连名单）而非设置推断；模式仅「系统代理（Windows）/ 自定义地址」两个选项；内置按 URL 的路由诊断（PROXIED / DIRECT 判定 + 强制走代理 / 强制直连双通道探测 + NTLM 提示）。
- **单一传输通道**：env + dispatcher + 策略由 dsh-http-proxy 一体管理，插件不直接触碰 undici，杜绝双实例错版（`UND_ERR_INVALID_ARG`）。
- **幂等内核**：`effKey` 相同只刷快照、绝不重装 dispatcher——读型 API 与轮询永不触发重组（修复过"每次拉都重装导致桌面卡顿"的根因）；「拉时现读」让页面看到的永远是新鲜事实而无需任何定时器。
- **干净卸载**：卸除时恢复 env / dispatcher / 策略，fire-and-forget 后台排空 keep-alive。

> 全部踩坑与设计决策见 [`docs/LESSONS.md`](docs/LESSONS.md)（必读），规格与验收清单见 [`docs/SPEC.md`](docs/SPEC.md)。

## 安装

两种方式任选其一（npm 包已发布，拉取即用、免构建授权）：

**方式 A：npm 安装（推荐）**

```sh
dsh plugin --profile web add @yanglaofish/dsh-proxy-pro
dsh plugin --profile obsidian-web add @yanglaofish/dsh-proxy-pro
```

**方式 B：GitHub 源安装**

```sh
dsh plugin --profile web add github:yanglaofish/dsh-proxy-pro
```

安装完成后直接启动：

```sh
dsh web
```

## 使用

**对话头部胶囊按钮** —— 每会话头部右侧的「代理 · ON system / OFF」：绿点 = 代理生效、红点 = 关闭；一点切换总开关。头部按钮为配置驱动（打开即绿、零轮询），「关→开」操作触发 host 现读系统注册表并重新应用——代理状态异常时，直接在头部拨一下即可重检修复。

**设置 → 代理配置** ——

- **状态行（置顶）**：生效地址 + 原因说明；右侧短小启用开关，切换立即生效。
- **代理地址来源**：仅「系统代理（Windows）」与「自定义地址」两个选项。「不使用代理」模式已从界面与 `proxy_config` 工具移除（scheme 保留 `none` 仅解析旧配置残留）。
- **自定义地址**：`http://host:port` 或裸 `host:port`。
- **直连名单（NO_PROXY）**：编辑框下方显示**当前生效名单**；`system` 模式自动并入 Windows 系统 ProxyOverride（标注「含并入」），`custom` 模式只保留你自己的名单（不并入系统白名单）。
- **路由诊断**：输入 URL，勾选「使用代理」= 强制走代理探测 / 不勾 = 强制直连探测；对比两次结果即可判断该域名该不该加进直连名单。

**模型侧** —— 系统提示实时标注代理状态；四个工具：

- `proxy_status` — 查询当前状态：是否走代理、生效地址、NO_PROXY 名单、来源。
- `proxy_set` — 一键开/关整个运行时（改配置持久化并立即生效）。
- `proxy_test` — 单 URL 路由诊断：PROXIED / DIRECT 判定、NO_PROXY 命中、连通探测；HTTP 407 归类为 NTLM 认证失败并给出 keepalive 提示。
- `proxy_config` — 读/改配置：开关、模式（system / custom）、自定义地址、NO_PROXY；可只传任意子集。

## 配置（`settings.yaml` `proxy:` 段，零迁移）

```yaml
proxy:
  enabled: false
  mode: system          # system | custom（none 仅解析旧配置残留）
  customUrl: http://127.0.0.1:7890
  noProxy: localhost,127.0.0.1,::1
  systemPollMs: 30000
```

## 卸载

```sh
dsh plugin --profile web remove @yanglaofish/dsh-proxy-pro
dsh plugin --profile obsidian-web remove @yanglaofish/dsh-proxy-pro
```

卸载即恢复原始路由行为，不留残留。

## 技术方案

### 整体架构

插件由「宿主侧」（Node，随 DSH 主进程运行）与「客户端侧」（浏览器 bundle，随 Web UI 运行）两部分组成，通过 `/dsh-proxy-pro/api/*` 自注册 HTTP 接口衔接（浏览器信任围栏保护）。宿主侧为原生 ESM（无编译步骤），客户端侧为手写 `react.createElement` 的原生 JS bundle。

```
dsh-proxy-pro
├── lib/
│   ├── index.js               宿主侧（原生 ESM，无需编译）
│   │   ├── apply()           settings 钩子 → 幂等 sync → 4 个工具 →
│   │   │                     systemPrompt 段 → webServer API → 30s poll → teardown
│   │   └── 模块级函数        probeTarget / forceChannelProbe（双通道探测）、
│   │                         browser-trust fence（loopback + sec-fetch-site + origin）
│   ├── client.js              客户端 bundle（__ModuleLoader__ 包装）
│   │   ├── ProxyHeaderButton   对话头部胶囊：配置驱动、点击切换、关→开重检
│   │   └── ProxyManagerPanel   设置页：状态行+开关、模式、自定义地址、直连名单、路由诊断
│   ├── proxy-core.js          纯逻辑层（零 DSH 依赖，可独立单测）
│   └── tool-schemas.js        dsh-tools 值 schema（编译前置校验）
├── cordis.patch.yml          bundle patch：挂载宿主侧插件行
├── test/
│   ├── proxy-core.test.mjs    逻辑层单测（26 条）
│   └── tool-schema.test.mjs   工具 schema 编译前置校验（真实编译器）
├── README.md
└── package.json              bundle 清单：exports + dsh.client 声明（v1.0.0）
```

**核心设计原则**：单一传输通道 + 幂等内核。所有路由决策经 `installProxyFromEnvironment(envLike)` 一个通道落地（写 env → 装 per-origin dispatcher → 模块级策略供 `proxyRouteFor()` 读取，web_fetch 因此也走代理）；`sync()` 以 effKey 幂等——有效状态未变时只刷新快照、绝不重装 dispatcher。「拉时现读」：client 每次拉 `/status` 都触发一次幂等 requestSync（同状态零重装），页面看到的永远是新鲜事实而无需任何定时器；host 30s poll 独立承担无人值守跟随——设置页关闭时系统代理变化仍会被发现并重新应用。

### 关键模块

| 模块 | 职责 |
| --- | --- |
| `resolveProxyState / composeNoProxy` | 由配置 +（system 模式）实时注册表事实推导生效代理；系统 ProxyOverride **仅在 system 模式**并入 NO_PROXY，custom 模式保留用户自己的名单 |
| `makeSystemProxyReader` | 三次 `reg.exe` 查询（ProxyEnable / ProxyServer / ProxyOverride）解析为事实集 |
| `sync / requestSync / effKey` | 幂等应用：写 env + dispatcher + 策略只发生在有效状态真正变化时；合并并发触发 |
| `probeTarget / forceChannelProbe` | 按策略 / 强制代理 / 强制直连三通道探测；407 归类为 NTLM 认证失败并给出 keepalive 提示 |
| `isTrustedPanelRequest` | 镜像 dsh 官方 `/api` 围栏：Host loopback（防 DNS rebinding）+ sec-fetch-site 同源 + Origin 校验 |
| `useStatusOnce / useProxySnapshot` | client 侧：配置驱动显示 + 拉时现读；快照经 settingsScope 订阅 |

### 数据流

**拉取（/status）**：client 拉取 → host `await requestSync()`（读注册表 → effKey 比较 → 未变仅刷快照，变了才重装）→ 返回最新 summarize 快照。无定时轮询。

**切换（/toggle、头部按钮、proxy_set）**：settings 更新 → host 钩子 requestSync → 现读注册表 + 重应用 → 快照更新；幂等保证同状态重复调用零开销。

**跟随（30s poll）**：仅 system 模式且启用时读注册表，事实变化才 requestSync（`systemFactsEqual` 比较含 http/https 单边变化）。

**排查（工具链路）**：`proxy_status` / `proxy_test` / `proxy_config` / `proxy_set` 的 execute 均先 `requestSync()`——模型排查时看到的永远是最新注册表事实与生效状态。

### 关键设计细节

- **幂等 sync（LESSONS §17）**：effKey 含 active / url / http / https / noProxy / reason——https 单边变化也会触发重装，`HTTPS_PROXY` 真正切换；读型 API 与轮询永不触发无条件重装（旧版"每次拉都重装"是桌面卡顿根因）。
- **卸载不卡**：disposer 的 `agent.close()` 排空 keep-alive 可能阻塞数秒，卸除改为 fire-and-forget，让连接池后台排空。
- **浏览器信任围栏**：面板 API 与 dsh 官方 `/api` 一致的三重防线（loopback Host / sec-fetch-site / Origin），纯头判定、零额外依赖。
- **工具 schema 前置校验**：`test/tool-schema.test.mjs` 用真实 dsh-tools 编译器在应用启动前编译全部工具 schema——boot-time 崩溃类问题不再出现（LESSONS §15）。
- **依赖取舍**：undici 零直接依赖（避免实例错版）；peerDependencies 对齐运行时 `@deepseek-ai/*` 版本（解析由 DSH profile resolver 兜底到 app 副本）。

## 开发

```sh
# 语法检查
node --check lib/index.js lib/client.js lib/proxy-core.js

# 运行 26+ 条单测（node --test，零运行时依赖）
npm test
```

- 纯逻辑层 `lib/proxy-core.js` 零 DSH 依赖，可独立单测。
- **GitHub 安装模式**：改代码需 `git push` 后 `pnpm update @yanglaofish/dsh-proxy-pro` 再重启 `dsh web` 生效。
- **npm 安装模式**：bump 版本 → `npm publish --registry=https://registry.npmjs.org` 后，profile 内 `pnpm add @yanglaofish/dsh-proxy-pro@最新版` 再重启 `dsh web` 生效。
- **本地开发模式**（改代码重启即生效）：`dsh plugin --profile web add file:../../plugins/dsh-proxy-pro`。

## 许可

MIT