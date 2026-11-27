# Person VM 宿主路径检查

`resolveHostLayout(config, host)` 由发布装配在核完封签后调用。平台从封签传入，真实主机只核匹配。Darwin 仍提供原配置的 socketRoot，Linux 固定用 systemd 管理的 `/run/ar`。MSB v0.7.16 的控制路径保留完整 VM UUID 和原生目录摘要，并在两个平台上使用现行小于 104 UTF-8 字节的边界。

本片交辅助模块和测试。接入 Worker 封签、现有 provider 和恢复口要等正在改这些路径的 #25 与相关片合入后再做。盘、恢复口临时目录、LaunchAgent 及 Mac 产品入口保持原路径。测试用 `pnpm exec vitest run scripts/linux/host-layout.test.mjs`。
