# 4.0 公网从零验收

在真实 Chromium 中检查首个 4.0 员工的工作台。默认离线演练冷、温两态。`--live` 仅冷启，公开入口固定为 `https://allricevm.bplabs.xyz/`，仅在发布负责人已经准备好验收员和受管清理时执行。离线 fixture 在 Playwright 内完成全部响应，Chromium 同时关闭代理和 DNS 解析。

## 离线执行

使用仓库锁定的 Node 22.23.2、`@allrice/web` 的 Playwright 和已安装的 Chromium。`ALLRICE_BROWSER_EXECUTABLE` 可指定本机浏览器可执行文件。若省略 `--output`，脚本会新建一个临时证据目录。

```sh
node scripts/acceptance/public-greenfield/run.mjs --output /tmp/allrice-greenfield-run
ALLRICE_RUN_BROWSER_INTEGRATION=1 pnpm exec vitest run --maxWorkers=1 \
  scripts/acceptance/public-greenfield/greenfield.test.mjs \
  scripts/acceptance/public-greenfield/greenfield.browser.test.mjs
```

`receipt.json` 含合成来源、起止版本校验、账号/4.0 名单、首次员工、轮询序列、冷/温工作台、关机及保留结果。账号、Cookie、请求体、VM 标识和截图不进回执。第一次失败单写 `first-failure.json`，后续关机失败单独记录。每次运行新建目录并拒绝覆盖。退出码 `0` 表示离线演练通过，`1` 表示演练失败，`2` 表示前置阻塞、参数或证据目录错误。

冷启动要求页面自身一次 prewarm `202`，跟踪同一张 ticket 的串行有界轮询直到 `ready`。回执记录上一份响应到下次请求的单调时钟间隔，首轮按 `pollAfterMs`，后续每轮增加 1 秒，最高 3 秒，允许 50ms 观测误差。温启动只重开同一员工及空线程一次，要求 prewarm `204`。探针核对本次新建员工的 revision/version、page carrier 签发的 scope，以及实际加载的同源原生 iframe，再检查 composer 可编辑并可聚焦。fixture 在 Playwright 内模拟既有 `native-mux` 的 page 打开回执。

首开页自己产生的 4.0 空线程和 native root 属于正常打开工作台。探针仅聚焦 composer。冷预热派发后，清理需要受管来源证实本次未分配，或拿到本次分配时的 `personId`、`organizationId`、`vmId`、`instanceId`、`leaseEpoch`。调用 stop 前和验证停止回执时分别核对全部五个字段。仅知仍在分配、绑定未知或绑定已替换时，另记清理失败并保留首败。

当前可量的是登录 HTTP 及从打开公网入口到 4.0 URL、员工创建 HTTP、冷 `202` 首包、收到预热就绪、冷/温编辑器可交互的浏览器时间。零员工标题在 4.0 URL 检查后等待。冷编辑器总耗时从提交建员工开始。预热就绪由 Worker 判定后经轮询外显，包含轮询延迟。独立系统盘、缓存、VM boot、guest 内 DSH ready 耗时留空。若以后发布负责人能给同一次实例及 epoch 的受管原始分段，才补这些值。

## 公网执行

发布负责人须先确认当次窗口、已部署的 main 的完整 SHA/tree/封签、#23 异步预热、#41 首个员工、DSH 启动与封签版本，以及已有验收员和工作区。按人名单由负责人读取和更新，保留默认 `3.x` 和其余选择。此脚本以经过两人清零流程的验收员登录，不代建账号或修改灰度。公网流程做一次建员、一次冷 202 和同票轮询，检查工作台的员工 / 线程 / 原生 scope 以及可聚焦和可编辑的 composer。报告记录登录、零员工、建员、202、预热 ready、可输入的浏览器耗时，设备内盘、缓存和 DSH 分段缺证据时保留 `null`。

```sh
node scripts/acceptance/public-greenfield/run.mjs --live --allow-public-writes \
  --release-sha "$TARGET" --release-tree "$TREE" --release-seal "$SEAL" \
  --credentials "$PRIVATE/acceptance.json" --managed-owner "$PRIVATE/owner.mjs" \
  --managed-owner-sha256 "$APPROVED_OWNER_SHA256" \
  --output "$OUT/greenfield"
```

`acceptance.json` 为仓库外的私有普通文件，当前操作员属主、模式 `0600`。它只含 `username`、`password`、`organizationId`、`personId`、`workspaceId`。只使用从发布负责人取得的验收员资料。用户名、口令、Cookie、原生消息、票据和物理实例身份都不进入回执。关闭 Playwright 调试。运行前后独立核对 Web/Worker 与相同 release 和进程 boot ID。

只有本次获准发送时才加 `--send-hello`。点击前重新核对发布、进程和本次票据的运行实例，写 `hello-intent.json`。浏览器一次点击，同一原生根会话仅放行一次单文本 `session/prompt`，内容为“你好”。同一回合分别记录点击到 iframe 首条非空回复、原生回合完成和 iframe 完整回复。回执留计时、状态和关联摘要。发送或回执未知时结束，保持首败并交负责人查原回合。Ctrl+C 和 SIGTERM 停止新的浏览器操作，并转入同一票据的受管收尾。

### 受管 Host 前置

当前生产 authority 只开放 read/create/start，现有恢复 socket 未提供 exact-owner 停机动作。`--managed-owner` 必须是发布负责人审核且安装在仓库外本机 `0700` 目录的 `0600` 模块，使用已批准生产 Host 能力。摘要从负责人审核记录取得。缺实际 Host 能力时不提供模块。工具会在读凭据和访问公网之前返回阻塞。模块是受信操作员代码，其依赖绑定已发布版本，目录由负责人独占且本轮保持静止。不得用合成结果或可编辑 JSON 充当权威回执。

模块具名导出 `managedOwner`，每次操作遵守传入的 `signal` 并在退出时会合。需要以下现有事实：

- `prepare({ identity, username, release, signal })` 在独占验收窗口读回普通验收员的精确 `{ organizationId, personId, workspaceId }`、username、`role: '验收员'`、`state: 'zero-employee-no-vm'`、`personScopedRelease: true`。
- `workerHealth({ release, signal })` 返回该受管 Worker 的 `{ status, body }`。
- `operationResult({ identity, operationId, signal })` 用真实 202 票查本次分配，回相同 `operationId` 和 `state: 'allocated'` + `binding`，或已确认的 `state: 'unallocated'`。未知或仍在建时失败保留。关闭浏览器后还需 `carrierJoined: true`。`exactVm({ identity, signal })` 读回当前绑定，用 `vmId/personId/organizationId/instanceId/leaseEpoch` 对账；发送前查 `state: 'running'`。
- `stopExact({ binding, signal })` 在同一个受权 Host 租约内再次核身份并仅停该 VM，返回同一绑定及 `state: 'stopped'`、`diskRetained/accountRetained/unmounted/leaseReleased/portReleased: true`。停后用 `exactVm` 独立读回绑定、停止和物理资源状态。`close({ signal })` 归还本模块占用的窗口和连接。脚本没有公共停机 URL。

离线验收覆盖 Chromium 的回环 HTTP 重定向和会话 Cookie、模拟 WebSocket 转发，以及模拟 Host 和原生回执。正式 Host 接线、真实公网与模型验收分别等待发布窗口。缺少新员工版本、已核生产 Host 接口或绑定权限时，退出 `2` 并保留阻塞回执。
