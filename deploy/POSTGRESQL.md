# PostgreSQL 部署与恢复手册

本分支以 PostgreSQL 17 为唯一运行数据库。旧 `compose.yaml` 仅供仍运行旧镜像的生产环境及受控回退；新版本使用 `compose.postgres.yaml`。禁止把新镜像直接交给旧 `update.sh`，它没有 PostgreSQL 切换保障。

当前生产切换尚未执行。ECS 的 RAM 角色元数据查询返回 404，OSS 实连、30 天恢复链实测和生产切换必须保留未完成状态。

## 本地开发

1. 启动独立 PostgreSQL 17，创建空数据库。
2. 私有 `.env` 设置 `DATABASE_URL=postgres://用户:密码@主机:端口/库名`；不要提交凭据。首次以迁移身份执行 `npm run db:migrate`。
3. `npm run dev` 启动 API、独立工作进程、前端和代理。运行身份不需要建表权限。
4. 首次空库会生成 `data/initial-admin.json`（600 权限）；迁移已有账号时不重新生成账号或密码。
5. `TEST_DATABASE_URL` 必须指向具有创建测试数据库权限的隔离 PostgreSQL，执行 `npm test`。每个测试用随机数据库并在结束后删除；不接受生产地址作为测试库。

## 单 ECS 容器预算

- PostgreSQL：448 MiB、24 连接、96 MiB shared_buffers、2 MiB work_mem。
- Web/API：512 MiB；工作进程：320 MiB、单个解析任务、解析线程 192 MiB、25 秒超时。
- 备份：128 MiB，单线程压缩；运行时总连接池上限 API 4 + worker 4，迁移单次独立运行。
- 总容器常驻内存上限约 1.4 GiB，为系统和 Nginx 留余量。迁移期间停止工作进程和写入，避免预算叠加。这是初始配置，不代表 1,000 万条或 P95 2 秒已经验证。
- 文件独立卷 `uploads`，数据库独立卷 `pgdata`，所有正式数据长期保存。8 MiB 文件上限；ZIP 中央目录展开声明最多 96 MiB；Sheet1 最多 30,000 非空行。
- PG 不发布端口，应用只绑定回环地址。Nginx 继续用 `sentry.floatnoise.com/` 和 `/admin/`；禁止对外暴露 PG、内部 API、渲染端口。

## 初始化和隔离部署

生成凭据：`node scripts/postgres/init-secrets.mjs /opt/sentry-pg/secrets`。目录 700，文件只读，分别挂载到需要该凭据的容器；不要把目录整体挂给应用。脚本拒绝覆盖现有文件。运行身份 `sentry_app` 没有 DDL 权限，迁移身份独立挂载。

构建应用镜像及 `deploy/postgres/Dockerfile` 数据库镜像，固定版本标签和镜像摘要。配置 `SENTRY_IMAGE`、`SENTRY_POSTGRES_IMAGE`、`SENTRY_SECRETS_DIR`、`SENTRY_DATA_PATH`（属主 UID 1000）、独立的 `SENTRY_BACKUP_INSTANCE` 和环境标识。不得让两个独立数据库写到同一备份前缀。

先启动 `postgres`、完成 `migrate`，然后启动 `app worker`。`backup` 需要先通过 `docker compose ... exec -u postgres postgres sentry-pgbackrest stanza-create` 和 `check`，再启动调度。

迁移服务只应用版本化结构并核对校验和；应用启动仅验证版本，不自动建表或降级。`SENTRY_AUTO_MIGRATE=1` 仅供隔离测试。生产运行不设置。

## 旧库迁移

`node scripts/postgres/import-sqlite.mjs --source /私有目录/sentry.sqlite --snapshot-dir /私有目录/快照`

- `MIGRATION_DATABASE_URL` 或 `DATABASE_URL_FILE` 指向空的隔离目标。工具使用 SQLite 备份 API 制作一致性快照，处理 WAL，校验完整性；不直接复制活动数据库文件，不修改源库。
- 老结构只在快照副本升级；保留原账号、密码哈希、会话、提交归属、汇总、作废审计和标识。旧暂存以创建时间计算 7 天有效期，过期不自动发布。
- 目标有任何现有业务行时拒绝导入；事务失败可在同一空目标重跑。核对失败的目标保持维护状态，必须丢弃该隔离目标并重新迁移，不能开放写入。
- 工具输出数量及多维核对结果，详细报告在私有快照目录。不输出逐行检测值或密码。完成后数据库仍保持维护模式。
- `npm run db:rebuild` 从长期明细重建汇总，单事务发布，读请求不会看到半套汇总。业务写入会等待；应在维护窗口执行。

## OSS 基础备份与 WAL

桶 `oss-pai-k0brz1afnz8dtbcgt0-cn-shanghai`，HTTPS endpoint `oss-cn-shanghai.aliyuncs.com`，前缀 `sentry/postgresql/<环境>/<实例>/`。不改桶级 ACL、生命周期或版本控制，不上传 Excel。

`sentry-pgbackrest` 使用 ECS IMDSv2 读取绑定角色的 STS 临时授权，传入 pgBackRest 进程环境，不写凭据到磁盘或命令参数。角色最小授权应只允许本前缀对象读取/写入/删除，以及带此前缀条件的 ListObjects；其他目录不授权。没有角色即失败，不回退到公开访问或聊天密钥。

PostgreSQL `archive_mode=on`、`archive_timeout=300`；WAL 经 pgBackRest 校验后归档，失败保持非零退出并由 PG 重试，不能静默丢弃。每周完整备份、每日差异备份。pgBackRest 配置 `repo1-retention-full-type=time` / `repo1-retention-full=30`，由其保留窗口前所需完整备份及关联 WAL，不用 OSS 按对象年龄直接删除。全新部署不声称已有 30 天历史。

参考：[pgBackRest 配置及保留规则](https://pgbackrest.org/configuration.html)、[OSS S3 临时令牌请求头](https://www.alibabacloud.com/help/tc/oss/user-guide/0002-00000009)。实际 OSS 协议兼容和 RAM 授权仍必须实连验证。

## 隔离恢复

禁止恢复到在线 PGDATA。工具仅允许空的 `/restore/<独立目录>`，拒绝已有内容或 postmaster.pid。使用相同 PostgreSQL 主版本镜像，独立卷挂到 `/restore`，同样注入备份环境、实例和 RAM 授权：

```
sentry-pgbackrest restore --pg1-path=/restore/验收库 --type=time --target='指定 UTC 时间' --target-action=promote
```

恢复后以 `PGDATA=/restore/验收库`、`archive_mode=off` 在隔离端口启动。必须等待目标时间回放成功，再核对账号、提交/作废状态、汇总和业务入口。缺失 WAL、授权失败或没有到达目标时间都不能当作成功；不使用跳过校验选项。恢复后原 Excel 不在备份中，待解析任务会明确失败要求重新上传；过期暂存由工作进程清理。

`npm run test:recovery` 在本机临时容器上验证实际业务发布→基础备份→作废→WAL 归档→恢复到作废前；结束只销毁本轮随机命名资源。此测试使用本地备份仓库，不冒充 OSS 验证，也不代表生产 RPO/RTO。

## 日志与状态

每个常驻服务 Docker JSON 日志 10 MiB × 3，四服务预算约 120 MiB，迁移另 30 MiB。请求日志只含方法、路径（不含查询参数）、请求标识、状态和耗时；任务日志含批次、阶段、尝试次数和耗时，不打印请求正文、Cookie、密码或检测明细。PG 不打印语句及错误参数。

检查：`/api/health` 验证数据库；worker 容器健康检查验证 90 秒内心跳；`sentry-pgbackrest info --output=json` 查询最近备份，`check` 强制验证归档；PG 的 `pg_stat_archiver` 提供成功/失败数、最后成功和失败时间。调度每 5 分钟记录备份状态及磁盘余量，低于 5 GiB 标记。归档失败不能通过清理 WAL 来“解决”，先暂停上传、修复归档并核对恢复链。本轮不接外部告警。

## 正式切换门槛与回退

1. 先完成同版本隔离浏览器验收、真实 OSS 备份与指定时间恢复核对，记录全流程耗时及 WAL 延迟。未完成不切换。
2. 维护窗口暂停 Nginx 管理端写请求，停止旧应用，备份旧镜像、配置、旧库及 WAL；离线确认无写入后做最终一致性快照。
3. 启动新 PG，迁移到空库，核对统计、原账号、暂存任务及历史。数据库仍维护，只读检查。
4. 配置现有域名代理到新应用，检查 `/`、`/admin/login`、身份识别、地图。OSS check 与首次完整备份通过后，才执行 `npm run db:maintenance -- off` 并解除 Nginx 写入维护。
5. 新库尚无新写入时，可关闭新应用并还原旧镜像、配置和旧库。开放写入后禁止直接退回 SQLite：先冻结新写入，保全 PG 数据与 WAL，优先修复或用新库回退兼容应用；若必须回迁，需另行核对新写入迁移方案。
6. 留下时间、版本、备份位置及验收报告；密码不进入报告。无压测时明确容量及 P95 未验证；同机故障域、RPO 15 分钟和 RTO 1 小时仍是待演练的目标。
