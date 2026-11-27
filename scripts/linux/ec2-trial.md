# c7g.metal 首台 Linux 实机验收

这份工具给已获批、已装配的一台测试机用。启动命令沿用 [#42 的电源边界](ec2-power.md)，并在公网 Web 同封签就绪后调用固定 SSM 探针。首次配置、真实整机停机与切回旧 release 仍归发布操作员。

## 地区和成本

2026-11-27 01:11 UTC 的 AWS 公共 Linux Spot 区域参考价如下。按既有方案先查北弗吉尼亚的具体 AZ；如果尚未建盘，可以同时查北加州更低的参考报价。已有卷后就用卷所在的 AZ。报价、规格有售和当前 Spot 容量分别核对。 [AWS 公共 Spot 价源](https://website.spot.ec2.aws.a2z.com/spot.json) · [按 AZ 查 Spot 历史](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances-history.html)

| 用途               | 区域                   | Spot USD/h | 8 小时计算费 |
| ------------------ | ---------------------- | ---------: | -----------: |
| 首查               | 北弗吉尼亚 `us-east-1` |     0.7175 |         5.74 |
| 尚未建盘时同时比价 | 北加州 `us-west-1`     |     0.4580 |         3.66 |
| 原方案备用         | 俄勒冈 `us-west-2`     |     0.8694 |         6.96 |

北弗吉尼亚按需参考 $2.32/h，8 小时 $18.56。计算费另加 EBS、IP、快照及流量。选择不属于 Fleet、launch group 或 AZ group 的 EBS-backed persistent Spot，请求设置 interruption behavior 为 Stop。只在此前人工正常停止、同一 AZ 有容量且 Spot 价低于上限时手动复启。AWS 主动中断或停机原因未知时先让 AWS 按请求恢复，或交操作员处理。若该 AZ 缺容量或需要固定演示时间，先由用户批准按需支出。本工具只认已选定的实例与市场类型。 [AWS 按需价表](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20%28N.%20Virginia%29/Linux/index.json) · [AWS Spot 停机和重开](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances-request.html)

有权看价的操作员可用控制台，或在本机已登录的价格查询 profile 上运行下面两条只读查询；运行账户可用 Standard Spot 及按需 vCPU 配额都应在所选市场留够 64，建议预备 96。报价查询用单独只读权限 `ec2:DescribeInstanceTypeOfferings` 与 `ec2:DescribeSpotPriceHistory`，限定 Region。 [AWS EC2 权限表](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html) · [C7g 规格](https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html)

```sh
aws --profile "$PRICE_PROFILE" --region "$REGION" ec2 describe-instance-type-offerings \
  --location-type availability-zone --filters Name=instance-type,Values=c7g.metal
aws --profile "$PRICE_PROFILE" --region "$REGION" ec2 describe-spot-price-history \
  --availability-zone "$AZ" --instance-types c7g.metal --product-descriptions 'Linux/UNIX' \
  --start-time "$START_UTC" --end-time "$END_UTC"
```

## 需要用户提供什么

| 提供或确认           | 要点                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 预算和窗口           | 选定 Region/AZ、Spot 最高愿付价、是否允许按需和运行时长。首次创建由 AWS 操作员另外执行。                                                                                                                                            |
| 单台目标的非秘密身份 | 12 位 AWS 账号 ID、Region/AZ、EBS-backed `c7g.metal` 实例 ID、市场类型、数据 EBS 卷 ID及试验域名。实例标 `AllRicePurpose=4.0-linux-trial`，数据卷标为终止时保留。                                                                   |
| 本地 SSO 权限        | 在自己的电脑配置并登录独立 Identity Center profile。只需填非秘密 profile、权限集名，用户自行完成 SSO。                                                                                                                              |
| SSM 前置             | 在实例绑定单机 SSM instance profile，SSM Agent 至少 3.3.40.0。管理员发布本仓 `trial-probe.ssm.json` 为私有 `AllRice40-LinuxTrialProbe` 并提供 AWS 显示的数字版本与 SHA-256。这个文档名只放审核过的固定命令版本。                    |
| 磁盘、制品及恢复前置 | 发布操作员补上数据 FS UUID、独立 disposable LUKS2/XFS scratch 的外层 LUKS 与内层 FS UUID、现版与可选旧版的 SHA/tree/seal。操作员在受控秘密存储准备卷解锁、PG、Tunnel 所需权限。填写两份示例的相同字段，用户和脚本交接只用非秘密值。 |

## 最小权限

- **运行权限集**。在私有、权限 0600 的 `trial.json` 填 [控制端示例](ec2-trial.target.example.json)，运行 `python3 scripts/linux/ec2-trial.py policy --target /private/trial.json` 生成 IAM JSON。包含单区域 `DescribeInstances`、限定实例 ARN、标签、AZ、机型及根卷的 `StartInstances`、单实例 `GetConnectionStatus`，以及该实例与指定私有文档的 `SendCommand`。API 对 `GetCommandInvocation` 不支持实例 ARN，生成策略只按 Region 限制该读取权限。建议用专用试验账号，探针输出只含验收状态和非秘密身份。身份核对会调用 `GetCallerIdentity`，该 API 无需额外授权。 [AWS EC2 权限](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html) · [AWS SSM 权限](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssm.html) · [STS GetCallerIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html)
- **实例角色**。用 `ec2-trial.py agent-policy --target /private/trial.json` 生成仅包含 Agent 心跳和四项消息通道的实例角色权限，信任主体为 EC2。按所选 Region 限制，无 Parameter Store 权限。更换 Agent 模式时由管理员单独核对，继续限源站与 SSM 所需出站。 [AWS Agent 最小消息权限](https://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-create-iam-instance-profile.html) · [Agent 版本和消息通道](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-setting-up-messageAPIs.html)SSM 文档在 root 下调用固定绝对路径，文档无参数。把发布文档及安装脚本的权限留给已有的发布操作员。运行角色只持生成的权限集。AWS 允许在调用中固定文档版本和哈希，主流程同时核 invocation 的实例、命令、插件、文档及回执。 [AWS SSM 实例角色](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-instance-permissions.html) · [SendCommand 的版本和哈希](https://docs.aws.amazon.com/cli/latest/reference/ssm/send-command.html)
- **关机角色**。现行启动权限集中没有 `StopInstances`。真实 owner drain 接线完成后，关机权限才由发布负责人单独授给绑定该实例 ARN、标签、AZ、机型和 EBS 根卷的关机角色。#42 需要连续冻结准入、VM/连接退出和 PG 落盘的同目标证明。

## 离线演练与上线后的用法

先演练。三条命令可在空 AWS 配置环境运行。示例值只用于演练。

```sh
umask 077
TRIAL_PLAN=$(mktemp)
cp scripts/linux/ec2-trial.target.example.json "$TRIAL_PLAN"
python3 scripts/linux/ec2-trial.py start --target "$TRIAL_PLAN" --dry-run
python3 scripts/linux/ec2-trial.py stop --target "$TRIAL_PLAN" --dry-run
node scripts/linux/host-acceptance.mjs --dry-run
rm "$TRIAL_PLAN"
```

目标机前置装配由发布操作员完成。用 Ubuntu 24.04 arm64，配置 Node 22.23.2、固定 MSB/firmware/agentd 和已封签的 Web/Worker release。按 [宿主初始化](host-preflight.md) 和 [systemd 安装](service-manager.md) 准备只读制品、数据卷、scratch、独立合成 PG、试验 Tunnel 和 `allrice` 账号。数据卷按 EBS ID 挂到 `/var/lib/allrice40`，scratch 是与根卷及数据卷物理分离，挂在 `/mnt/allrice-trial-scratch`，允许 `allrice` 在其内创建并清理 reflink 临时样本。启动前让 systemd 能在 EC2 开机时正常加载经过封签的两个单元。实际盘准备由运维路径负责。

将同一审核头中的 `host-acceptance.mjs`、`service-manager.mjs`、`host-preflight.py` 放入 root 持有且普通服务用户不可写的 `/opt/allrice40/trial/bin`，将填好的 [宿主示例](host-acceptance.example.json) 放入 `/etc/allrice40/linux-trial.json`（root 持有，0600）。以本地 SSO 登录后运行：

```sh
umask 077
RESULT=$(mktemp -d /private/trial-attempt.XXXXXX)
python3 scripts/linux/ec2-trial.py start --target /private/trial.json \
  > "$RESULT/boot-result.json" 2> "$RESULT/first-run.log"
python3 scripts/linux/ec2-trial.py stop --target /private/trial.json
```

开机先按 AWS 读回核同一账号、实例、AZ、类型、市场和保留卷，再等公网 Web 的 commit/tree/seal。固定探针自动核对实际挂载的底层 EBS serial、两条运行中的 systemd 单元及两个 `ExecStartPre` 的原字节、非 root KVM、LUKS2/XFS、严格 reflink 写隔离、本机 Web/Worker 与各自 systemd MainPID 对账，并用 Web 进程 boot ID 确认公网就绪来自该源站。若给了旧版身份，再以非 root 的同头版本校验器复核旧版完整制品封签及数据 UUID。 [AWS EBS serial 与卷 ID](https://docs.aws.amazon.com/ebs/latest/userguide/identify-nvme-ebs-device.html)

每次启停复验另建私有目录，避免覆盖首件。有 command ID 后立即写入本次脱敏日志。控制端只复读同一 invocation 的暂时错误，遇到鉴权失败或截止后退出，不自动重发 probe。检查失败后实例可能仍在计费，用现有 #42 的 `status` 和拥有真实排空权限的发布操作员收尾。当前 `stop` 对运行中实例仍返回 deferred。回滚候选检查不切换 release，不触发数据库恢复。

- **启停复验**。发布操作员真停并确认 EC2 stopped 后，将首轮 0600 回执用于 `start --target /private/trial.json --before "$RESULT/boot-result.json" --transition restart`。脚本核 EC2 开机前 observed stopped、同一实例/EBS/FS/封签和不同内核 boot ID。旧回执与原 SSM invocation 输出逐项比对，无法读回就停报。
- **回滚复验**。首次保留已验旧版身份，按发布手册切换已批准旧 release 及必要的数据恢复，更新两侧当前封签字段。用 `start --target /private/trial.json --before "$RESULT/boot-result.json" --transition rollback` 核活动版本确实是先前核过的旧版，并检查同目标和盘。版本切换与数据库可恢复性仍以合成 PG 的实际恢复证据验收。
