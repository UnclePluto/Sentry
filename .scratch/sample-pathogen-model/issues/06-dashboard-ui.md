# 06：多选病原体、总览文案与时空图扩展

Status: complete

依据：[规格](../spec.md) 第 6 节及[计划公共接口](../plan.md)。依赖：04、05。

**文件：**新增 `components/pathogen-picker.tsx`、`lib/dashboard-query.ts`；修改 `app/page.tsx`、`app/dashboard.css`、`components/map-view.tsx`、`components/chart.tsx`。复用已安装 Popover、Checkbox/Button 等基础组件，不改造所有单选 Picker。

**接口：**`PathogenPicker({value,onChange,options,disabled})`，value/string[]，onChange/(string[])=>void，options/{code,name}[]；`normalizePathogens(values:string[]):string[]`；`dashboardQuery({demo,region,from?,to?,pathogens}):string`；`pathogenScope(values:string[]):string`。仅病原体筛选使用新多选组件，数据来源 Picker 仍单选。

- [x] 在本地受控数据下记录当前失败场景：无法同时选择 IAV/RSV；总览仍显示试剂与提交批次；右侧保留趋势图且热力图只取前 8 项。UI 低影响文案/布局不新增镜像式单元测试，交互以实际浏览器验收。
- [x] 建立公共集合与 URL 工具，三个 dashboard 请求入口（overview、当前日期、下钻预取）都调用它，避免各自编码漏项：

```ts
export const normalizePathogens = (values: string[]) =>
  [...new Set(values.map(v=>v.trim()).filter(Boolean))].sort();
export const pathogenScope = (values: string[]) => JSON.stringify(normalizePathogens(values));
export function dashboardQuery(input: {demo:boolean;region:string;from?:string;to?:string;pathogens:string[]}) {
  const query = new URLSearchParams({demo:input.demo?'1':'0',region:input.region});
  if (input.from) query.set('from',input.from);
  if (input.to) query.set('to',input.to);
  for (const code of normalizePathogens(input.pathogens)) query.append('pathogen',code);
  return query.toString();
}
```

- [x] 将 pathogen 标量替换为 string[]；排行按钮切换单个成员，保留其他项，清空等价全部。选项来自 pathogenOptions，保留有检测但零阳性的项；已选项暂不在当前地区选项中时仍显示可取消项，不悄悄清空用户选择。切换演示/真实来源时沿用当前重置流程并明确清空选择。

```tsx
const togglePathogen = (code: string) => setPathogens(current =>
  normalizePathogens(current.includes(code)
    ? current.filter(value=>value!==code)
    : [...current,code])
);
```

- [x] 新控件使用可聚焦的触发按钮、带中文名称的复选项、已选数量与清空按钮；Escape 关闭且焦点回触发器，Space 切换复选框；长名单可滚动、不挤占地图。复用基础控件的键盘语义，不自己模拟 div checkbox。
- [x] 所有 useEffect 依赖、AbortController、地图 motionScope、navigationRequest 和预取匹配条件使用稳定的规范化集合 key。筛选变化时取消正在进行的下钻请求并清理其准备状态；旧响应即使在取消前完成也必须用请求身份检查阻止覆盖新数据。
- [x] 总览读取 metrics.samples、positive、regions、pathogens；“监测区域”不能读取 submissions。比率使用 rate，分母零显示“—”；说明为所选病原体任一阳性样本数/检测过任一所选病原体的样本数。excludedNoSelectedTest>0 时显示真实排除数量。
- [x] 更新排行、热力图 tooltip、地图 tooltip、图例和辅助标签中的试剂词汇为样本。保留“整份 N”为阴性的概念，当前筛选 notDetected 显示“所选病原体未检出”，不显示为所有选项已检测阴性。
- [x] 删除 trend-hud JSX、专用 trend useMemo 及图例；保留供热力图月份使用的 chartData.trend 和地图时间播放。删除只取前 8 项的 slice，热力图使用全部检测项；行多时垂直 dataZoom/滚动，空检测项用 null、测过但零检出用 0：

```ts
const item = chartData?.heatmap.find(v=>v.code===rank.code && v.month===month);
const count = item && item.tested>0 ? item.count : null;
```

具体 series 在 null 时跳过色值绘制、tooltip 显示“未检测”，不能把 null 转成 0。全 N 文件也有 rank/月份数据，图表显示测过但零检出的状态。
- [x] 删除 `.trend-hud` 专用高度，右侧 `.temporal-hud` 使用已有 flex 布局占满可用高度。桌面保持标题、色阶和底部说明；窄屏沿用适合阅读的固定最小高度，长病原体名称不覆盖地图或图例。
- [x] 执行 `npm run typecheck`、`npm run lint`、`npm run build`。启动隔离本地应用后进行浏览器验收，记录具体视口和结果：

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 方案 A | 票 04 的 6 样本数据选择 IAV+RSV | 2/5，排除 1，取消 RSV 后仍保留 IAV |
| 零阳性 | 只含 N 的文件选择 panel 中病毒 | 样本>0、0%、选项仍存在、热力图为 0 |
| 请求交错 | 网络降速，选择 IAV 后立即加 RSV 并下钻/返回 | 最终所有请求与显示均包含两项，无旧结果回灌 |
| 地区数 | 同一区域多次提交、全阴性地区、仅到市提交 | 去重计区域，区县视图排除仅到市 |
| 桌面 | 1920×1080 和 1366×768 | 趋势模块消失、右侧热力图填满且标题图例可见 |
| 窄屏 | 390×844 | 页面无整体横向溢出，选择器与长列表可操作 |
| 多病原体 | 12 种有检测项，滚动热力图 | 第 9–12 项可访问，名称与单元格对应 |
| 键盘 | Tab/Space/Escape 切换多选 | 选择正确、焦点可见、关闭后焦点返回 |

- [x] 实施时只提交本票文件，中文说明“支持病原体多选并调整样本统计大盘布局”。

验收记录：方案 A 的 2/5、排除 1 与零阳性场景由票 04 的 PostgreSQL 集成测试覆盖；实际浏览器在 1366×768、1920×1080、390×844 验证。桌面端右侧时空图高度 867px，趋势模块不存在；窄屏页面 `scrollWidth=clientWidth=390`，多选弹层 12 项、列表 `scrollHeight=456`/`clientHeight=360`，第 12 项可滚动并切换。IAV/RSV 可用 Space 叠加选择、Escape 关闭并回焦，排行取消 RSV 后仍保留 IAV。12 项排行全部渲染，补注册 ECharts `DataZoomComponent` 后控制台无图表组件错误。`npm run typecheck`、`npm run build` 与本票定向 oxlint 通过；全仓 lint 的历史问题交由票 07 统一处理。
