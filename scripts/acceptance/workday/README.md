# 4.0 工作日验收 runner（MET-280）

此脚本能执行本地输入演练、原生入口 consumer fixture，以及已授权 4.0 Dev 的身份、运行入口发现和封版页面只读检查。其余工作日验收项保留各自的待验证证据与负责人。

`cases.json` 原字节保留准备清单的20项。`run.py` 将其拆为冷/暖、子会话、四面板读/写、定时、外发、空闲继续、关机历史和后台读等步骤。每步含 passed/skipped/failed、原因、owner、来源及截图/无截图原因。fixture 和 Dev 分列，fixture passed 不填 Dev passed；整体永远保留 `acceptanceGranted=false/completeWorkday=false`，本人认可须由人和发布负责人核原件。

## 一键离线演练

无需安装依赖、模型或服务：

```sh
python3 scripts/acceptance/workday/run.py --mode fixture --output /absolute/new-evidence-directory
```

实际写入并读回旧准备清单同一合成文本/CSV，记录SHA256，生成 `index.html` 和 `result.json`。若未配置既有native fixture源，协议项明确 skipped；不会伪造UI截图。**返回2表示不完整**，不是进程崩溃或工作日通过。输出目录必须全新，拒绝覆盖首败。没有任何模式自动install、开开关、启动VM或运行模型。

## 复用真实已有 consumer fixture

在 `semiok/allrice-vm` 核定要验证的干净 checkout，使用其完整提交 SHA。273 的 fixture 位于 `apps/worker/src/d-entry/native-entry.fixture.ts`，复用测试符号 `nativeEntryServer/nativeEntryFixture`。它注入合成身份、catalog、permit 和 RPC 数据。fixture driver 创建 loopback HTTP server，验证身份和子会话资源读取、拒绝子会话写入、根会话请求以及缺少 DataPort 时的拒绝，最后等待 HTTP/mux 关闭。

在根会话安排好本任务树已有锁定依赖后，用明确配置调用相同入口（不是安装依赖的指令）：

```json
{
  "fixtureSource": "/absolute/read-only/exact-source-worktree",
  "fixtureSha": "<替换为所选 4.0 checkout 的完整 Git SHA>",
  "nodeExecutable": "/absolute/approved/node",
  "driverTimeoutSeconds": 60,
  "cleanupTimeoutSeconds": 10
}
```

```sh
python3 scripts/acceptance/workday/run.py --mode fixture --config /absolute/fixture-config.json --output /absolute/new-fixture-evidence
```

如使用 runner 所在的 checkout，省略 `fixtureSource` 即可。源 HEAD 必须与 `fixtureSha` 一致，已跟踪的文件必须干净。缺少显式 SHA 或源文件或依赖时跳过；SHA 格式错误、与 HEAD 不符、driver 失败或收尾未确认时记失败。driver 只运行本目录一个测试文件，使用单个 worker。Vite 缓存落在证据目录。`native-source.json` 记录实际 source SHA 及 fixture SHA256。

## Dev 默认路径与真实截图

`--mode` 默认 `dev`，但**配置与前置缺失时不访问Dev**。必须另有真正开验授权，MET267和节点4通过、部署及本人员工开关已获批准；脚本不替代这些决定。提供操作者专用测试session到 `ALLRICE_ACCEPTANCE_SESSION` 环境变量（由既有授权测试入口获得），不读取用户浏览器Cookie、OAuth、密码、storageState或凭据文件，也不将session放配置/命令参数/报告。

显式配置必须包含：

- `baseUrl`：实际HTTPS Dev origin或本机loopback，不含用户名/密码、path/query/fragment。
- `personId/organizationId/workspaceId/employeeInstanceId/threadId`：已授权的本人和**同一员工实例**；不凭页面文字猜身份。
- `releaseSha`：操作者固定的部署预期SHA。此值不是自动证明部署成功，报告明确其来源；实际发布原件由发布负责人核对。
- `gates.met267/node4/deployment/personalRollout/readAuthorization`：相应真实批准/门禁原件引用。字符串只是证据引用，不创造批准。
- `requestTimeoutSeconds`：此次QA只读请求的显式预算；需要浏览器时另给 `driverTimeoutSeconds/cleanupTimeoutSeconds`。

只调用已核实的两个现有公开BFF：`GET /api/v1/d-entry/identity`、语义只读的 `POST /api/v1/d-entry/native-owner`。不跟随HTTP重定向，不保存响应头/任意错误体。实际服务器identity必须匹配配置，native-owner必须返回同identity的 `4.0` mount，3.x或缺源均不能填绿。controlReady仅是discovery，`editorReady/canSend`始终标not-verified；不会发送prompt或启动VM。

请求前已经明确缺失的来源、授权或门禁前置仍可 `Unavailable/skipped`，不发请求。实际发出请求后，所有HTTP错误均为 failed/退出1，记入对应身份/员工步骤并说明具体原因未确定；`503 + error.code=DEPENDENCY_UNAVAILABLE` 也不能证明生产缺源，因为现有BFF同样以此表示fetch、解析或未知上游异常。仅保存固定endpoint、status和白名单code，服务器message/header/body不入报告；不新增缺源豁免或产品接口。

只读 UI 需要 `browserExecutable` 指向已有锁定 Chromium，并提供 `ui` 映射。自动检查适用于 SUBAGENT.read、REFERENCES.read、DELIVERABLES.read、MEMORY.read、CAPABILITIES.read、APPROVAL.review 和 ADMIN.runtime/usage/approvals。冷历史需要独立的关机状态证据，保留待验。每项由模块 owner 提供 `ownerSource`（固定 source/symbol）、已核只读页面 `path`、内容 `locator`、授权容器 `scopeLocator` 和 `scopeAttribute`。容器必须唯一可见，属性值等于 employeeInstanceId。内容及可选的精确 `text` 都在该容器内核验。页面依赖的已封版只读 API 可通过 `readApiPaths` 声明精确同源路径和查询串。

```json
{
  "ui": {
    "MEMORY.read": {
      "ownerSource": "owner must supply exact SHA and public UI symbol",
      "path": "/owner-supplied-existing-route",
      "locator": "owner-supplied-existing-visible-locator",
      "scopeLocator": "owner-supplied-existing-scope-locator",
      "scopeAttribute": "owner-supplied-existing-employee-instance-attribute",
      "readApiPaths": []
    }
  }
}
```

owner 补齐实际路由和定位器后，浏览器才执行对应检查。它使用 Worker 已锁定的 `playwright-core` 和临时 context。文档、Next 静态资源及明确列出的只读 API 可发 GET/HEAD。请求不跟随重定向，其他页面请求、WebSocket、service worker 与下载均被拦截。截图只保留授权容器，采集时隐藏容器外的叠层。采集前后复核身份、4.0 代际、原 bindingRef 和容器范围，通过后才写 PNG。

失败保留阶段、有限错误分类、受控 HTTP 状态和无截图原因，截图失败另记 `captureFailure`。报告采用有限的错误投影。注入页面回归用于核对诊断与授权边界。

Dev写入、定时执行、审批/发送、VM开关/破坏、真实模型、空闲20分钟、恢复与性能压测目前没有在本runner装配生产入口，明确skipped到owner。本工具不调用3.x API冒4.0，也不提供任意shell/HTTP/模型adapter。四面板的读/写状态分别记录；不能将只读截图当业务写验收。

## 结果与退出码

- `1`：真实执行/配置来源/driver/收尾失败，首败原件保留。
- `2`：不完整（含skipped、fixture或本人工作日待核），HTML明确原因；不能在CI里用 `|| true` 变成通过。
- 本工具不自动返回“完整工作日通过”。应由本人和发布负责人核对真实原件，另记MET280验收。

`result.json`含步骤、原20项、来源/预期版本与汇总，HTML无外部脚本/图片请求，所有文字escape，已知session及敏感字段脱敏。`driver.log`只有脱敏诊断。异常/信号先结束并join本次owned进程组；超过操作者明确cleanup预算才杀本次owned组并保留失败，绝不关闭用户VM/Dev会话。native fixture/browse正常也必须有实际close回执。无权限/缺源与执行失败分开，不自动重试。

## 作者轻量回归 / 根会话门禁

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/acceptance/workday/run.test.py -v
node --check scripts/acceptance/workday/browser.mjs
node --check scripts/acceptance/workday/browser-diagnostics.mjs
node --check scripts/acceptance/workday/fixture.config.mjs
```

`runner.test.ts` 由既有默认 Vitest 自动收集，调用完整 Python 标准库回归并测试单页诊断组合。回归覆盖缺源、组合树含 fixture 时缺显式 SHA、错误 SHA 时拒绝启动 driver。HTTP 回归使用 loopback BFF 合成响应和真实 HTTP 请求。

`native-entry.fixture.test.ts` 是独立手工项，原生tag `manual:WORKDAY_FIXTURE_SOURCE` 在 `scripts/ci-manual-environments.yml` 精确登记。缺source时仍可见skip；显式提供source而缺receipt/cache属于配置失败，不再成为未登记的条件skip。必须先通过本runner的精确source/pin校验，另提供新receipt/cache路径，才用本目录fixture config实跑。自动Python/诊断通过不能替代该HTTP driver实跑。单文件检查示例（由根安排依赖与资源）：

```sh
pnpm exec vitest run scripts/acceptance/workday/runner.test.ts --maxWorkers=1
```

作者只运行标准库离线小测试/语法检查；实际native fixture driver与浏览器由根会话按资源/授权统一安排。负向覆盖escape/脱敏、skip非pass、3.x/错本人、缺生产来源、异常/cleanup、非零exit和首败不覆盖。不为了过门禁修改产品或放宽任何旧断言。

验收清单依据 MET-280 准备阶段冻结的 20 项要求和 AllRice 4.0 边界合同 v1.0。

DSH对照：直接复用原生入口的公开协议和既有consumer/browser fixture；不改变Agent Loop、会话、子智能体、定时/审批或生命周期。SaaS新增自补无；本片只有验收编排和单向证据呈现，不新增产品状态或MET225定制。
