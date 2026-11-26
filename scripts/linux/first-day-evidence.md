# Linux 首日验收证据

按迁移方案第 9 节在获批的目标机分步执行，并为每次尝试保留私有目录。采集端记录起始实例 ID、运行 ID、发布 commit、tree 和 manifest digest。恢复演练涉及替换机时，`run.target` 仍指起始实例，`recovery` 原件记录旧实例和替换机 ID 及卷归属。每个阶段封存原始输出和退出码后再填索引。`fixture` 用于 M1/M5 演练，`linux` 仅填目标机实测。失败或中断保留原目录，复验另开运行 ID 和目录。

索引使用下列 JSON 字段。这里的 commit、tree、seal 均为格式示例。

```json
{
  "version": 1,
  "run": {
    "mode": "fixture",
    "target": "local-fixture",
    "id": "trial-01",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "tree": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "seal": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  },
  "records": []
}
```

每条 `records` 记录包含 `step`、采集时的 `run`（同上六个字段）和 `result`（`pass`、`fail` 或 `skip`）。`pass`/`fail` 都要附 `artifact: { "file": "阶段日志文件名", "sha256": "原件的 64 位小写十六进制 SHA-256" }`。原件必须与索引在同目录，且为非空普通文件。`skip` 则填 `reason`，可用 `not-run`、`not-authorized`、`blocked` 或 `unavailable`。尚未采集的阶段可以不填。各阶段独立留证，文件名和字节均不得重复。单个阶段的多个原件可封成一个已审核的归档。报告不读取凭据配置，也不输出原件正文。索引和文件名不写 Cookie、令牌、连接串或个人数据。

| 步骤          | 原件应包含                                                                           |
| ------------- | ------------------------------------------------------------------------------------ |
| `preflight`   | AMI/内核、实例和卷身份、封签、权限、依赖                                             |
| `host`        | 非 root KVM、独立 scratch 的 XFS/LUKS2、严格 reflink 与写隔离                        |
| `single-vm`   | 合成 VM 创建、first exec、媒体与 swap、隔离拒绝及正常卸载                            |
| `workbench`   | Web/Worker/PG、Tunnel 来源、合成账号认证、工作台与权限拒绝。真实发送另记，需另行授权 |
| `timing`      | 各启动形态至少三组同头分段数据及独立主机启停、域名重连                               |
| `concurrency` | 1→2→4 人并发数据，以及 VM、mapper、loop、锁、进程和端口释放                          |
| `recovery`    | 合成 PG 的安全替换与恢复、旧主机与卷归属、账单及保留资源                             |

```sh
node scripts/linux/first-day-evidence.mjs /private/run-directory/index.json > report.md
```

退出 `0` 表示所列目标机证据齐备、可人工复核，`2` 表示缺项、跳过或模拟，`1` 表示失败、前置未通过或证据无效。索引身份有效时，即使后续原件损坏，报告也会保留此前核对过的失败行。工具核对运行身份、原件摘要和每步前置状态。封签权威、采集端身份、实际执行时间顺序、日志语义和硬件结论由操作者与验收人核对。工具只读现有文件。依赖、合成 PG、VM、网络和 AWS 资源由已批准的目标机流程另外取得。
