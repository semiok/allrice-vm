## 改了什么

- Linear：MET-
- 仓库：`semiok/allrice-vm`（repository ID `1469490636`）；源 HEAD / 依赖 PR：
- DSH 写前对照：原生做法 / 直接复用 / SaaS 必须自补；无关任务写“不涉及 DSH 原生能力；无”。
- 涉及 DSH 差异时写 MET-225 对应行；依据与删除内容：

## 怎么验证的

- 风险档位 L0 / L1 / L2 / L3；按 [AGENTS.md](../AGENTS.md) 第 10 节列出实际命令、结果与原件。
- CI 链接必须指向本仓 exact-head；复核 SHA / tree：
- 运维/CI 变更无需用户视角产品测试时说明例外；资源已释放：

## 风险

- 环境、端口、存储、数据库、权限、执行包变化及回退方式：
- 健康检查/告警覆盖；旧来源原件是否保留：
- DSH 配置/接缝/补丁改动同步 [复用与替代决策](https://github.com/semiok/allrice-vm/blob/main/docs/architecture/dsh-reuse-and-replacement.md)。

## 没做的和后续

- 明确区分源码就绪、CI 通过、已合并、已安装、已部署、已验收；待批准或待验证项：
