# 2026-10-28 兼容性适配记录

> 下文保留发包前的核查快照。随后用户已授权完成 code-review 并走发包流程，
> 审查结论见 [发布审查记录](RELEASE-REVIEW-20261028.md)，发布结果见仓库根目录 PUBLISH-STATUS.md。

本地候选版本为 **2.0.4，尚未发布 npm**。分支为 `codex/proxy-host-compat-2.0.4`，
起点为 `cd57b3a`（与远端 `dsh2.x` 一致）。官方 npm `latest` 和实际桌面安装均为 `2.0.3`。
本轮没有改动实际安装包、用户代理配置或运行中的应用。

## 上游反馈核查

- [issue #2](https://github.com/yanglaofish/dsh-proxy-pro/issues/2) 的徽标 Schema 遗漏已在
  2.0.3 修复并发布；本轮保留真实工具输出严格校验回归，没有重复修改诊断结果。
- [PR #1](https://github.com/yanglaofish/dsh-proxy-pro/pull/1) 针对历史 `master` 分支提出
  0.2.0-rc.2 与 NO_PROXY 通配符适配，尚未合并且有冲突。当前工作基于 `dsh2.x`，
  2.x 清单和代理回归已覆盖这些行为，不直接把针对历史分支的 PR 整包合入。
- 姊妹插件技能管理器的 [issue #3](https://github.com/yanglaofish/dsh-skill-manager/issues/3)
  暴露出相同的 loopback 面板限制，本轮同步修复代理面板。

## 适配内容

面板每次请求读取 `ctx.get('connection')`，使用宿主 `requestRejection(req)`：
可信域名、反向代理、Origin、端口和浏览器/API 凭据保持与宿主一致。
未认证返回 401，不可信、校验异常或已有服务缺少准入接口返回 403；检查发生在读取配置、解析请求体和网络诊断之前。
无 connection 的组合保留已有 loopback 同源围栏。代理环境、路由策略与 Schema 保持现有行为。

## 验证

```powershell
npm test
node scripts/verify-desktop-runtime.mjs "$env:LOCALAPPDATA/Programs/DeepSeek Harness"
node scripts/verify-desktop-runtime.mjs 'E:/Agenttools/deepseek/app'
```

- 78 项自动化测试通过，0 失败、0 跳过；包括真实 dsh-tools 编译与工具返回值严格校验。
- 新增两项面板回归在修复前失败，修复后通过。
- `0.2.0-rc.2` 与 `0.2.1-rc.3` 真实桌面依赖下均通过代理冒烟：
  启动首请求经过认证代理，本地地址直连，双进程共享代理时关闭 A 不影响 B，状态不泄漏认证。
- 冒烟同时使用真实 HostConnectionService 验证面板可信域名、错误端口、跨域和 401/403。
  凭据签名验证由固定测试值代替，未执行真实浏览器登录与界面手动验收。

独立审查未发现代理改动中的 P0/P1/P2 问题；已有 connection 缺失准入方法的拒绝逻辑
也已补回归，确认不会降级绕过认证。

## 安装与恢复边界

实际桌面仍使用正式 `2.0.3`。本地 `2.0.4` 需要通过桌面端插件管理安装或走正式发布流程，
不能把源码版本号当成已安装或已发布。没有自动评论/关闭 issue、推送、打标签或重启桌面。

修改前 Git 历史保存在 `E:/Agenttools/deepseek/backups/proxy-host-compat-20261028/source.bundle`。
源码可切回 `codex/proxy-schema-2.0.3`（`cd57b3a`）。本轮未修改实际安装包，因此无需恢复用户代理配置。
