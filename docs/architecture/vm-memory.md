# MET-267：人级 VM 内存准入与命令保护

本片是节点2的可装配中间层。物理2GiB由MET-266的VM provider创建参数与运行回读落实；此包的常量、guest `/proc/MemTotal` 或合成测试都不能证明硬帽。宿主压力source与guest初始化挂载仍须owner接实，真实局部/父组/全局OOM、同会话恢复与容量验收未完成，不把样机当产品通过。

## 公开合同与五面

公开入口`@allrice/vm-memory`（当前包0.1.0、`VM_MEMORY_CONTRACT_VERSION=1`）。本片开始前依赖`@allrice/person-vm#PersonVmBinding`来自`34c6589bcfbb0283a886da2759277424718d6047`，基线`0c9d0e27c37a39dbec3e6c5be7230e3d77eed84f`的`packages/person-vm/src/contract.ts`；仅import公共barrel，不读其表或内部实现。新导出是existing源码合同：sourceAtSha=`901f4af9fd045cda3233bd816be0a89151f63dbc`，allowlist在`packages/vm-memory/src/index.ts`，具名type/error在`src/contract.ts`，方法在`src/admission.ts`和`src/guest-config.ts`。该SHA也固定本片gateway装配改动；后续封版提交只补文档，产品源码相同。可信observer的生产实现和MET266 staging仍是proposed依赖，已有type不等于装配完成。

| 面        | 明确归属                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端      | `VmMemorySource.watch(binding,signal)`、`VmMemorySourceWatch.read/wait/close`是宿主owner必须实现的可信观察接缝；`createVmMemoryAdmission(source)`返回`VmMemoryAdmissionPort.watch`和`VmMemoryAdmissionWatch.read/wait/close`，只做外部资源门卫。`VmMemoryObservation`/`GuestMemorySample`为具名只读projection，无DB表/持久Agent状态。 |
| MCP       | none：无内存管理、pressure发布或VM重启工具；模型命令继续原生bash。                                                                                                                                                                                                                                                                    |
| 员工UI    | none：没有新设计；复用原生stdout/stderr/退出码与LlmError失败。                                                                                                                                                                                                                                                                        |
| 后台UI    | none：没有管理页面；资源事实由后续监控通过公开投影消费。                                                                                                                                                                                                                                                                              |
| 权限/开关 | VM/person/org/instance/leaseEpoch全量绑定；网关沿`ModelGatewayAuthority.assertCall`实时核本人、员工、原生根/子树、Run/call、当前代际和配置。没有独立企业/员工开关或资料授权，资料级别none：仅宿主运行诊断；员工不可自行启用。                                                                                                         |

allowlist：`VM_MEMORY_CONTRACT_VERSION`、`VM_PHYSICAL_MEMORY_BYTES`、`VM_MEMORY_PHASE4_REFERENCE_POLICY`、`VmMemoryPolicy`、`VmMemoryError`、`VmMemoryErrorCode`、`GuestMemorySample`、`VmMemoryObservation`、`VmMemorySource`、`VmMemorySourceWatch`、`VmMemoryAdmissionPort`、`VmMemoryAdmissionWatch`、`createVmMemoryAdmission`、`createVmMemoryGuestPlan`、`VmMemoryGuestPlan`。guest工件由`createVmMemoryGuestPlan({persistentDirectory,policy,policyRef})`返回，消费者不deep-import脚本实现。没有通用object/any、guest身份输入或跨模块SQL。

| 方法                                                              | 入参/结果/错误与调用方                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createVmMemoryAdmission(source)`                                 | host-only `VmMemorySource` → `VmMemoryAdmissionPort`；不执行guest/模型、不建额外身份。                                                                                                                                                                                                                                  |
| `VmMemoryAdmissionPort.watch(binding,signal)`                     | host-only `PersonVmBinding`、原生`AbortSignal` → `Promise<VmMemoryAdmissionWatch>`；错误`VmMemoryError`或原signal取消。source建立后若已取消，先等close再返回取消。                                                                                                                                                      |
| `VmMemoryAdmissionWatch.read/wait/close`                          | 无guest业务入参；read同步返回`ready/queued`或具名错误；wait返回通知的`Promise<void>`并沿原signal取消；close幂等，所有调用等待同一真实detach Promise。没有业务幂等键或副作用重放。                                                                                                                                       |
| `VmMemorySource.watch`及其`read/wait/close`                       | 相同host binding/signal；read返回`VmMemoryObservation                                                                                                                                                                                                                                                                   | null`，其他返回`Promise<void>`；source必须先订阅并缓冲通知、在失效时notify、honor取消和真实close。owner实现尚未绑定，不能由guest实现此权威口。 |
| `createVmMemoryGuestPlan({persistentDirectory,policy,policyRef})` | host选择的guest加密盘绝对路径、完整`VmMemoryPolicy`与已批来源`policyRef` → `Promise<VmMemoryGuestPlan>`；缺来源`approved_memory_policy_required`，非法policy为`invalid_memory_policy`，非法目录为`invalid_guest_memory_directory`，工件读取失败保留原错误。仅生成计划，无stream或执行副作用，不能从模型参数取宿主路径。 |

兼容规则：wire/model消息保持DSH当前单代及gateway v1；host创建gateway增加必填memoryAdmission，旧host消费者须显式升级装配，不能缺省放行。新旧guest工件按同一发布树/contractVersion固定，初始化拒绝不支持的版本，不并存两代DSH。私有数据仅进程内订阅/首次错误和guest资源配置，无新DB模式；诊断投影不是Agent事件/状态机。

## 参数与可信观察

`VmMemoryObservation`所有顶层字段必填。`physical.configuredBytes/enforcedBytes`必须都是外部provider核实的2147483648；`enforcedBytes`不是RSS或guest自报。`binding`精确匹配当前host epoch；`revision/evidenceRef`非空。`host.vmRssBytes/helperRssBytes/swapBytes`分别为非负安全整数或null，null表示未知，不能计0。`guest`可null，所有guest计量只是可篡改诊断。压力决定`normal/pressure/unavailable`由VM外受管observer提供；类型形状及字符串不建立信任，禁止把guest JSON、请求header或原生日志直接包成source。

source订阅先于读取，通知缓冲；source负责断连、失效、takeover及退出时将事实标unavailable并通知。没有本包默认TTL、轮询、阈值、队列长度或等待超时。缺观察/失效、错binding、错cap分别返回`VmMemoryError`的`MEMORY_OBSERVATION_UNAVAILABLE`、`MEMORY_BINDING_INVALID`、`VM_MEMORY_CAP_INVALID`，原生LlmError沿同code及可读说明返回，不向ApiError.details塞任意VM数据。source必须遵守AbortSignal、close幂等并等待自己实际detach；客户端取消不是未发生副作用的证明。

参数没有产品默认，必须由宿主显式传入`VmMemoryPolicy`和实际批准/config release的`policyRef`；该字符串不授予批准，owner仍须核来源。缺参数批准来源是装配阻断，不能用样机批准替代。`VM_MEMORY_PHASE4_REFERENCE_POLICY`仅供历史对照/显式fixture。Linux入参校验保持字节非负整数、正swap长度、原生oom_score_adj范围和high≤max；command oom.group=0是本方案EXIT trap的局部回执前提。历史样机参数出处：`sandbox-research-20261120/PHASE3-AUTHORIZATION.md`、`PHASE4-AUTHORIZATION.md`及phase4 `setup-memory.cjs/start-web.cjs/bash-guard.sh`。2GiB磁盘swap；DSH low256MiB、swap.max512MiB、oom_score_adj=-900；命令父组high768MiB/max1280MiB/swap.max2048MiB/oom.group=0，child同RAM/swap，命令oom_score_adj=800。phase4真实OOM另把单child RAM/swap各设256MiB，仅验证该受限样题，不是默认值的容量证明。样机192MiB、700MiB+128MiB判压、250ms轮询/180秒超时未冻结成平台配置，本包不采用。

## 调用、取消、并发及未知

gateway创建必须显式注入memoryAdmission，没有未配置自动放行。模型fetch先等内存，再申请已有全局person 8路；容量恢复后再核内存和现权。每个模型SDK retry都重复该过程。auth-refresh保留#903原生事务/落盘/独立取消合同，已经开始的refresh不按模型压力中断。

slot提交期间压力变为queued时，先持久结算`dispatchObserved:false/outcome:canceled`并释放此slot，再回内存等待，下一次新intent使用新ID。没有HTTP被发送；既有usage按false排除，所以不计作模型调用。结算失败保留原unknown slot并失败，不在占用slot时等压力。开始实际HTTP之后不因新压力强杀该流，取消/撤权继续等实际transport收尾。source订阅覆盖最后同步read到dispatch之间，避免异步close打开新窗口。

原生SDK可能把fetch异常变为自己通用错误终态，transport独立保留宿主首次memory failure，drain之后返回具名错误；ledger失败仍优先。未知账本保留既有恢复门禁，无TTL自动释放/原生call重放。业务operation/账本、原生日志/工作文件/employee配置与VM盘一同纳入BOUNDARY-CONTRACT第7节恢复集合。观察是当前外部事实，重启后须重新建立，旧快照不是当前压力权威；不会恢复“允许”缓存或重发命令。

启用顺序为owner核当前本人/epoch及已批平台资源policy→provider实核物理cap→stage/initialize成功→建立可信source→显式注入gateway→原生runtime就绪；本片没有开启4.0。关闭/撤权由宿主先`gateway.revoke(binding)`取消等待及实际请求并等待owned drain；source同时invalidate/notify，关闭所有订阅后VM owner再停机。更新/删除沿owner当前epoch与原生配置生命周期，本模块不删盘、不创建线程。事件投影仅资源诊断，streamRef=none（通知不是原生会话事件流，没有自建游标/重建执行）；source revision/evidenceRef供旁证关联。恢复后重建当前source，副作用未知仍走既有账本对账。

## Guest工件与原生接缝

`createVmMemoryGuestPlan`返回文件、显式initialize命令、launcher和环境；生成工件无副作用。VM owner只将它们stage到本人加密持久盘，Linux guest root执行initialize成功并回读swap/memcg后，以`/bin/sh <launcher> <原生DSH可执行文件> ...原argv`启动。launcher在exec前进入DSH组并设置policy中的OOM优先级，原生bash继承BASH_ENV，shell在每命令child组设置对应命令优先级（phase4参考分别-900/800，非本模块默认）。原生DSH仍负责工具调用、超时、进程取消、stdout/stderr、退出码、会话和继续，无第二shell executor或私有DSH接缝。

初始化拒绝错误已有swap、不重格式化活动swap、不悄悄更改live组不同配置；失败退出75。原生bash EXIT trap按自己的`memory.events.local`增量判断OOM；`oom_kill`来自任何OOM killer，只有同时见本child的`oom`增量才称`COMMAND_MEMORY_LIMIT`，否则`COMMAND_OOM_KILLED`明确原因需核。137本身不当OOM。局部OOM复用样机中文说明和137，不制造原生isError/成功或执行第二遍。退出前移出child再删除空组；仍有后代时组保留，native进程owner须真实收尾，不能为了清理回执杀未知任务。

guest内保留root，配置可被改写/绕过，不构成员工隔离或外部授权。low是尽力保护，-900不是绝对免杀，父组/全局OOM下不能承诺任意负载会话永活。[Linux cgroup v2文档](https://docs.kernel.org/admin-guide/cgroup-v2.html)规定high主要慢化、max触发局部OOM、swap.max单独限制交换；events.local避免把后代事件当父组局部事实，oom_kill本身不能证明哪级触发OOM。

## 验收与移除边界

本片受影响测试覆盖原HTTP→真实原生provider→loopback上游，guest测试只注入合成sysfs或短bash；均无真实模型、VM、PG、浏览器、QA/M5/压力分配。新测试为普通native单测，由vitest实际收集；未创建假手工integration叶冒充VM验收。首败、后续修复、计数与资源释放以本卡QA回执为准。

仍待MET266/父线公开冻结：物理cap运行证明、经批准的平台swap/memcg/OOM参数与来源、guest初始化/launcher挂载、可信外部observer和判压来源；仍待父线真实测：多线程压力/排队，局部、命令父组、全局OOM及恢复、同会话原生日志保持、host helper额外RSS/swap、CPU/容量包络。未通过不能报整卡/模块迁入或“可慢可排队、不能杀会话”已验收。没有删除任何原生功能。MET-225新增行`allrice-vm-memory-v1`交父线登记，监控owner须对observer失效和OOM诊断补真实告警接线。
