# dsh-proxy-pro

一个 DeepSeek Harness（DSH）插件的**代理管理器**：把整个运行时统一路由到
Windows 系统代理或自定义地址，并提供随时可见、可一键切换、可诊断的体验。

区别于原 dsh-plugin-proxy 的核心差异：

- **web_fetch / web_search 真正走代理**。原插件只换 undici 全局 dispatcher + env，
  而 `dsh-web-fetch-http` 的 `proxyRouteFor()` 只读 `@deepseek-ai/dsh-http-proxy`
  的模块级策略——本插件通过 `installProxyFromEnvironment()` 纳入这条通道，
  web_fetch 的网络故障（`fetch failed`）被根治。
- **对话头部一键开关**（每会话头部右侧胶囊按钮，实时状态）。
- **设置页「代理管理」**：显示运行时事实（生效地址 / 原因 / 直连名单），
  不是设置推断；内置按 URL 的路由诊断（PROXIED / DIRECT / 连通探测 / NTLM 提示）。
- **单一传输通道**：env + dispatcher + 策略由 dsh-http-proxy 一体管理，
  插件不直接触碰 undici，杜绝双实例错版（`UND_ERR_INVALID_ARG`）。
- **干净卸载**：卸除时恢复 env / dispatcher / 策略。

> 全部踩坑与设计决策见 [`docs/LESSONS.md`](docs/LESSONS.md)（必读），
> 规格与验收清单见 [`docs/SPEC.md`](docs/SPEC.md)。

## 安装

两种方式任选其一（npm 包发布后）：

**方式 A：npm 安装**

```sh
dsh plugin --profile web add dsh-proxy-pro
dsh plugin --profile obsidian-web add dsh-proxy-pro
```

**方式 B：GitHub 源码安装**

```sh
dsh plugin --profile web add github:<owner>/dsh-proxy-pro
```

本地开发期（未发布）：把本目录以 `file:` 依赖装进 profile：

```sh
dsh plugin --profile web add file:../../plugins/dsh-proxy-pro
```

安装完成后重启生效：

```sh
dsh web
```

## 使用

- **对话头部按钮**：每会话头部右侧的「代理」胶囊，显示 ON/OFF 实时状态，一点切换。
- **设置 → 代理管理**：总开关、地址来源（系统代理 / 自定义 / 不使用）、
  自定义地址、NO_PROXY 直连名单、按 URL 的路由诊断。
- **模型侧**：系统提示实时标注代理状态；工具 `proxy_status`（查询）、
  `proxy_set`（开关）、`proxy_test`（单 URL 诊断）。

## 配置（`settings.yaml` `proxy:` 段，零迁移）

```yaml
proxy:
  enabled: false
  mode: system          # system | custom | none
  customUrl: http://127.0.0.1:7890
  noProxy: localhost,127.0.0.1,::1
  systemPollMs: 30000
```

## 卸载

```sh
dsh plugin --profile web remove dsh-proxy-pro
dsh plugin --profile obsidian-web remove dsh-proxy-pro
```

卸载即恢复原始路由行为，不留残留。

## 技术方案

- 传输完全委托 `@deepseek-ai/dsh-http-proxy` 的
  `installProxyFromEnvironment(envLike)`：resolve 策略 → 写 env → 装 per-origin
  dispatcher → 模块级策略供 `proxyRouteFor()` 读取（web_fetch 通道）。
- 纯逻辑层 `lib/proxy-core.js` 零 DSH 依赖，可独立单测（`npm test`）。
- 浏览器半为 `window.__ModuleLoader__.load` 格式（无 JSX / 无打包），
  通过 `settingsScope`（写）与 `/dsh-proxy-pro/api`（读运行时事实）与 host 通信；
  API 走与 dsh 官方 `/api` 一致的 browser-trust fence（loopback + same-origin）。
- 依赖取舍：`undici` 零依赖（避免实例错版）；peerDependencies 对齐运行时的
  `@deepseek-ai/*` 版本（解析由 DSH profile resolver 兜底到 app 副本）。