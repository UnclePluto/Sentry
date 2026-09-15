#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# .env 中固定镜像版本；只更新应用容器，不删除持久化数据。
docker compose pull
docker compose up -d --wait --wait-timeout 120
docker compose ps
