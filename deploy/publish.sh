#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=${1:?用法：deploy/publish.sh 镜像版本号}
if [[ ! "$version" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo '镜像版本号格式无效。' >&2
  exit 1
fi
image="crpi-vu9eu0iguupfgpzi.cn-guangzhou.personal.cr.aliyuncs.com/dypluto/sentry:$version"
docker buildx build --platform linux/amd64 --load -t "$image" .
docker push "$image"
printf '镜像已发布：%s\n' "$image"
