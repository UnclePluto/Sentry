# 双 Sheet 样本统计实施记录

日期：2026-09-21

分支：`codex/sample-pathogen-model`
隔离工作区：`/private/tmp/Sentry-sample-pathogen-model`

## 已实现范围

- PostgreSQL 版本 2 事实模型：上传检测范围、样本、阳性明细、阳性组合和可重建汇总；版本 1 结构与校验和保持不变。
- 双工作表解析：N 保留为全阴性样本，多病原体阳性按样本聚合，限制 Sheet1 30,000 行、Sheet2 1,000 行。
- 方案 A 查询：检测范围与所选病原体有交集的上传进入分母，任一所选病原体阳性的样本进入分子，多病原体不重复计样本。
- 管理端预览/历史、格式 2 演示数据、病原体多选、大盘样本文案及扩大后的时空热力图。
- 旧真实数据就绪保护、只读预检 CLI、旧 SQLite 统计核对与待确认任务取消策略。

## 自动化验证

| 命令 | 结果 |
| --- | --- |
| `TEST_DATABASE_URL=… npm test` | 通过：52 项中 51 通过、0 失败、1 跳过；跳过项是未配置 `SENTRY_FIXTURE_FILE` 的真实附件用例。总耗时约 22.1 秒。 |
| `node --test … tests/migration.test.mjs tests/sample-readiness.test.mjs` | 通过：8/8，覆盖空旧库、仅旧演示、旧真实作废/发布、旧待确认/过期、校验和、空格式 2 事实表和重复迁移拒绝覆盖。 |
| `npm run typecheck` | 通过。 |
| `npm run build` | 通过；仅有既有的大于 500 kB chunk 提示。 |
| `DATABASE_URL=… node scripts/postgres/check-sample-model.mjs` | 隔离 smoke 库通过，输出 `{"ready":true,"publishedLegacy":0,"unfinishedLegacy":0}` 并退出 0。 |
| 本功能文件定向 `oxlint` | 通过，无错误或警告。 |
| `npm run lint` | 未通过。剩余错误均位于本功能未修改的既有文件：4 个浏览器回归脚本表达式、登录页 autofocus/FormEvent、管理员导航原生链接/FormEvent、账号页状态标签/FormEvent、gateway 模板类型、4 个旧测试缺少 `void`，以及地图刷新脚本的未绑定方法。React Compiler 仍给出既有建议警告。 |
| `SENTRY_ORIGIN=http://127.0.0.1:3500 SENTRY_ADMIN_ORIGIN=http://127.0.0.1:3502 npm run test:smoke` | 通过；页面、健康检查、真实/演示大盘、三级地图、双入口隔离、前端资源和重复病原体参数的新样本字段均正常。 |

所有数据库测试使用一次性本地 PostgreSQL 容器 `codex-sentry-sample-test-pg` 的隔离数据库，没有读取或写入生产连接。

## 浏览器验收

- 1366×768、1920×1080：趋势模块不存在，右侧“病原体时空分布”占满右栏；1920×1080 时面板高度 867px。
- 390×844：`scrollWidth=clientWidth=390`，页面没有整体横向溢出；病原体弹层宽 320px，12 个选项的列表 `clientHeight=360`、`scrollHeight=456`，第 12 项可滚动并切换。
- 键盘：Space 可切换 IAV/RSV，Escape 关闭并把焦点还给触发器；排行取消 RSV 后 IAV 保持选中。
- 12 病原体：排行渲染 12 行；补注册 ECharts `DataZoomComponent` 后控制台不再报缺失组件。
- 桌面截图：[dashboard-1920x1080.png](dashboard-1920x1080.png)。390×844 验收使用 CUA 实际视口并在会话中目视确认，未持久化截图。

## 迁移与上线状态

- 已编写并测试迁移工具、只读就绪检查和[切换手册](migration-runbook.md)。
- 自动审批拒绝了迁移时永久删除旧 staged payload。最终实现将批次和任务改为 `cancelled`、禁止发布并显示“旧格式预览请重新上传”，同时保留 payload 作为审计与人工恢复材料；旧 SQLite 私有快照也保留。
- 没有提供真实历史原文件、生产授权、生产维护窗口或实际生产数据盘点，因此未执行生产迁移、历史替代上传、生产预检或线上切换。
- 新版接受真实格式 2 写入后不能直接回退旧应用；必须保护新事实与审计，再按已演练方案恢复或前向修复。
- 未执行容量压测、千万级造数或并发性能基准；只验证了 Sheet1 30,000 样本边界、事务一致性、并发作废和任务租约行为。
