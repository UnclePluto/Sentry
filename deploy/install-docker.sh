#!/usr/bin/env bash
set -euo pipefail
# 仅安装缺失的 Docker Engine 与 Compose，不执行全系统升级。
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  docker version --format '{{.Server.Version}}'
  exit 0
fi
. /etc/os-release
if [[ "$ID" != ubuntu ]]; then
  echo '此安装脚本仅适用于 Ubuntu。' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
if ! curl --connect-timeout 15 --max-time 60 -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; then
  echo 'Docker 官方下载站不可达，改用当前已签名的 Ubuntu 软件源。'
  apt-get install -y docker.io docker-compose-v2
  systemctl enable --now docker
  docker version --format '{{.Server.Version}}'
  docker compose version
  exit 0
fi
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker version --format '{{.Server.Version}}'
docker compose version
