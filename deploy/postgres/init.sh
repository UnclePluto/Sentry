#!/usr/bin/env bash
set -euo pipefail
# 只在全新 PGDATA 执行。运行身份无 DDL 权限，迁移身份单独保管。
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=runtime_password="$(cat /run/secrets/runtime_password)" <<'SQL'
CREATE ROLE sentry_app LOGIN PASSWORD :'runtime_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE sentry TO sentry_app;
GRANT USAGE ON SCHEMA public TO sentry_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO sentry_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO sentry_app;
SQL
