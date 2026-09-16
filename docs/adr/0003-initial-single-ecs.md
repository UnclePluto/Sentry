---
status: accepted
---

# 首阶段应用与 PostgreSQL 共用现有 ECS

用户选择先在现有 2 核 2 GB ECS 同时运行应用、后台工作进程和 PostgreSQL，暂不采用 RDS 或独立数据库 ECS，以控制新增资源成本。代价是资源竞争及单机故障风险；累计千万条容量、RPO ≤ 15 分钟、RTO ≤ 1 小时均是待实测验收的目标，不能因部署完成就宣称达标。

备份不得仅保存在该 ECS；异机备份已确认使用上海 OSS 私有 Bucket 的 Sentry 专用前缀，访问授权和恢复所需替代运行资源仍待落实。架构需保留将 PostgreSQL 或工作进程独立部署的路径。
