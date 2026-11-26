# Ubuntu arm64 主机初始化与自检

目标是 AWS c7g.metal 上的 Ubuntu Server 24.04 ARM64。初始化由发布操作员在目标机执行。

1. 先在控制台核正独立数据 EBS 的卷 ID 和保留设置，按运维台账挂到 `/var/lib/allrice40`。另准备**一次性** LUKS2/XFS scratch mount，和数据卷分开。统一使用预先登记的文件系统 UUID。初始化工具只读取既有身份，不生成密钥、格式化磁盘、创建 loop、连接 mapper 或改 mount。
2. 用 `host-preflight.py install-deps` 看 apt 命令。经批准的目标机上加 `--apply` 装系统级依赖。用发布制品另装固定 Node、pnpm、MSB/firmware/agentd。为 Worker 设置受控的 `kvm` 组权限。不要给 Worker root。
3. 以有权读取 mapper 的发布操作员运行 `host-preflight.py check-luks --scratch-mount PATH --scratch-uuid FS_UUID --scratch-luks-uuid LUKS_UUID`。记录 XFS 和 LUKS2 对该 UUID 的检查结果。
4. 以真正的非 root Worker 账号运行 `host-preflight.py check-runtime --scratch-mount PATH --scratch-uuid FS_UUID --scratch-luks-uuid LUKS_UUID --data-uuid UUID --node ABSOLUTE_NODE --msb ABSOLUTE_MSB`。检查 cgroup v2、PSI、KVM API 12 与立即关闭的空 VM fd、严格 reflink 及写后原件独立、固定 MSB 版本。两条检查对账 scratch 的文件系统 UUID、LUKS UUID 与设备号，并在首个合成 Person VM 之前通过。MSB doctor 会写入有效 MSB_HOME，留到目标机有封签的 scratch 配置后单验。

M5 测试用伪造 mount/cryptsetup、模拟 ioctl 和临时 fixture 验证流程。实际 KVM、XFS、LUKS2、制品和服务 UID 权限仍须目标机取证。这个片段没有接入 Person VM 的磁盘或预热池。
