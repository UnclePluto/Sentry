# 双 Sheet 与样本统计方案 A 实施计划

> **面向执行代理：**实施时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，按任务推进并勾选步骤；执行方式由用户审阅本计划后选择。本轮仅制定计划，不启动实现或代理。

Status: pending-plan-review

**目标：**完成双 Sheet 导入、按样本去重的方案 A 统计、多选病原体与大盘布局调整。

**架构：**以上传检测范围、样本、阳性明细为事实数据；按上传保存总体/单病原体指标与实际阳性组合汇总。以检测范围交集确定多选分母，以阳性集合交集确定分子；后台发布原子生成事实与汇总，前台只读取汇总。

**技术栈：**现有 Node.js ≥ 22.13.0、PostgreSQL/pg、ExcelJS、React/TypeScript、ECharts、Vinext；不增加运行时依赖。

**规格：**[已确认方向及完整设计](spec.md)。执行每项任务前同时阅读规格、本计划公共契约和对应任务文件。

## 全局约束

- 单次上传内 sam 唯一；同 sam 的 batch 必须一致；不同上传独立累计，不按 sam 跨上传合并。
- Sheet2 对本文件所有样本声明同一个检测范围；不同上传可以不同。至少检测一种所选病原体才纳入分母，任一所选病原体检出即计一个阳性样本。
- N 为全阴性样本，不剔除；具体代码行的 CT 可为空、`-`、`—` 或有限数值，非所选病原体检出不改变当前筛选的分子。
- Sheet1 最多 30,000 条非空数据行，Sheet2 最多 1,000 条非空数据行；标识和名称最多 200 字符。沿用 8 MiB 文件限制、96 MiB ZIP 声明解压总量、192 MiB 解析线程堆限制与 25 秒解析超时。
- 待确认结构化数据保留 7 天；原 Excel 仅临时保存，异常遗留最长 24 小时；正式事实与历史审计长期保留。
- 沿用登录权限、任务租约、写入协调、幂等发布、整批作废、演示/真实隔离，以及市级数据在区县视图排除的规则。
- `server/schema.sql` 是已应用的版本 1，SHA-256 为 `e280af173242b3c7931123eadb77c3bca2559d997926a9705cf1d1c1b9be0192`，禁止改写。
- 集成测试仅使用显式配置的隔离 `TEST_DATABASE_URL`，不读取或操作线上库。缺失测试环境时记录阻塞，不借用生产连接。
- 本轮不做千万条造数、并发压测、自动扩容、生产迁移或线上切换。真实历史数据补齐与恢复条件是上线前置要求。
- 使用中文界面文案、中文任务记录和中文提交说明。用户已有的 README、部署文档修改必须保留；不能在提交时顺带包含它们。
- 任务中的提交步骤只在实施阶段执行，按当前任务文件选择性暂存；文档制定阶段不提交。实施启动时依技能检查是否需要隔离工作区。

## 审查重点

这五项容易被常规成功路径遗漏，分别在指定任务加入明确用例：

1. **数字形式 sam 与文本前导零**：文本 `001` 保留；不能把数字单元格自动补成推测编号；同文件规范化后重复按错误处理。任务 02。
2. **解析后字典被另一上传改变**：确认时重新校验同代码名称，冲突必须整笔回滚而不是污染已有名称。任务 03。
3. **只有检测范围、没有任何阳性**：预览和发布成功，单病原体零分子仍有分母，选项和时间轴不能消失。任务 04。
4. **多选、月份与地区下钻快速交错**：旧请求不能覆盖新集合；返回上一层也保留全部选中项。任务 06。
5. **升级库存在旧同名 sam、旧暂存任务或旧演示数据**：结构迁移不丢数据，新发布器拒绝旧 payload；新统计不悄悄混入或排除未处理真实历史。任务 01、03、05、07。

## 文件职责与共享接口

| 文件 | 职责 |
| --- | --- |
| `server/migrations/002-sample-pathogen-model.sql`、`server/database.mjs` | 追加版本 2 迁移、校验升级与空库初始化 |
| `server/parser.mjs` | 解析两个 Sheet，产生下述 PayloadV2；保持纯文件解析边界 |
| `server/sample-import.mjs` | 校验结构化 payload、数据库名称冲突，批量写入格式 2 事实 |
| `server/sample-metrics.mjs` | 重建格式 2 单项/组合汇总，验证跨表不变量 |
| `server/dashboard.mjs` | 方案 A 汇总查询、地区/日期统计与热力图 |
| `server/legacy-dashboard.mjs` | 保存原查询行为，仅用于历史迁移核对，不暴露新 HTTP 选项 |
| `server/store.mjs` | 保持既有导出，协调发布、作废、版本分派和重建事务 |
| `server/index.mjs`、`server/jobs.mjs`、`server/worker.mjs` | 重复筛选参数、版本化任务与预览传递 |
| `server/sample-model-readiness.mjs`、`scripts/postgres/check-sample-model.mjs` | 只读检查旧真实批次及旧未结束任务，生成切换前报告 |
| `lib/models.ts`、`lib/dashboard-query.ts`、`components/pathogen-picker.tsx` | 前端类型、集合 URL/请求标识、多选控件 |
| `app/page.tsx`、`app/dashboard.css`、`components/map-view.tsx` | 统计口径、文案与右侧图表布局 |
| `app/upload/page.tsx`、`server/demo.mjs` | 双 Sheet 上传说明、版本化历史、格式 2 演示生成 |
| `tests/helpers/database.mjs`、`tests/helpers/workbook-v2.mjs` | 临时 PostgreSQL 版本夹具、显式检测面板的 Excel 夹具 |

PayloadV2（字段名称是各任务间的契约）：

```ts
type PayloadV2 = {
  formatVersion: 2;
  sheet: 'Sheet1';
  sheets: ['Sheet1', 'Sheet2'];
  panel: { code: string; name: string; rawName: string; sourceRow: number }[];
  samples: {
    sample: string; batch: string;
    resultKind: 'all_negative' | 'has_positive'; sourceRow: number;
  }[];
  detections: {
    sample: string; code: string; ct: number | null;
    raw: string; name: string; sourceRow: number;
  }[];
  names: Record<string, string>;
  warnings: string[];
  summary: {
    rows: number; samples: number; tested: number;
    positive: number; negative: number; untested: 0;
    rate: number | null; batches: number; excluded: 0;
    testedPathogens: number; detectedPathogens: number;
    pathogens: number;
  };
};
```

summary.pathogens 暂保留为 detectedPathogens 的兼容别名；预览和历史显式使用两个新病原体字段。summary.negative 是整份文件的全阴性数；大盘的 notDetected 才是当前筛选下未命中的数量，不混用。

```ts
type DashboardFilters = {
  demo?: boolean; from?: string; to?: string; region?: string;
  pathogens?: string[];
};
type DashboardMetrics = {
  samples: number; tested: number; positive: number; notDetected: number;
  untested: 0; rate: number | null; excludedNoSelectedTest: number;
  submissions: number; pathogens: number; regions: number;
};
```

`dashboard(db, filters): Promise<DashboardData>` 仍从 store 导出，委托 `readDashboard(tx, filters)`；后者在既有只读一致性事务内执行。`rebuildSampleMetrics(tx, importId): Promise<void>` 与 `writeSampleImport(tx, importId, payload): Promise<void>` 都使用调用者事务，不另开连接或提交。

## 任务与依赖

| 任务 | 交付 | 依赖 |
| --- | --- | --- |
| [01](issues/01-versioned-schema.md) | 新版本表结构与数据库约束 | 无 |
| [02](issues/02-dual-sheet-parser.md) | 双 Sheet 解析、样本聚合与错误契约 | 无 |
| [03](issues/03-publish-and-metrics.md) | 原子发布、任务版本、汇总及重建 | 01、02 |
| [04](issues/04-dashboard-query.md) | 方案 A 查询、多选接口、地区与月份统计 | 03 |
| [05](issues/05-upload-demo-compatibility.md) | 上传/历史文案、演示与既有夹具升级 | 03、04 |
| [06](issues/06-dashboard-ui.md) | 多选交互、总览文案、时空图扩展 | 04、05 |
| [07](issues/07-readiness-and-acceptance.md) | 历史切换保护、迁移工具适配与整体验收 | 01–06 |

默认实施顺序 01 → 02 → 03 → 04 → 05 → 06 → 07。依赖说明不授权启动代理。前期逐项运行对应测试；05 更新旧夹具后运行完整现有回归，不把尚依赖旧格式的测试误当已通过。

## 规格覆盖

| 规格章节 | 对应任务 |
| --- | --- |
| 1–3：身份、事实、汇总、约束与索引 | 01、02、03 |
| 4：两个 Sheet、校验、文件和任务生命周期 | 02、03、05 |
| 5：方案 A、分子分母、地区、月份与零值 | 03、04、06 |
| 6：HTTP、上传说明、地图多选及布局 | 04、05、06 |
| 7：新迁移、旧事实保留、旧任务和上线条件 | 01、03、05、07 |
| 8–9：模块职责、回归、并发与验收 | 各票及 07 |

## 执行与交付

- [ ] 用户审阅计划并选择执行方式。
- [ ] 按各任务文件完成对应测试循环和验收记录。
- [ ] 完成整体验收及一次独立代码审查，处理实际缺陷后再报告结果。
- [ ] 在 `.scratch/sample-pathogen-model/implementation-report.md` 记录实际执行命令、结果、跳过项、历史数据状态与上线限制。

建议选择**当前会话由主代理顺序实施，最后统一独立审查**：任务共享 payload、数据库和统计类型契约，顺序推进可减少交接成本。也可选择每项任务分别由实现与审查代理处理；计划尚未采用任何一种执行方式。
