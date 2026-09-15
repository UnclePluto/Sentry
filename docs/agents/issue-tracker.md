# Issue 跟踪方式：本地 Markdown

用户已确认本项目使用本地 Markdown 管理规格与实施任务，不向远程服务发布。

## 约定

- 一个功能对应一个目录：`.scratch/<feature-slug>/`。
- 规格保存为 `.scratch/<feature-slug>/spec.md`。
- 后续需要拆分实施任务时，每个任务单独保存到 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号，不合并为一个任务文件。
- 状态写在文档顶部的 `Status:` 行；to-spec 正式完成的规格使用 `ready-for-agent`，表示可供后续实现使用，不表示已经实现。
- 技能要求“发布到 Issue 跟踪系统”时，创建或更新上述本地文件，并向用户提供可点击的文件链接。
- 评论和后续讨论需要留档时，附加在对应文件的 `## Comments` 部分。
- 不因编写规格而创建远程仓库、提交代码或启动实现。

## 当前规格

- [Excel 提交、统计口径与历史管理重构](../../.scratch/excel-submission-rules/spec.md)
