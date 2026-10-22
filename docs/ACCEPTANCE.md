# dsh-proxy-pro v0.1 验收清单（自验版）

## 2.0.3 严格输出 Schema 补丁（2026-10-22）

- 对应 [issue #2](https://github.com/yanglaofish/dsh-proxy-pro/issues/2)：`proxy_test` 实际返回的 `proxyBadge`、`directBadge` 漏声明，导致新版 DSH 拒绝整个工具结果。
- 输出 Schema 补齐两个徽标，内含必填 `text` 和 `tone`（`ok` / `warn` / `bad`）；徽标本身可省略，以兼容无效 URL 的提前返回。保留 `additionalProperties: false`。
- 新增实际工具执行与真实 DSH 校验器的合同回归，覆盖四个工具、双通道成功、单通道失败、407 认证、403/404、网关及 DNS 故障、代理关闭、无效 URL；同时验证未知字段、非法颜色和缺失徽标文本仍被拒绝。
- 本地先复现相同的未声明属性错误，再修复；使用 `@deepseek-ai/dsh-tools@0.2.1-rc.2`，完整测试 76 项通过、0 失败、0 跳过。测试传输使用隔离替身，不将此记录描述为公网或桌面人工验收。
- 自基线 `663e5c1` 的独立规范与需求审查分别为 0 项遗留问题；语法、差异空白检查及 npm 归档中的徽标声明检查通过。
- 发布流程安装隔离的固定版测试运行时，执行同一严格校验后才发布。开发者可先执行 `npm install --prefix .test-runtime --no-save --package-lock=false --ignore-scripts @deepseek-ai/dsh-tools@0.2.1-rc.2 --registry=https://registry.npmjs.org`，再执行 `npm test`。未安装时真实编译/输出校验会明确标为跳过。
- npm 与镜像的实际发布结果在确认后补充；此条测试记录不代表包已公开。

> 用途：重启 DSH 后逐项自验插件是否生效。每项给出「看哪里」与「预期结果」；
> 标 🔵 的项需要会话内的模型（我）代跑，标 👁 的项你自己在界面上看。
> 全部通过 = FR-1..FR-9（SPEC §7 A1-A11）达成，可以进入「接管旧插件 → 发布」。

## 0. 前置（已就绪，无需操作）

- [x] 单测 16/16 通过、语法 OK、git 干净（head = afb96b4）
- [x] web / test 两 profile 已装入 `dsh-proxy-pro`（node_modules 为 Junction 软链）
- [x] `dsh --dump-config` 预检：两 profile 组合树均含 `- id: dsh-proxy-pro` 行
- [x] settings.yaml 的 `proxy.enabled: true` → 重启后插件**启动即接管**系统代理（预期行为）

## 1. 重启（唯一的前置动作）

关闭 DSH 桌面应用再重新打开（bundle 行只在启动时编排，无法热加载）。

## 2. 挂载确认（重启后第一步）

| # | 通道 | 看哪里 | 预期 |
|---|---|---|---|
| 👁 A1 | GUI | 设置 → 「代理管理」页存在，显示真实事实 | 状态行「代理生效中 · <系统代理地址>」，开关为开 |
| 👁 A2 | GUI | 对话头部右侧 | 「代理 · ON system」胶囊（绿点） |
| 🔵 A3 | 工具 | 让我跑 `proxy_status` | `active:true, mode:system, url:<系统代理>, source:system` |

> 本地 curl 打 `/dsh-proxy-pro/api/status` 会 403——这是应用对未认证请求的安全门，
> **不是故障**，别用它判断。浏览器内（GUI 页面）同源请求不受影响。

## 3. 功能验收

| # | 通道 | 操作 | 预期 |
|---|---|---|---|
| 🔵 A5 | 工具 | `proxy_test https://github.com` | `route: PROXIED <系统代理>`、probe ok |
| 🔵 A6 | 工具 | `proxy_test https://www.deepseek.com` | `route: DIRECT`（NO_PROXY 命中）|
| 🔵 A4 | 实测 | `web_fetch` 一个被墙 URL（如 github 页面） | 成功返回（此前会 `fetch failed`）= FR-7 修复达成 |
| 🔵 A7 | 工具 | `proxy_set enabled=false` → `web_fetch` 再试 | 走直连（被墙域可能失败）；再 `proxy_set enabled=true` 恢复 |
| 👁 A8 | GUI | 设置页把「代理地址来源」切「自定义地址」填 `http://127.0.0.1:9999` | 状态行变「未生效 · 自定义地址无效」，恢复为系统代理 |
| 🔵 A9 | 观察 | 卸载/退出后 `Get-Process` + env | 代理环境变量与 dispatcher 恢复（不进脚本，靠代码审查保证）|
| 🔵 A12 | 工具 | `proxy_config` 无参读 → 改 `noProxy`/`mode` | 无参返回当前配置；改后 settings.yaml 同步且状态立即变化；非法地址（`"not a url"`）报清晰错误 |

## 4. 异常排查

| 现象 | 含义 | 处理 |
|---|---|---|
| 重启后头部无胶囊、设置无「代理管理」 | client 半未加载 | 把启动日志贴给我（`%APPDATA%\DSH Desktop\logs\dsh-<日期>.log`）|
| GUI 在、但设置页显示「状态 API 不可用」 | host API 未注册 | 同上，查日志里 dsh-proxy-pro 相关行 |
| `proxy_status` 报错/工具不存在 | host 半未 mount | 同上 |
| 拨开关后 web_fetch 仍失败 | 代理策略未接管 | 先 `proxy_test` 看 route，再贴日志 |

## 5. 接管旧插件（可选，验收全绿后）

`<profile>/cordis.patch.yml` 追加一行 `- id: proxy, disabled: true`（禁旧
dsh-plugin-proxy）→ 重启 → 复测 A1-A6。回滚 = 删该行，settings.yaml 全程不动。

## 6. test 复用

用 `dsh --profile test` 启动 → 重复 §2-§3（A10）。

---

_维护：本清单与 SPEC §7 验收清单一一对应；观察通道约定见 SPEC §7 附录。_
