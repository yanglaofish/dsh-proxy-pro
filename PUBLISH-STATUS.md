# 2.0.3 已发布（2026-10-22）

源码修复与发布标签 `v2.0.3` 已推送，标签指向 `2050964`。发行分支为 `dsh2.x`，开发分支为 `codex/proxy-schema-2.0.3`。

修复了 issue #2 的输出 Schema 遗漏，本地及云端完整测试均为 76 项通过、0 失败、0 跳过，独立规范和需求审查各 0 项遗留。后续 CI 改动只增加状态查询、请求超时与手动续发的版本读取，不改变已打标签的插件源码。

## 最终结果

- 用户确认 npm 后台没有待审核或安全验证提示后继续排查，后续同一凭据的认证与上传恢复。[续发任务](https://github.com/yanglaofish/dsh-proxy-pro/actions/runs/39721595131)的测试、上传前状态查询、发布和发布后查询均成功。未把先前超时武断归因为凭据失效。
- 独立查询官方注册表与淘宝镜像，`latest` 均为 **2.0.3**。
- 从官方注册表独立下载正式 tarball，86,303 字节；SHA-512 与注册表 `dist.integrity` 完全一致。SHA-256 为 `3766ddf42e5fdecf7fe2a77fc874a9066a2f96b0c6dd974c9ed949b0bf022849`。
- 正式归档中的四个 `lib` 文件与 `2050964` 标签源码一致；从正式归档载入 Schema 和诊断逻辑，产生的报告通过真实 `dsh-tools@0.2.1-rc.2` 严格输出校验。结果保存在本地 `.test-runtime/published-verification.json`。
- 镜像查询已独立确认。原续发任务已完成上传，仅剩镜像请求等待时取消；随后补充请求超时并执行[最终发布核验](https://github.com/yanglaofish/dsh-proxy-pro/actions/runs/39722035963)，整个流程成功。云端再次 76/76 通过、0 跳过；上传前后状态均为 `published`，跳过重复上传，主动同步返回 HTTP 201，最终输出 `SYNCED: 2.0.3`。

## 先前阻塞记录

- [首次任务](https://github.com/yanglaofish/dsh-proxy-pro/actions/runs/39710520978)通过全部测试，`npm publish` 在打印提交目标后持续约 7 分钟没有响应，已取消以获取日志；不能确认该次上传是否被接收。
- [第二次诊断](https://github.com/yanglaofish/dsh-proxy-pro/actions/runs/39711430088)和[带超时的重试](https://github.com/yanglaofish/dsh-proxy-pro/actions/runs/39711745797)均通过全部测试，但 `npm whoami` 在 30 秒后报 `FETCH_ERROR`，认证版本状态查询也在 30 秒后超时，未再次进入上传步骤。
- 当时查询公开注册表，`latest` 仍为 `2.0.2`，`2.0.3` 不可见。该阶段没有把源码推送或测试通过当作 npm 发布成功，也没有触发镜像同步。
- 当时尚需核实 npm 后台提示，证据不足以认定 Token 无效或确认上传已受理；后续在不更换凭据的情况下恢复并完成正式发布，见上方最终结果。

## 续发

先用现有状态查询确认上次上传是否被接收。查询成功且显示已受理时不再上传，等公开注册表可见后同步镜像；明确返回不存在时才执行上传。Token 模式使用 `NPM`，OIDC 模式另用只读 `NPM_STATUS` 查询状态，缺少查询凭据时停止并明确提示。

发布流程可从 `codex/proxy-schema-2.0.3` 或 `dsh2.x` 手动执行。保留 `v2.0.3` 标签，不移动已经发出的版本标签。
