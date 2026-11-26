# snow 清零演练与正式执行清单

本目录是 4.0 运维演练，独立于部署和 qa-instance。没有 live 模式。演练用同仓迁移和合成数据做 `pg_dump`，再恢复到专用 Unix socket 上的新库。它不会读取 Dev dump、凭据或环境文件。只在 M5 运行。

```sh
m5-test HEAD --on m5 --db --build 'python3 scripts/m1/snow-reset/rehearse.py && pnpm build:test-sources' -- scripts/m1/snow-reset/vm.test.ts --maxWorkers=1
```

SQL 按企业及 snow 用户 ID 枚举实例、会话、Run、派驻和已核实的本人私有员工源。按正向外键关系找从属行，保留共用员工版本和对象。已验证的 message-based Memory 也纳入。遇到未审从属表、跨人引用、非终态 Run、未归还 job lease、删除环或外键错误，整笔回滚。演练在同一事务只暂停四个已列出的不可变拦截器，外键始终启用，检查触发器恢复。对象存储、工作流、定时、审核、插件等若出现未审关联，需按实际库存补足清单。演练成功不证明 snow 实际数据已覆盖。

VM 演练调用真实的 `PersonVmService.delete(…, {deleteDisk: true}, …)`，模拟 store、native 和 disk，验证单独的删盘权限、只删除匹配本人、第二次不再删盘。生产 authority 当前仅授权 read/create/start（`apps/worker/src/person-vm/production-authority.ts`），生产 Host 对外接口只有自身收尾和模型恢复（`production-host.ts`）。等 Host owner 提供经授权且绑定精确 VM 的调用入口，再把此阶段纳入正式包。不得用 SQL 改 VM 状态、另造生产 authority 或直接删除文件。VM 的 `deleted` 行和审计证据允许保留，物理 disk 与 native VM 必须无存留。

## 正式执行前置及顺序

1. **锁定范围与批准。** 仅发布负责人操作 4.0 Dev。由规划线批准具体执行窗口、实际部署 SHA、企业 UUID 和 snow 用户 UUID。校对 username、租户成员关系、VM ID/epoch、本次 4.0 数据库和隔离 3.x 的标识。拒绝活跃会话写入、Run、审批挂起、VM lease/hold 或计划中的 wake。避免其它流量重建其 VM 或员工，保留其他账号和服务可用。
2. **备份。** 生成受保护的 4.0 逻辑备份，检查 TOC、SHA 和隔离恢复。另存原 rollout 行及 snow 选中行的可恢复快照。由 Host owner 用现有受支持办法在处于安全静止时备份**该**加密盘及其密钥/元数据，并核实隔离恢复办法。若不能证明可恢复，先停报；PG dump 不含 VM 或盘。所有秘密只留本机保护目录，禁止复制到 M5、提交或打印。
3. **先跑计划、再执行。** 对恢复库做实际 snow 的全量关联审计，校对无 FK 的业务关联与对象引用。生产侧以批准的发布锁/同人写入冻结保证库存稳定。现版 SQL 只允许合成 restore，正式用经复核的适配包。Host 先确认精确旧实例静止，再经现有 person-vm 删除路径取独立删盘回执，确认 native 不再活动、磁盘不保留后才执行同人的业务数据事务。否则停在原阶段，回报半完成状态。删除失败不得写按人开通。
4. **灰度。** `policy_format` 保留为参数，演练的 `person` 是候选合同的 `{organizationId,personId}`，`tuple-remove` 仅移除 snow 旧三元组。实际启用须新建员工 PR 完成合入并部署，核对 deployed schema 和发布接口。保留默认 `3.x`、其他条目及顺序；若还有他人旧三元组，停止交发布策略 owner，禁止静默翻译。新旧格式尚未切换时不写生产名单。
5. **读回。** 用外键检查和确切范围查询证明实例、Run、会话、派驻及已认定下属落到 0，确认无有效 VM 或保留盘，snow 只有一个同企业按人开通项。对比 admin、验收员、企业、真人账号、凭据记录和非 snow 业务行都未改。零员工验证走 4.0 入口，旧 EmployeeHub GET 有补建副作用。
6. **回滚。** 事务中首败回滚 SQL，不盲目重试 VM。若 VM 阶段已提交，按原 VM 备份独立恢复并核对原实例、盘和密钥。一旦 SQL 已提交，先冻结同人写入，再从核验过的副本以外键顺序只恢复 snow 行，按变更前 revision 和实际当前名单做目标条目恢复。全库恢复会覆盖其他人后续写入，只能单独获批并走故障恢复流程。取消原窗口前重复读回并释放锁。所有步骤先走演练，正式执行等待规划线下令。
