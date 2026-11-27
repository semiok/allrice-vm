# M1 处置手册 3：镜像丢失

对应告警：`images`（钉死的镜像缺失）。总览见 [m1-monitor.md](m1-monitor.md)。

> 操作前从已批准的 4.0 部署记录核对独立 Colima profile，并将其赋给 `ALLRICE40_CLOUD_PROFILE`。以下命令按此变量定向。

## 影响

Worker 只用 `packages/contracts/src/runtime-v2/cloud-platform.ts` 里按 ID 钉死的镜像（Node、Python 图表、Office、静态浏览器）。少一个，对应的云端功能直接失败（10-21 Office 和 Python 镜像丢失，两天后才被人发现，就是这一类）。告警里列出缺的是哪个。

## 第一步

```bash
export ALLRICE_CLOUD_DOCKER_SOCKET="$HOME/.colima/${ALLRICE40_CLOUD_PROFILE:?}/docker.sock"
export ALLRICE_CLOUD_PROFILE="$ALLRICE40_CLOUD_PROFILE"
export DOCKER_HOST="unix://$ALLRICE_CLOUD_DOCKER_SOCKET" PATH=/opt/homebrew/bin:$PATH
docker --host "$DOCKER_HOST" images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}'
```

和运行中版本要求的 ID 对比（监控就是这样取的）：

```bash
~/allrice40-dev/bin/deploy-dev --status &&
REL=$(/usr/bin/python3 -c 'import plistlib,os;print(plistlib.load(open(os.path.expanduser("~/Library/LaunchAgents/ai.bplabs.allrice40-dev-worker.plist"),"rb"))["WorkingDirectory"])') &&
~/.local/opt/node-22.23.2/bin/node -e 'import(require("url").pathToFileURL(process.argv[1]).href).then(m=>console.log(m.cloudPlatform.images))' "$REL/packages/contracts/dist/runtime-v2/cloud-platform.js"
```

## 处理

先查是谁删的：`docker system prune`、`docker image prune -a`、重建 VM 都会删掉没有容器在用的镜像。**任何人都不要在沙箱 VM 里跑 prune。**

1. **有导出的镜像包**：`docker --host "$DOCKER_HOST" load -i <文件>`，再确认 ID 和上面一致。
2. **没有导出包**：用获准 4.0 发布的构建文件和上面导出的 socket。Python 使用 `infra/docker/Dockerfile.python-charts`，Office 使用 `infra/docker/Dockerfile.office-sandbox`。静态浏览器从发布目录执行 `ALLRICE_DOCKER_CLI=/opt/homebrew/bin/docker ALLRICE_CHROMIUM_VERSION=156.0.8078.47 node scripts/build-static-browser-runtime.mjs`，脚本用 `ALLRICE_CLOUD_DOCKER_SOCKET` 指定构建 VM。构建结果的 ID 须与登记值一致。另有差异时，记录镜像 ID 与差异，按 PR 流程更新 `cloud-platform.ts` 后再部署（见 MET-218“镜像不可复现”）。
3. Node 镜像是多架构 index，可以从官方源按摘要重新拉取。

## 确认恢复

```bash
~/allrice40-dev/bin/monitor run --dry-run | grep images
```

4.0 发布冒烟只验证原生工作台入口。Office、CSV、云浏览器的真机复核按各自验收范围执行。

## 后续

把 4.0 钉死镜像定期 `docker save` 到 `~/allrice40-backups/images/` 记在 MET-222 后续事项里。
