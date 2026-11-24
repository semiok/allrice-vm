# M1 处置手册 6：4.0 隧道与公网入口

对应告警为 `tunnel`、`public_entry`、`public_entry:allrice-admin.bplabs.xyz` 和 `restarts:ai.bplabs.allrice40-dev-tunnel`。总览见 [m1-monitor.md](m1-monitor.md)。

4.0 入口为 `allrice.bplabs.xyz` 和 `allrice-admin.bplabs.xyz`，目标是 M1 的 Web 3311。发布获批并配置后，4.0 独立隧道使用 launchd label `ai.bplabs.allrice40-dev-tunnel` 和专属本机指标地址 `127.0.0.1:20246`。发布负责人在配置单中登记隧道和配置路径。

## 核对故障

```bash
launchctl print gui/$(id -u)/ai.bplabs.allrice40-dev-tunnel
curl -fsS --max-time 5 http://127.0.0.1:20246/ready
curl -fsS --max-time 5 http://127.0.0.1:3311/api/health/ready
curl -fsS --max-time 15 https://allrice.bplabs.xyz/api/health/ready
curl -fsS --max-time 15 https://allrice-admin.bplabs.xyz/api/health/ready
```

先看本机 Web 是否 ready，再看隧道是否至少有一个就绪连接。两个公网响应都应返回已验证的 Web 构建身份，且 `identity.repository` 为 `semiok/allrice-vm`。若仅公网失败，按已批准的 4.0 部署清单核对该隧道及两条路由。

恢复只由发布负责人操作登记的 4.0 job 和独立配置。旧隧道及 `allrice-m1.yml` 仍供 3.x，旧指标端口 20241–20245 的响应归属 3.x。
