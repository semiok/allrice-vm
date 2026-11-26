# 4.0 公网从零验收

在真实 Chromium 中演练测试账号首次进入 4.0 工作台和一次温启动。当前运行方式为离线 fixture。`--live` 执行本地前置检查并返回阻塞回执。公共浏览器入口固定为 `https://allricevm.bplabs.xyz/`。fixture 在 Playwright 内完成所有响应，Chromium 同时关闭代理和 DNS 解析。

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

## 公网执行所缺前置

`--live --allow-public-writes --release-sha <完整 SHA> --release-tree <完整 tree>` 只做本地核对。阻塞回执保存格式合法的请求 SHA/tree，以及按同一提交解析的本地 `refs/remotes/origin/main` SHA/tree。前置齐备后仍须获得当次真人公网写入授权。当前缺口如下。

- 合入并部署 #23 异步 prewarm、零员工创建、系统盘与 DSH 启动修复。当前 Git 锚点为 `4f28b4c4`、`efb1537e`、`70042d3c`。若正式头经 squash/rebase 或更新，先审验最终合入提交并更新锚点。源码祖先核对仅能证明已核定候选进入本地 `origin/main`。实际运行前后还需核对公网 `/api/health/ready` 的 Web 身份和发布负责人的 Worker 已验证身份，repo、SHA、tree 对齐且进程未变。
- `efb1537e` 包含 `EmployeeFirstStart` 和 person 试点名单，但目前零员工页未接入 `/chatflow/4.0`，`/chatflow` 仍使用现有员工发现判断试点跳转。正式候选须实接正常登录路径，并为新账号核定可写工作区。
- 用部署自己的 ADMIN 身份在测试组织新建中性员工账号。现有 `POST /api/v1/admin/organizations/[organizationId]/people` 走 `importOrganizationPeople`，输入为单条 `people`，新账号为普通成员。此账号只走 4.0 公网浏览器。person 名单走 `GET`/`PUT /api/v1/admin/d-entry-release-policy`，以 `organizationId` 和 `personId` 精确放行，`defaultGeneration` 保持 `3.x`。`PUT` 全量替换且无 CAS。发布负责人必须在串行窗口独占该设置的写入，保留已有选择并核对新 revision；或由发布负责人先完成新账号与精确放行并交回权威回执。真实凭证仅进入获准操作者进程的受保护环境或 scoped secret，ADMIN 与测试账号分别使用独立会话。
- 生产 Worker 在 `apps/worker/src/person-vm/production-authority.ts` 拒绝公开 stop/delete，`docs/architecture/person-vm.md` 写明普通运行中停机的原生静默接缝缺口。需要发布负责人提供同一受管 Worker 服务下 exact person/org、物理 VM、lease epoch 的受权关机与保盘回执。缺此能力时，`--live` 在读凭证、访问公网或启动 VM 之前即退出。现有内部 `PersonVmPort.stop` 仅用于宿主接口。应保留账号和磁盘供后续复开，整条从零验收每次使用新中性账号。

`browser.mjs` 持有共用步骤与请求校验。现装配为 `fixture.mjs` 的 Playwright transport；后续仅替换为固定公网 transport，按同源原生页面载体与只读流接入，保持消息 RPC 拒绝。ADMIN 操作及 exact cleanup 在独立受管入口接入，不把 host 或凭证交给 `browser.mjs` 的命令行。DSH 原生 composer 以锁定 `@deepseek-ai/dsh-client-ui-conversation` 的 `data-composer-input`/`role=textbox` 为依据。探针复用现有 DSH 页面和 AllRice 身份、发布与预热接缝，无产品代码变更。
