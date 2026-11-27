# Linux systemd 单元准备

首轮使用一份发布目录和当前 Web、Worker 入口。发布工具在运行现有 `prepareServiceBuildManifest` 之前，将以下无秘密配置写入 `apps/worker/dist/linux-service-config.json`。同时把同源的 `scripts/linux/service-manager.mjs` 原字节复制为 `apps/worker/dist/linux-service-manager.mjs`。现有 manifest 枚举整个 Worker dist，由它封签配置和开机前挂载检查脚本。在现有封签准备器允许的 Git 发布目录构建和封签，再把完整已封签发布复制到安装根。认定发布以准备步骤交付的独立 `manifestDigest` 为准。

发布操作员在一份独占的构建目录中先备齐这两个文件，再运行 `node scripts/dev-release/prepare-identity.mjs --root="$RELEASE" --release-sha="$SHA"`（需要私有 Host 配置时按现有流程传 `--person-vm-config`）。配置源放在发布树外或已忽略的 `.local/`，保持 Git 树干净。封签生成前结束所有构建和复制操作，生成后固定整份发布目录。线下 fixture 使用现有封签函数和真实 `render` 命令验证输入及篡改，宿主挂载身份由模拟探针覆盖。

```json
{
  "platform": "linux/arm64",
  "socketRoot": "/run/ar",
  "dataMount": "/var/lib/allrice40",
  "dataUuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "node": "/opt/allrice40/node/bin/node",
  "webPort": 3000,
  "workerPort": 3101
}
```

- `node scripts/linux/service-manager.mjs render RELEASE EXPECTED_MANIFEST_DIGEST` 校验 seal 及两入口，输出单元。
- 验收后在 arm64 Linux 用发布操作员执行 `install RELEASE EXPECTED_MANIFEST_DIGEST`，仅允许新建或原字节重复安装，并调用 `daemon-reload`。安装前确认宿主未配置外部激活器，包括活动单元定义中的 `Upholds=`。安装器检查 PID 1 可见的反向依赖及磁盘激活链接。同名活动服务、既有激活配置、mask、drop-in 或文件差异时保留原件，交发布负责人按 drain、迁移、健康验收及回滚顺序切换。启用与启动由发布操作员单独执行。
- release 安装在 `/opt/allrice40/releases/`，发布及 manifest 路径由部署操作员保护，服务以 `allrice` 启动。外部预先配置合适的账户、kvm 组、真实数据卷、数据库和根所有的 `/etc/allrice40/{web,worker}.env`。私有环境文件由 systemd 读取。准备阶段保证服务账号可读既有 `.local` 两份封签和私有 Host 配置，按 seal 的 uid/0600 要求检查。Worker 环境需经已有批准链取得 `ALLRICE_DSH_NATIVE_ARTIFACT_ID`。在核准数据卷预先创建服务账号可用的 `storage`、`executions`、`dsh-runtime`。Web 使用同一封签的 Worker 端口。两服务绑定本机，数据库或 Tunnel 由另一个经授权的安装步骤管理。
- Worker 单元保留短运行目录，等正常关闭并禁止 systemd 自动强杀。主机停机必须先取得真实 Host drain、数据库落盘与停止证明。安装和单元生成就绪不代表应用 release、Person VM、迁移或宿主停止已经通过。

Mac LaunchAgent 保持当前发布方式。实际部署需等 Linux person-vm 平台装配合入并在目标机验 setup、service readiness、停止与回滚。
