# 07：历史切换保护、工具兼容与整体验收

Status: planned

依据：[规格](../spec.md) 第 7–9 节及[计划全局约束](../plan.md)。依赖：01–06。

**文件：**新增 `server/sample-model-readiness.mjs`、`scripts/postgres/check-sample-model.mjs`、`tests/sample-readiness.test.mjs`、`.scratch/sample-pathogen-model/migration-runbook.md`、`.scratch/sample-pathogen-model/implementation-report.md`；修改 `server/dashboard.mjs`、`scripts/postgres/import-sqlite.mjs`、`tests/migration.test.mjs`、`scripts/smoke.mjs`。README 只追加本功能所需的模板与统计说明，保留用户已有修改；本票不改生产连接、部署配置或已有发布文件。

**接口：**`checkSampleModelReadiness(db): Promise<{ready:boolean,publishedLegacy:number,unfinishedLegacy:number}>`，只读、真实数据、独立于日期/地区筛选；CLI 返回相同汇总，ready 时退出 0，否则退出 2，不输出连接字符串或样本明细。票 04 的 `readLegacyDashboard(tx, filters)` 仅供旧 SQLite 核对工具使用。

- [ ] 先写旧真实已发布数据的保护测试，不允许新 dashboard 静默把它过滤后返回 0。用票 01 databaseFixture 创建版本 2 库，并插入旧格式 published 行：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture } from './helpers/database.mjs';
import { checkSampleModelReadiness } from '../server/sample-model-readiness.mjs';
test('旧真实数据阻止新口径就绪，作废后可通过', async t => {
  const db = await databaseFixture(t);
  await db.exec("INSERT INTO imports(id,file_name,sha256,province_code,province,city_code,city,submitted_name,report_date,created_at,status,format_version) VALUES('legacy','old.xlsx','h','420000','湖北省','420100','武汉市','旧上传','2026-09-01',now(),'published',1)");
  assert.deepEqual(await checkSampleModelReadiness(db),{ready:false,publishedLegacy:1,unfinishedLegacy:0});
  await db.exec("UPDATE imports SET status='withdrawn' WHERE id='legacy'");
  assert.deepEqual(await checkSampleModelReadiness(db),{ready:true,publishedLegacy:0,unfinishedLegacy:0});
});
```

- [ ] 运行 `node --test tests/sample-readiness.test.mjs`，确认保护尚未实现时失败。
- [ ] 实现只读检查，unfinishedLegacy 统计 format_version=1、demo=0、status='staged' 的上传，不因缺少 job 而漏掉。已过期、取消、作废不是未完成。SQL 聚合只返回计数：

```sql
SELECT count(*) FILTER(WHERE status='published')::bigint AS published,
       count(*) FILTER(WHERE status='staged')::bigint AS unfinished
FROM imports WHERE format_version=1 AND demo=0;
```

- [ ] 新真实大盘在相同只读快照里执行检查，发现未处理旧真实数据/任务时返回 503 和“历史检测数据尚未完成新口径核对，暂不能展示新版统计”。不暴露管理明细，也不因选择某日期而绕过。管理登录、历史、作废和新上传仍可用，以便处理替代数据；演示查询不受旧真实数据阻塞。线上应先完成 runbook 的维护窗口核对再部署启用，503 是误切换保护，不是计划让用户长期看到的正常状态。
- [ ] 编写 CLI：只连接显式配置库、调用检查、输出汇总后关闭；不调用 migrate、maintenance 或更新状态。验证退出状态和统计内容，禁止运行到线上库。

```js
const report = await checkSampleModelReadiness(db);
console.log(JSON.stringify(report));
process.exitCode = report.ready ? 0 : 2;
```

- [ ] 旧 SQLite 导入工具继续复制历史 format_version=1，不伪造 Sheet2。导入后的对比调用 `db.transaction(tx => readLegacyDashboard(tx, filter), {readOnly:true})`；保留旧报表字段及归属不明作废规则。旧有效待确认 payload 改为 cancelled 并清理暂存、保留任务摘要说明“旧格式预览请重新上传”，不能创建可被新版确认的 ready 任务；原本 expired 记录仍保持 expired。旧真实 published 数据保留且预检不通过，直到完成业务替代。
- [ ] 增加迁移用例：源库无真实数据、仅旧 demo、旧真实已作废、旧真实仍发布、旧 ready payload；核对账号/历史摘要、旧结果数、版本 1 校验和、格式 2 空表、就绪结果。运行旧迁移两次仍按既有防覆盖规则拒绝非空目标，不自动清空。
- [ ] 编写 migration-runbook，按下列确定步骤形成可执行清单：盘点已发布旧批次与旧任务 → 在隔离副本演练备份恢复及版本升级 → 准备含完整 N 样本和 Sheet2 的替代文件及旧新上传对应记录 → 进入约定维护窗口、停止旧工作进程并排空/取消旧任务 → 应用新结构和新版服务，展示入口保持暂停，仅保留受控管理入口 → 解除数据库写入维护，允许管理员通过新版任务流程逐批导入替代文件、核对后作废对应旧批次 → 重建全部贡献并逐样本核对 → 运行只读预检为 ready → 验证大盘、权限、恢复路径 → 恢复展示与正常管理访问。maintenance=true 会阻止工作进程领取任务，不能在该状态下等待重导入完成。文件缺失时停在数据准备阶段，不自动删旧数据或猜测阴性数。
- [ ] 文档明确：新版已经接受真实写入后不可直接退回旧应用；必须保护新事实与审计再执行经演练的回退。历史原文件、生产授权和实际维护窗口是否具备写入实施报告，不把本地代码完成等同于生产切换。
- [ ] smoke 增加重复病原体参数与新字段检查，使用演示返回的有效选项生成 URL，避免硬编码当前真实数据库未包含的病毒代码：

```js
const demo = await (await fetch(origin+'/api/dashboard?demo=1')).json();
const query = new URLSearchParams({demo:'1'});
for (const p of demo.pathogenOptions.slice(0,2)) query.append('pathogen',p.code);
const response = await fetch(origin+'/api/dashboard?'+query);
assert.equal(response.status,200);
const data = await response.json();
assert.ok(data.metrics.positive<=data.metrics.samples);
assert.equal(data.metrics.notDetected,data.metrics.samples-data.metrics.positive);
assert.ok(Number.isInteger(data.metrics.regions));
```

- [ ] 在隔离数据库运行完整 `npm test`；运行 `npm run typecheck`、`npm run lint`、`npm run build`；对隔离本地服务运行 `npm run test:smoke`。只对失败、改动或未决风险重跑相关验证；不把真实样表缺失的跳过用例写成通过，不执行容量压测。
- [ ] 根据用户选定的执行方式完成独立代码审查，重点检查样本去重、零分母、旧版本保护、事务回滚、多选请求交错和用户已有修改保留情况，修复有证据的问题后验证。
- [ ] 写 implementation-report，逐条列实际通过/失败/跳过的命令、浏览器验收视口及截图路径、真实样表状态、历史数据补齐状态、性能尚未验证和是否执行上线。此文档只记录真实结果，不预填“全部通过”。
- [ ] 实施时选择性提交本票文件，中文说明“增加历史口径切换保护并完成样本统计验收”。不得把用户既有部署修改一起提交。
