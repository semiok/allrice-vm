# 每人 VM 公开接口 v1（MET-266 / M1-02）

基线 `6bf356b5`，冻结边界合同 v1.0。公开入口为 `@allrice/person-vm`，符号 allowlist 见 `packages/person-vm/src/index.ts`。本模块拥有个人盘、宿主 VM 记录、所有权租约与开停审计，不拥有 DSH turn/job/子任务/审批状态。

每个全局 `personId` 只建一条 VM 记录，当前企业由可信 RequestContext/权限服务校验。第一阶段遇到同本人不同企业的绑定拒绝 `ORGANIZATION_CONFLICT`，不暗建第二台 VM、不跨企业复用会话或权限。跨企业安全切换留待身份入口合同绑定。员工仅配置/线程分离，文件和浏览器在本人 root 域共享；删除员工不会调用 VM 或个人盘删除。

## MET-269 出口接线

`PersonVmBinding` 的 vmId/instanceId/leaseEpoch 由 host 产生，组织/本人取当前可信服务上下文。`ownerToken` 只在存储租约内部，既不进 guest，也不进 PersonVmView。guest 自报的 header/person/epoch 不能建立信任。

1. 持久化新租约和 epoch，先处理旧 epoch 的撤销/真实停机；未确认停止不开始新实例。
2. `egress.prepare(binding, signal)` 返回 `PersonVmEgressReceipt`；内含完整 binding、不可空 bindingId、host gateway ports。VM 服务逐字段比对，缺门卫或不匹配时 fail closed。
3. `egress.assertActive(receipt, signal)` 后才调用原生 create/start。Microsandbox 双向默认 deny，只允许指定 host TCP gateway；guest 不能要求额外公网目的地。实际只读/下载/外发语义由 MET-269 执行。
4. 原生 agent ping 只证明命令通道；DSH runtime 的 authenticated/editorReady/canSend 全真才返回 ready。HTTP 401 不算可发送。
5. stop/failure/takeover/delete 均先 `egress.revoke(receipt, reason, signal)`；撤销失败仍尝试 native stop，并检查确已停止。停止不明不卸载盘；撤销或停机失败不报成功。清理使用独立有界信号，不因用户取消跳过。
6. 新 epoch 不能复用旧外部资格。MET-268/MET-271 在各请求入口实时校验当前本人、企业、epoch 与实例；此包不会把 guest 自报身份传为权威。

prepare/assertActive/revoke 均 host-only，不是可让模型调用的工具。撤销必须幂等到精确 bindingId/epoch，不能把旧实例的延迟撤销作用到新实例。

v0.7.16 的 `start` 不接受网络覆盖参数，因此 MET-269 必须为每个 vmId 保留同一组 gatewayPorts；首次 native create 后把端口固定在存储回执，后续 prepare 若改端口即拒绝。绑定资格与 epoch 每次更新，不能用固定端口当身份。原生 idle-timeout 不启用（detached job 可能不重置原生 idle），闲置停机只由 host 依据活动事实执行，默认 20 分钟。

员工端口位在新 VM 创建或旧 v1 VM 确认停止后的转换时一次发布，仅宿主回环可达。运维可在发布封存的 `.local/person-vm-host.json` 顶层设置 `employeePortSlots`。合法值为 1–20 的整数，缺字段默认 20，非法值记录字段名、原因和回退值后使用 20。Web 配额与 Worker 原生发布读同一封存值。已核实的 v2 物理槽宽随 VM 记录持久保存，配置上调或下调都不改变它。保盘保留槽宽，彻底擦除完成后清除原宽度。槽位总数独立于同时运行的员工数。

普通路由的 MET-268/MET-271 调用 host-only `resolve(RequestContext, signal)` 与 `assertCurrentBinding(RequestContext, binding, signal)`。两者重新核本人/企业现权、运行阶段、精确 instance/epoch 与出口活性；不返回 ownerToken、不暴露内部表。RequestContext 必须来自各自可信会话/受管连接，不能由 guest header 或 JSON 反序列化生成。resolve 是本次快照，各次实际请求仍须 assert；启动/停止/接管中的租约不发新路由。

正式共享 admission 路径另消费根出口 `PersonVmAdmissionBindingPort.assertAdmissionBinding(context, binding, signal)`，由同一个 `PersonVmService` 提供；未创建 shared host 即拒绝，不接另一 factory/DB 的权威。此口只核当前 user/企业、完整五字段、shared revoked 与内部 exact egress receipt，不公开 receipt/capability/ownerToken，不判断 ready 或授 dispatch 权。正常 freeze/physical lease 不构成资格错误；后续实际工作仍必须在同一 shared boundary 的 admit/queued/activate/finish 内，starting/stop/epoch/recovery 保证不变。egress.assertActive 只核本地 exact receipt，不能反调 VM 校验形成递归。

可信宿主调度另用`PersonVmHostPort`：`reconcileIdle`、`recoverExpired`、`acquireHold`/`releaseHold`。hold参数只有明确kind/operationId及已解析binding，返回host-only holdId；每次现权与epoch复核，不暴露guest工具。原生活动探针在同一可信调用链重入binding校验时，用AsyncLocalStorage中该请求的租约guard，不误判为外部worker；其他请求仍拒绝开停期间的新路由。出口provider的assertActive只核自己拥有的binding回执，不反向递归调用VM的assertCurrentBinding。

## 五面与实施边界

后端 present；MCP none（模型不获 VM 管理权）；员工 UI none（本卡只提供页面/输入预开机服务接口，后续由已批界面接线）；后台 none（没有新增管理界面授权）；权限 present（每调用重查当前可信身份，删盘单独授权/审计，不默认删盘）。默认关闭/名单由发布入口控制，本包不新增产品开关。

**保守自动停机默认关闭。** 启用后，宿主每 60 秒采样当前 VM 的全部员工。持续看到空闲、没有漏采且未收到忙碌事件，才进入同一物理租约下的唤醒准备与停机。采样间隔可用 `lifecycle.idleSampleIntervalMs` 调整。原生读失败、漏采、Worker 重启或代次变化均重新计时。部分瞬态工作可在采样间发生。最后一次负向读取至原生停机之间也可能出现尚未被宿主观察到的工作。下一次定时触发落入停机预算与 `lifecycle.idleScheduleSafetyMarginMs` 的合计窗口时保留运行，默认安全余量为 30 秒。普通停机、删除和接管仍沿用各自的活动、租约和权限校验。

在 `~/allrice40-dev/config/person-vm-host.json` 设置内存和闲置时长，随常规发布重新封存，由 Worker 启动时读取。内存使用 `memory.policy.physicalBytes`（整数 MiB 对应的字节数，1–4 GiB），闲置时长使用 `lifecycle.idleMs`（毫秒，5–60 分钟）。缺项使用 2 GiB、20 分钟。非法字段独立回落，并在 Worker 日志记录字段和默认值。配置随 Host 启动加载，已有 VM 改变内存上限需要配置 `lifecycle.hostVmBudgetMiB`，并在下一次启动时走既有的容量预留和原生配置读回。

仅 native 已真实 stopped/absent 时，可对账后清理并从确认的 stoppedAt 计算7天转冷。刚确认停止不能因旧 lastActivityAt 立即冷。自己本次启动失败的清理仍撤出口、尝试物理stop、确认后detach。权限撤销强制终止是另片已批需求，不作为普通 idle 回收证明。长周期测试只用时间夹具，未实等20min/7day；不做 Full 快照、不自动删盘。

冷盘为未挂载加密镜像在同一存储根 warm/cold 目录的移动。host-only `disk.inspect(vmId)` 非破坏性检查两个位置：完成凭据记录创建成功后的 vmId 与外层镜像 dev/inode，原 key 通过公开 imageinfo 识别容器；仅一个精确匹配镜像才可回写实际 diskTier。rename 成功但DB回写失败后，可以重复 move 或在恢复 mount 前对账；原字节不复制或重建。两个位置同时存在、凭据/容器/key不明都保留并拒绝。这不宣称完整文件系统健康检查；不能恢复的损坏仍需专门恢复。

首次建盘失败且确证两个位置与完成凭据都不存在时，create允许同vmId用原key幂等重试；完成且匹配的镜像只认领，不覆写；部分盘或不完整凭据保留并拒绝。完成凭据0600存于独占host存储根的manifests目录，须与镜像/密钥共同纳入后续备份恢复集合；不是guest可改的授权来源。

ownedData为迁移0247的`person_virtual_machines`与`person_vm_audit`、私有配置根下的warm/cold加密镜像和分离key store；没有员工外键级联。两表同PR登记收敛基线，归属租约/账本。默认FilePersonVmKeyStore只证明本机分离存放和0600权限，不等于生产离机密钥托管；生产密钥服务与共同备份/恢复集合仍需后续接线并验收。

首次创建空 MSB_HOME 先用公开 `msb pull <固定digest> --materialize flat --quiet` 预置，再 create `--pull never`。镜像来源是可信 host 固定配置，guest 不参与选择；host 工件下载控制与 guest 出口验证分开。

M1 的 `socketRoot` 必须由可信 host 提供独占短目录，保持显式 `/tmp` 拼写，不把 socket 别名 realpath 成更长的 `/private/tmp`。v0.7.16 没有单独的 `run`/socket 路径配置，`run_dir=home/run`；canonical control 路径为 `home/run/sandboxes/<24hex>/control.sock`，其中24hex来自原生SHA256(name)前12字节。构造时按完整UUID固定36字节作纯资格预算，长socketRoot在服务装配进入egress/move/attach前即拒绝，并快照已校验配置；prepare仍按实际binding在本方法目录/配置/命令副作用前检查同一衍生路径的UTF8字节数与Darwin `sun_path[104]`（严格小于104），不再用无原生依据的home≤70；不生成短person/VM ID或新映射。完整UUID的home最多51字节，因此socketRoot最多14字节；例如host `mkdtemp('/tmp/a-')` 得到13字节独占0700目录，home50/control102。长数据/加密盘路径仍只作为软链target，完整vmId别名的不同target冲突仍拒绝，不覆盖已有别名。此预算绑定固定原生版及Darwin ABI，升级须核[run_dir](https://github.com/superradcompany/microsandbox/blob/0fefb8f2fed3da964819afd222227dc1c5b0e78f/sdk/rust/lib/config/mod.rs#L574)、[canonical端点及pair校验](https://github.com/superradcompany/microsandbox/blob/0fefb8f2fed3da964819afd222227dc1c5b0e78f/crates/runtime/lib/client/ipc.rs#L175)。

每次开停/hold持有PG advisory锁与持久owner租约。`recoverExpired` 只在过期且旧操作已可靠fence时运行：先撤旧出口→确认旧native停止→卸载→CAS清owner。默认实现能证明同进程原callback及子进程promise已settled后的数据库断线恢复；普通业务/原生错误不会因类型未知永久留owner。跨进程/跨host没有可靠fence时拒绝，`PersonVmLeaseFencePort` 留给MET-274接线；TTL或PID存在性不证明旧操作不能再执行。活动hold不会靠TTL自动变成0，异常hold的可信对账同属后续恢复边界。

恢复在调用物理provider前先CAS登记新的唯一recovery owner、消费前代settled证明，guard/save/清owner只认新token。即使恢复自身PG连接被终止、advisory锁已释放，也不能拿前代证明再做物理清理；本地active recovery拒绝重入，其他host须fence新owner。只有恢复callback及其失败清理/命令真正settled、client销毁后才登记新owner的本地证明。claim提交回执未知时，可分别保留尚未消费的前代证明与新token收敛证明，但任何新物理工作都须核当前持久owner；onclose或TTL不是收敛证明。

无instance的恢复同样先inspect盘：ready回写真实warm/cold位置；首次建盘阶段absent恢复为failed可重试而非stopped，unknown/部分盘保留拒绝。挂载与host盘对账分开，显式授权删除也按vmId查实际位置，确认warm/cold镜像都已移除后才删完成凭据/key并记成功。

PostgresPersonVmStore构造参数为`PersonVmSqlFactory`：每次调用返回全新、未使用、独占的`postgres(url, { max: 1, ...可信数据库配置 })` client，由store在每次read/withLease/recover结束时调用公开`end({timeout:0})`销毁。不能传Web pool、缓存同一client或让工厂返回已经使用的client；复用client或max非1会拒绝。max:1与操作独占保证advisory锁的全部SQL都在同一session上，不依赖reserve/release重新入池。resolve/assert每次也会建连接，网关逐chunk调用将产生相应连接/鉴权开销，目前未实测吞吐；后续容量治理需实测优化，不可用不可信缓存或旧epoch资格替代当前现权检查。factory不得在其他模块改为共享client。

postgres.js 3.4.9的`release()`无条件把reserved连接标回可用，FATAL关闭后的query/errorResponse直到ReadyForQuery才清理。因此这里只用公开onclose和SQL错误作废当前client：每条SQL同时等待关闭事件；连接错误发生即拒绝该操作后续guard/save/audit，避免失败审计抢在关闭通知前再次发送SQL。无论成功失败均销毁该client，下一次读取/恢复来自全新session；普通SQL/业务错误仍清owner。断线保留durable owner，同进程settled证明仍要等原callback及物理清理结束，不用重连、TTL或SQL报错代替fence。源码依据：[reserve/release/onclose/end](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js)、[ErrorResponse/closed/ReadyForQuery](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js)。

接管/失败重开也先核真实native状态与当前原生活动/host hold；可靠fence不等于原生任务已结束，当前running缺少原子停机保证即拒绝。recoverExpired与普通租约使用同等短生命周期的AsyncLocalStorage frame/guard，当前可信探针可重入，其他requestId即便本人相同也看不到该frame资格，回调settled后frame立即失效。新启动本次自身的失败清理仍尝试撤销、物理停机并确认；后续跨进程恢复由MET-274接线。revoke的实现由MET-269负责取消/join该binding在途流并记效果未知，VM层不能仅凭调用前的一次binding检查宣称长期流已回收。

源码依据：[v0.7.16 start](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/start.rs)、[create](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/create.rs)、[pull](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/pull.rs)、[list JSON](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/list.rs)。hdiutil的stdinpass按系统man使用NUL结束，不把key放命令参数或环境。

真实前置：固定 v0.7.16 二进制与其公共配置、宿主加密盘密钥托管、MET-269 出口、DSH 装配与活动/就绪公开接缝、MET-271 身份/BFF 页面绑定。未绑定这些前置时不得报可交付或迁入完成。样机证据只作实现参照，不替代产品验收。

故障依据为domain错误、开停/删盘audit、持久phase/租约和真实native/hdiutil检查；`CLEANUP_INCOMPLETE`或未知物理状态不能冒称已释放。自动巡检/告警尚未接入，交主会话在MET-222登记VM失败/残租约/残挂载监测项。运行时装配仍需证明员工/工作区绑定后的实际编辑器可发送，本卡没有用协议fixture替代该证据。

## n2-A starting owner / native bootstrap kernel

`PersonVmRuntimePort.memoryGuestPlan(binding, signal)` 必须注入 MET267 公开 `VmMemoryGuestPlan`（当前候选 `fbbc52163f82e2e201e2d6bfe835e709f3f2abc2`）的实际工件，不能从 guest 请求选策略。`PersonVmMemoryGuestPlan` 只作结构投影，没有复制内存策略。缺该函数或 native bootstrap，在出口/挂盘/原生 create 前拒绝。`MicrosandboxPersonVm.bootstrap` 实际用公开 managed exec 创建父目录、私有临时 stage + `cp` 保留 mode、detached node initializer + exact `wait --job --format json`；initializer exit0 且非 timed-out 后才进入 runtime.start。临时 stage 位于本次加密挂载内的0700 host-home，用完清除，不暴露其路径。原生 CLI/source 固定 v0.7.16 `0fefb8f2fed3da964819afd222227dc1c5b0e78f`，cp 会 resolve/start，必须只在真实 starting owner 内调用。

`start(binding, signal, scope)` 的第三参 `PersonVmBootstrapScope` 为 host callback 能力：仅含 frozen binding、startup signal、`assertCurrent()`、`launch(command)`。assertCurrent 直接核本次 active lease frame、真实 PG guard/现权、starting/full instance+epoch、admission 及精确 egress receipt，不调用只支持 running 的 resolve、不泄露 ownerToken/key/host盘。callback settle 后 scope 立即禁止新操作，abort 并 join 已发起的 scope 调用，持物理租约到实际收尾；回调返回不能把未 await 的原生 launch 留给释放器。启动 callback 必须等实际 startup/control 操作 join，并将长生 native job 交给真实 runtime owner；startup signal 返回即失效，不能用作 DSH 的长期信号。ready 前后仍重核同一 starting owner。

`scope.launch({executable,args,env?,workdir?})` 只能在 person init 成功后调用，执行固定 `plan.launcher <native executable> ...argv`，env 合并固定 plan.env，冲突拒绝。返回 `PersonVmManagedJob{binding,jobId,wait(signal),cancelAndWait(signal)}`；wait 返回 `{exitCode,timedOut}`。handle 精确绑定 sandbox/job，可由 native owner 持有以完成读取/取消，不能启动新命令；其 cleanup 不依赖已撤销本人的普通权限。公开 native wait 先输出 JobExit JSON 再以 guest code 退出，所以仅该内部调用允许读取正常非零 CLI 退出的 stdout，严格核 code/success/timed_out；spawn、abort、signal、超限或无合法 JSON 都不算 join。cancelAndWait 即 exact kill + wait，kill 失败仍试 wait，CLI 被杀或 wait 超时本身不证明 guest 完成。host 应给 start/prewarm 传入覆盖启动预算的 AbortSignal；原生 wait 的超时不杀 job，本适配以该信号取消等待再执行 kill+wait，不声称已设置原生 job deadline。`jobCleanupTimeoutMs` 为 host 可信配置（默认10000ms），独立于已取消 startup signal；未知 job ID/通信/完成状态走现有 revoke→native stop/status，仅确认停止才 detach，不能扫描猜 id、重放 initializer 或报告 ready。

同一 running start 入口只重核 readiness，**不重跑 person init**。MET273 运行中新员工须由真实 running owner 继续用已安装 launcher/env，不可复用过期 starting scope 或重配活跃 cgroup。本 kernel 不建立 DSH 控制通道/guest header 身份；273 必须实际装配 native owner、认证 editor/send ready、独立员工 homes/配置/会话与所有 launcher。未装配时不得返回 ready。此片不证明 MET26702 镜像内没有抢跑 producer、04 exact-child/OOM、实际2G运行读回、n2-B全 producer/20min 或组织撤权；真实联验另排，协议 fixture 不作产品启动验收。

首建原生 `create --memory/--max-memory` 与 `sandbox_defaults.memory_mib` 使用同一构造时 host 平台快照；正式默认仍2048MiB。配置读回不是 physical enforced cap 证明，已有 VM 不因本修复热改或自动迁移。

## 4.0 磁盘预建后台调度

预建名册取自已提交的 4.0 灰度策略，开通条目绑定企业和真人。Worker 按真人分页，在同一次读取中核对该人已开通企业的当前员工实例、可写成员关系和精确版本。首个员工尚未创建时暂缓预建。平台来源还须保持发布状态。自建员工的首版及租户版本须有同一创建事务留下的现有写入审计。平台版本缺少映射或版本来源无法确认时暂缓该人并记录 `version-source-unverified`，供值班排查。同一真人在同一企业的多个员工实例共用一块盘。有盘时沿用既有企业归属。没有盘但同时有多个企业符合条件时暂缓。归档员工、撤权或变更版本会使旧目标失效，既有个人数据仍按独立的删盘授权处理。

`PersonVmDiskPreparationPort.prepare(target, guard)` 由生产 Host 装配到处理工作台的同一个 `PersonVmService`。目标携带精确真人、企业、工作区、员工实例、员工版本、平台发布来源和灰度策略 revision。提供方持有既有物理租约，在租约内重读现权和容量，调用返回前等待实际文件操作收尾。后台池空时返回暂缓。工作台继续通过 `prewarm`、`create` 和 `start`，在确认本人没有待续领用且库存确实无可领盘后沿用原现场建盘。

管理员离线操作先在同一专用 PostgreSQL 连接上标记具体真人和企业，再尝试现有物理租约。首次工作台的创建与启动遇到占用时，核对持有物理租约的 backend 是否也持有准确标记。确认后等待该后台操作完成或请求取消，再获取原物理租约、查正式归属并核对现权。其他生命周期冲突仍按既有租约拒绝。等待方取消只影响自身连接。

### 三盘库存和容量

封签配置 `disk.preprovision.enabled` 默认关闭。开启还须指定 `disk.preprovision.platform = "macos"`、固定公开 OCI 摘要与缓存清单，以及正整数 `minimumFreeBytes` 和 `reserveBytes`。生产装配核对宿主与所选适配器。公开文件和初始镜像余量超出本轮预留时，补货在写入槽记录前暂缓。物理分配前按已核实的实际写入卷再次检查可用空间。适配器按分配块统计库存与保留盘的实际占用，同 inode 的临时和正式引用只算一次。目录账本变化时重新采样，稳定账本之外的物理文件触发维护。复制操作使用有界的写入单元，每次同步已完成的写入，再检查 guest 可用空间、宿主卷余量和外层 UDSP 分配块，按 `hdiutil` 的 1 MiB 增长单位纳入下一次数据和元数据余量。卸载后再次检查最低余量和预留包络。本预算来自采样，宿主其他写入仍可改变可用空间。预算不足记录 `capacity-deferred`，无可用盘记录 `pool-empty`。

每个配置盘根最多三个槽，正在准备、领用、退出和隔离盘均占槽。每次补货独立建加密盘并生成密钥，短暂独占挂载只复制封签内的公开缓存。挂载和密钥核验完成、实际卸载且凭据持久化后进入可领库存。库存阶段只保留盘、密钥、公开缓存和凭据。原生 VM、guest 账户与员工资料由正式启动流程处理。换代时每轮只处理一块已确认归属独立且已卸载的旧库存盘。一旦选定退出，原填充连接负责持久化意图、清除原盘和密钥、确认物理状态并释放槽位，正常停止会等该清理收尾。容量检查或已确认写入空间失败触发的中止也只有获得本轮独立盘及卸载证明后才能走同一退出流程。

填充和目录库存使用不同的专用 PostgreSQL advisory session。填充锁一次只容许一个正在准备的盘，库存锁覆盖短期槽变化。磁盘、挂载和缓存 I/O 在库存锁外执行。已进入本进程的前台预热，以及 PostgreSQL 上已有正式启动租约的前台动作，优先于新补货。执行中的补货在有界写入前检查本地前台动作，定期读取 PostgreSQL 启动提示。需要让行时持填充锁完成同一盘的实际卸载和安全退出。已完成写入且确认卸载的任务在正常停止时继续核验离线状态和空间，再提交库存。每轮扫描名册一次，数据库通知可以提前唤醒下一轮并重校进行中的开通目标。停止时封闭新工作，等待正在进行的复制、物理卸载和专用查询收尾。

### 正式绑定和维护

先持有每真人的物理租约。后台首次准备在短库存锁内确认可领盘和前台优先级，再提交 `personId`、`organizationId` 和 `vmId` 及专用领用 intent。库存被抢空或后台让行时直接暂缓，本人仍可按有效企业资格申请。日志位于同一可信盘根的 `.preprovision-ledger`，三个槽各有不可覆盖的连续记录。记录与目录完成同步后才开始物理绑定。完成记录保存原 intent 与请求标识，精确 owner 的 `create` 审计仍在既有 PostgreSQL 表上。

macOS 对原盘及原密钥建立无覆盖的正式文件引用，核实同 inode 和密钥可用。确认正式引用持久化后移除临时引用。临时密钥引用撤销且目录同步后，才发布普通磁盘 provider 可识别的正式清单。清单和账本完成记录在各自最终链接前都重新核对取消信号、现权及物理租约。日志完成凭据和正式归属一致后，`PersonVmService` 保存 `stopped` 并允许走普通挂盘和启动。现有 intent 在换代后继续以原盘、钥匙和清单核对物理归属，缓存快路径仍要求当前封签。替代盘、冲突路径、无法确认的挂载或密钥状态均保留原件并报告维护错误。库存关闭时继续查阅既有 intent，已绑定盘沿用正式生命周期。

现场建盘在创建密钥或镜像前也持久保存这一真人、企业与 `vmId` 的宿主归属。库存关闭时生产 Host 仍使用这项归属证据。Worker 须能打开账本目录、磁盘根及其上级目录并执行目录 `fsync`，同步范围包含首个独立管理的上级目录。目录同步失败会停止归属发布和建盘。产生新 `vmId` 前，旧的已完成领用和现场创建按真人查验，只有正式删盘成功审计和盘、挂载与密钥的物理缺失证据一致时才可换代。历史普通盘缺少宿主归属时，以其唯一 `vmId` 对上可信 PostgreSQL 的保留盘行。存在无法对账的历史盘时暂停新分配，已有获准盘仍可走原启动路径。

旧封签绑定盘首次 native create 前可按原 intent 更新缓存。完成日志、正式清单、原 inode、原密钥和实际挂载须同时吻合。适配器先在同一盘的确定目录发布同一 claim 与目标封签的暂存凭据，再复制和验证当前文件。重试复用已完成的暂存字节。验证后保存切换意图、完整保留旧缓存目录并发布当前缓存。暂存阶段需要同时容纳原目录和一份当前公开缓存。空间错误发生在切换前时可保留现有目录，释放空间后继续。切换后使用同一封签重试会复核当前缓存。同一盘上的切换由物理租约串行化，回滚到已有归档和当前目录位置相冲突的封签时，保留原件并进入维护。只关闭库存开关时，Darwin 的既有 APFS 提供者继续验证已完成领用，仍需配置当前公开封签来进行刷新。

已进入 native 代的正常启动可与此前已通过后台名册预检的扫描短暂竞争原物理租约。后续扫描以正式运行代为准跳过该真人。

同一归属在重新获得有效物理租约时可以继续已知的绑定前缀。原 owner 未获可信收尾证明时保持隔离。真实 PostgreSQL 连接断开或进程退出可能留下仍有效的持久围栏，租约过期只用于发起已授权的恢复流程。无独立的前任收尾证据时拒绝跨进程接管。填充或退出连接丢失会留下占槽的 `filling` 或 `retiring`，后继 Worker 报 `interrupted-fill` 并暂缓新补货。清理不明时记录隔离状态并保留盘和钥匙。处置时需先证明旧 Worker、命令和设备均已结束，并同时核对目录日志与正式账本。原盘、key root 和日志须作为同一 Host 归属持续保留，迁移或恢复时必须一起核对。

### 存储和启动适配

| 接缝                 | 当前 macOS 实现                                                                                                                                                         | 未来 Linux 对应实现                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 独立建盘、检查和卸载 | `DiskPoolPlatform` 复用 `ApfsPersonVmDisk` 和文件密钥保管，通过 `hdiutil` 检查镜像、设备和挂载。普通盘销毁仍使用既有本人删盘权限。池内不确定盘留待维护。                | 每盘独立 LUKS 或 dm-crypt 卷和密钥，以持久卷标识确认归属。挂载时启用 mapper，卸载后核实 mapper 和设备使用状态。                  |
| 持久绑定和容量       | 适配器核对 inode，持久化正式引用并撤销临时引用。按实际卷的可用块及镜像分配块核算。                                                                                      | 以持久卷标识和密钥保管映射提交同一正式归属，读取对应文件系统或 thin pool 的实际预算。                                            |
| 公开缓存和根盘       | stock 仅写封签缓存。正式启动沿用 `MicrosandboxPersonVm`。同一封签的领用盘首开对盘内缓存重新验哈希，已验证的本地字节直接供 MSB 用 `flat` 和 `clone=reflink` 建个人根盘。 | 核对同一公开来源，由正常启动适配器使用 XFS 或 btrfs reflink。后续可用公开只读 lower 加个人加密 upper，继续复用同一根盘准备位置。 |
| Guest 地址和运行时   | 工作台继续用既有可信 Web 封签的 `web.guestAddress` 和实际 MSB 端点检查，库存过程无 guest 地址。生产装配保留现有 MSB provider 及 Darwin Unix socket 路径限制。           | 由对应虚拟化运行时按已启动的绑定和 epoch 返回实际地址，供同一工作台启动与就绪检查消费。                                          |

### 升级时停机与接管

发布负责人先完成候选构建。给 `deploy-dev` 的文件描述符 3 提供当前平台管理员会话令牌。发布脚本关闭这个描述符后才启动构建子进程。令牌留在发布进程内，只交给经过同 PID 和同 boot 核验的本机维护连接。

```sh
deploy-dev --release-manager --require-person-vm-config 3<"$private_session_file"
```

脚本在切换前调用 `person-vm-drain`，以当前 Worker 的实际 PID 定位其私有 Unix socket。遇到多个 socket、缺失回执、候选仍在运行或活动未知时，发布停止。Worker 只按原生停机门卫处理空闲 VM，忙碌时最多等待到发布排空期限。快照、迁移和新版启动耗时没有确定上界。有待执行的已承诺唤醒（包括原生停机已确认、生命周期记录仍待完成），或排空会产生新的唤醒义务时，发布、跨版本恢复和回退停止，现有 Worker 继续负责唤醒。回执包含 `bootId`、已停机数及 `expiresAt`。脚本先记录原进程和启动配置，再向同一进程提交有期限的关闭请求。普通信号不能消费回执。脚本确认正常退出、端口关闭、库存清空且没有遗留唤醒后才切换。恢复同样核对实际 Worker 和保存的退出记录。旧版 LaunchAgent 如不支持此协议，请由发布负责人先按旧版维护流程确认 VM 全部停机并停止旧 Worker，再开始首次迁移。

数据库仍记录为运行中而当前 Worker 没有旧 Gateway 回执的 VM，会记录待接管告警。网页自动打开、恢复标签页和后台预热均不触发停机。本人点「打开员工」后，Worker 复核账号现权、独占物理租约、上一版 Worker 已退出及旧端口所有权，才停止确切 VM、读回、卸盘并写入 `stop.upgrade`。网页显示「版本已更新，正在重新启动员工」，随后以同一保留盘启动新代次。停机后的读回若失败，带有本代停机派发记录的 VM 可以在相同围栏下重新确认终态并完成清理。原生日程保留在盘上，由既有闲置停机流程重新登记。更换物理只读制品仍须验证原生挂载与封签的交接。

### 平台管理员删除

Worker 在本机提供 `POST /internal/platform/person-vm-delete`，用现有的有效平台管理员登录鉴权。运维入口为 `scripts/m1/person-vm-delete <Worker 端口> <person UUID> <review|retain-disk|purge-disk>`，从终端静默读取平台管理员会话 token。

- `review` 显示指定人的 VM、当前代际和通过磁盘创建凭据校验的 SHA-256 标识。确认未成盘时摘要为空。它不读取或哈希用户内容，也不返回钥匙、路径或会话凭据。
- `retain-disk` 核验当前 VM 的计算实例已停止，撤销入口、卸盘并移除宿主机别名，将 VM 记为 `deleted`。完整加密盘保存根文件系统和恢复所需的 Microsandbox 登记。
- `purge-disk` 要求同一管理员和登录在五分钟内确认同一 VM 代际和盘标识。脚本要求再输入一次 VM UUID。核验已停止、入口已回收并卸盘后，删除包含原生登记的加密镜像及密钥。运行中或状态未知、仍有 hold、回收结果不明确时中止。

审计记录在 `allrice_audit_events`，包括真实管理员、时间、目标人和 VM、盘标识及结果。保盘发布和擦除检查点在同一数据库事务里锁定并复核当前管理员会话。若擦除中断，保留盘旗标和审计检查点，下次由平台管理员重新确认并收尾。只有在原生资源和加密盘已清除后才写入 `deleted + disk_retained=false`，解除首建员工的 VM 限制。已有员工或有效分配仍由原首建规则核验。
