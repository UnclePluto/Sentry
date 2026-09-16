---
status: accepted
---

# 生产主数据库采用 PostgreSQL

用户已确认生产主数据库采用 PostgreSQL，不采用 SQLite，也不引入 MongoDB。上传批次、试剂、病原体结果和账号的关系明确，重复约束及整批作废要求数据与统计一致，因此选择关系模型。此确认仅确定主数据库选型；仍处于架构讨论阶段，不代表授权继续实施或切换线上。

后续已确认大盘读取统计汇总、首阶段累计 1,000 万条设计目标及现有 ECS 共用部署，详见生产需求记录与后续决策。

Redis 已在后续决策中明确为首版不引入，参见 ADR 0002；缓存不承担唯一业务数据来源。MongoDB 支持事务，未推荐它并非因为缺乏事务，而是当前数据关系与统计需求更适合关系模型。

参考：[PostgreSQL 事务](https://www.postgresql.org/docs/current/tutorial-transactions.html)、[MongoDB 数据一致性](https://www.mongodb.com/docs/manual/data-modeling/data-consistency/)、[Redis 缓存失效](https://redis.io/docs/latest/develop/reference/client-side-caching/)。
