# 阿里云 ACR + ECS 部署

仓库：`https://github.com/UnclePluto/Sentry.git`。镜像：`crpi-vu9eu0iguupfgpzi.cn-guangzhou.personal.cr.aliyuncs.com/dypluto/sentry`。服务器：`47.122.114.59`，架构 `linux/amd64`。

## SSH

服务器 root 已追加本机 `id_ed25519.pub` 公钥，原有公钥保留。私钥不上传到服务器、GitHub 或镜像。

```sh
ssh sentry-ecs
# 或使用完整命令：ssh -i ~/.ssh/id_ed25519 root@47.122.114.59
```

## 构建并推送镜像

先交互登录 ACR，使用 ACR 专用密码，不使用服务器登录密码：

```sh
docker login --username=dypluto crpi-vu9eu0iguupfgpzi.cn-guangzhou.personal.cr.aliyuncs.com
./deploy/publish.sh v1.0.0
```

也可以在 GitHub 仓库配置 `ACR_PASSWORD` Secret，再手动运行“发布 ACR 镜像”工作流。镜像以 `sha-完整提交号` 标记；该流程只发布镜像，不把本机 SSH 私钥交给 CI，也不自动重启服务器。推送 main 自动执行测试与构建。

## ECS 运行

首次在 ECS 上安装 Docker 与 Compose，创建部署及数据目录：

```sh
install -d -m 755 /opt/sentry
install -d -o 1000 -g 1000 -m 700 /opt/sentry/data
```

将本目录的 `compose.yaml`、`update.sh` 及按 `.env.example` 填好的 `.env` 放到 `/opt/sentry`。不要复制本机数据库、Excel 或管理员凭据。先在服务器交互登录 ACR，再执行：

```sh
cd /opt/sentry
docker login --username=dypluto crpi-vu9eu0iguupfgpzi.cn-guangzhou.personal.cr.aliyuncs.com
./update.sh
```

`SENTRY_IMAGE` 必须填写已推送的固定版本。容器以 uid 1000 运行，数据库绑定到 `/opt/sentry/data`，重建容器不删除数据。首次启动自动生成服务器独立的超级管理员，凭据位于 `/opt/sentry/data/initial-admin.json`，通过 SSH 在服务器上读取。没有将本机超管密码打包到镜像。

当前前台域名为 `https://sentry.floatnoise.com`，Nginx 监听 80/443，HTTP 自动跳转 HTTPS。应用前台只监听宿主机 `127.0.0.1:13000`；后台只监听宿主机 `127.0.0.1:3002`。通过本机 SSH 隧道访问后台：

```sh
ssh -N -L 13002:127.0.0.1:3002 -i ~/.ssh/id_ed25519 root@47.122.114.59
```

随后打开 `http://127.0.0.1:13002`。API 3001 和内部渲染 3010 不发布到宿主机。若后续配置域名及 HTTPS，反向代理后台到服务器回环端口，并同时更新 `SENTRY_TRUSTED_ORIGINS` 和 `SENTRY_SECURE_COOKIE`。

前台公网访问需要 ECS 安全组放行 TCP 80 和 443；无需放行后台 3002 或应用端口 13000。演示数据默认开启且明确标识；设置 `SENTRY_NO_DEMO=1` 可禁止首次生成演示数据，但不会删除已经生成的数据。

## 域名与 HTTPS

DNS 的 `sentry.floatnoise.com` A 记录指向 `47.122.114.59`。服务器 `.env` 设置 `SENTRY_DASHBOARD_BIND=127.0.0.1`、`SENTRY_DASHBOARD_PORT=13000` 后运行 `docker compose up -d --wait`。

安装 `nginx certbot python3-certbot-nginx`，将 `nginx.conf` 放入 `/etc/nginx/sites-available/sentry` 并链接到 `sites-enabled/sentry`，禁用默认站点，执行 `nginx -t` 后启动 Nginx。首次签发使用：

```sh
certbot --nginx -d sentry.floatnoise.com --non-interactive --agree-tos --register-unsafely-without-email --redirect
```

Certbot 会在服务器配置中补充证书及 HTTPS 跳转；仓库的 `nginx.conf` 仅用于首次引导，不要覆盖已经生成的 HTTPS 配置。证书和私钥保留在服务器 `/etc/letsencrypt`，通过 `certbot.timer` 自动续期。可执行 `certbot renew --dry-run` 检查续期。后台继续通过 SSH 隧道访问，无需改变后台 Cookie 或信任来源配置。

## 更新、备份与回退

发布新固定版本后，修改服务器 `.env` 中的 `SENTRY_IMAGE`，执行 `./update.sh`；脚本拉取镜像并等待健康检查，保留数据卷。失败时查看 `docker compose logs --tail=100`，不要执行带 `-v` 的删除命令。

升级前停止应用并备份数据目录。若升级涉及数据库结构，回退必须同时恢复旧镜像与相应数据库备份，不能只换镜像。不要将备份、`.env` 或原始数据提交到 GitHub。

安装参考：[Docker Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)。容器构建参考：[Docker GitHub Actions 文档](https://docs.docker.com/build/ci/github-actions/share-image-jobs/)。
