# AllRice Linux 测试机开关

这套工具针对一台已存在、EBS-backed 的 arm64 c7g.metal。由操作员把本次 AWS 目标和已发布身份放在仓库之外的私有 JSON：

```json
{
  "account": "123456789012",
  "region": "us-east-1",
  "instance": "i-01234567890abcdef",
  "profile": "allrice-trial",
  "release": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "tree": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "manifestDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "healthUrl": "https://trial.example.com/api/health/ready"
}
```

- 在 AWS 控制台给这台试验机登记 `AllRicePurpose=4.0-linux-trial`，运行 `python3 scripts/linux/ec2-power.py policy --target PRIVATE_CONFIG` 得到权限清单。变更权限绑单实例 ARN 和试验标签。AWS 的 Describe 权限不能绑资源 ARN，清单仅给 DescribeInstances，并以区域条件限制。创建、终止、Spot、卷和 SSM 权限另由现有操作员管理。 [AWS EC2 权限表](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html)
- 使用指向该测试账号的独立、现代 Identity Center SSO profile，通过 `aws sso login --profile allrice-trial` 自行登录。配置只放上面的非凭据字段。SSO 配置和临时缓存留在本机，工具屏蔽其它 AWS 环境凭据和默认 profile，AWS 调用的失败仅报告操作和退出码。
- `status` 将 EC2 状态和已封签的 Web 就绪分别报告。`start` 只对 stopped 发普通 StartInstances，已启动或在启动时只等待。就绪探针核 Web 发布 SHA、tree 和 manifest。超时后先查状态。
- `stop` 有普通关机与状态等待逻辑，必须走持续冻结 admission 的真实宿主 drain。当前 Workflow 没有交付可接入的整机排空证明入口，CLI 对运行中的实例返回 deferred。模拟测试使用注入的 owner gate 证明匹配后才调用普通 StopInstances。CLI 没有凭手工 JSON、标志或超时强关的入口。真实接线须把 VM/连接退尽、PG 同步以及持续冻结与同一目标绑定。
- 本轮不创建或调用 AWS 资源。终止实例、迁移卷、设置 timer 和自动回收不在这条脚本的命令内。

公开依据：[EC2 正常 Start/Stop](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Stop_Start.html) · [AWS CLI Identity Center](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)。
